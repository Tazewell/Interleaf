package scholar

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	nethtml "golang.org/x/net/html"
)

type PublicConfig struct {
	LookupIP    func(context.Context, string) ([]net.IP, error)
	DialContext func(context.Context, string, string) (net.Conn, error)
	Proxy       func(*http.Request) (*url.URL, error)
	TLSConfig   *tls.Config
	Clock       Clock
	Limiter     *SourceLimiter
}
type PublicResource struct {
	// FinalURL is safe for public display: query and fragment are omitted.
	FinalURL, ContentType string
	Bytes                 []byte
	Hash, FetchedAt       string
	// One-based sanitized paragraphs proven to belong to a readable article body.
	BodyParagraphs map[int]bool
}

// Keep operational URL parameters inside transport/registration only. Public
// sources never expose query values or fragments, including unknown signature
// names. The safe display URL is not a replay credential for the download.
func PublicDisplayURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Hostname() == "" || u.Opaque != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	u.RawQuery, u.Fragment, u.RawFragment, u.ForceQuery = "", "", "", false
	return u.String()
}

// Preserve the underlying error for retry/cancel/TLS classification, while
// never formatting a request URL, proxy address or resolver message outward.
type publicNetworkError struct{ cause error }

func (e publicNetworkError) Error() string { return "公开资料网络请求失败" }
func (e publicNetworkError) Unwrap() error { return e.cause }

func (c *Client) publicConfig() PublicConfig {
	p := PublicConfig{}
	if c.Public != nil {
		p = *c.Public
	}
	if p.LookupIP == nil {
		p.LookupIP = func(ctx context.Context, host string) ([]net.IP, error) {
			return net.DefaultResolver.LookupIP(ctx, "ip", host)
		}
	}
	if p.DialContext == nil {
		p.DialContext = (&net.Dialer{Timeout: 30 * time.Second}).DialContext
	}
	if p.Proxy == nil {
		p.Proxy = http.ProxyFromEnvironment
	}
	if p.Clock == nil {
		p.Clock = wallClock{}
	}
	if p.Limiter == nil {
		p.Limiter = globalSourceLimiter
	}
	return p
}
func publicHash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

var blockedPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2001::/23"), netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"), netip.MustParsePrefix("::/96"),
}

func isPublicIP(ip net.IP) bool {
	a, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	a = a.Unmap()
	if !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return false
	}
	for _, p := range blockedPublicPrefixes {
		if p.Contains(a) {
			return false
		}
	}
	return true
}
func publicHostname(u *url.URL) string { return strings.TrimSuffix(strings.ToLower(u.Hostname()), ".") }

func publicURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 4096 || u.Hostname() == "" || u.User != nil || u.Opaque != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, Error{"公开资料链接必须是无用户凭据的 HTTP(S) 地址"}
	}
	host := publicHostname(u)
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.Contains(host, "%") {
		return nil, Error{"不能访问本机或局域网地址"}
	}
	if ip := net.ParseIP(host); ip != nil && !isPublicIP(ip) {
		return nil, Error{"不能访问非公网地址"}
	}
	return u, nil
}
func publicSource(u *url.URL) string {
	h := publicHostname(u)
	if h == "arxiv.org" || strings.HasSuffix(h, ".arxiv.org") {
		return "arxiv"
	}
	if h == "api.crossref.org" {
		return "crossref"
	}
	return ""
}

// Each hop gets a fresh transport and one DNS resolution. The URL's authority
// is replaced by the validated numeric IP before net/http constructs either
// the direct dial, the HTTP proxy request-target or HTTPS CONNECT authority.
// Origin Host and TLS SNI/certificate verification retain the original host.
// Environment proxies are trusted user exits; they never resolve the target.
func (c *Client) publicHop(ctx context.Context, u *url.URL, accept string, limit int64, source, kind string, legacy bool) (PublicResource, int, http.Header, error) {
	p := c.publicConfig()
	release, err := p.Limiter.acquire(ctx, source)
	if err != nil {
		return PublicResource{}, 0, nil, err
	}
	defer release()
	if err = reservePublic(ctx); err != nil {
		return PublicResource{}, 0, nil, err
	}
	ips := []net.IP{net.ParseIP(u.Hostname())}
	if ips[0] == nil {
		ips, err = p.LookupIP(ctx, u.Hostname())
		if err != nil {
			return PublicResource{}, 0, nil, publicNetworkError{err}
		}
	}
	if len(ips) == 0 {
		return PublicResource{}, 0, nil, Error{"公开资料地址没有 IP"}
	}
	for _, ip := range ips {
		if !isPublicIP(ip) && !(legacy && c.AllowPrivateHosts) {
			return PublicResource{}, 0, nil, Error{"不能连接非公网地址"}
		}
	}
	original, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return PublicResource{}, 0, nil, publicNetworkError{err}
	}
	proxy, err := p.Proxy(original)
	if err != nil {
		return PublicResource{}, 0, nil, publicNetworkError{err}
	}
	if proxy != nil && ((proxy.Scheme != "http" && proxy.Scheme != "https") || proxy.Hostname() == "") {
		return PublicResource{}, 0, nil, Error{"该代理协议无法保证公开资料目标 IP 固定"}
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	pinned := *u
	pinned.Host = net.JoinHostPort(ips[0].String(), port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pinned.String(), nil)
	if err != nil {
		return PublicResource{}, 0, nil, publicNetworkError{err}
	}
	req.Host = u.Host
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", accept)
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if p.TLSConfig != nil {
		tlsConfig = p.TLSConfig.Clone()
	}
	tlsConfig.ServerName = u.Hostname()
	dial := p.DialContext
	if proxy != nil {
		dial = func(ctx context.Context, network, address string) (net.Conn, error) {
			return publicProxyTunnel(ctx, p, proxy, address)
		}
	}
	transport := &http.Transport{DialContext: dial, TLSClientConfig: tlsConfig, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 30 * time.Second, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return PublicResource{}, 0, nil, publicNetworkError{err}
	}
	defer res.Body.Close()
	p.Limiter.observe(source, res.Header)
	if res.StatusCode >= 300 && res.StatusCode <= 399 {
		return PublicResource{}, res.StatusCode, res.Header, nil
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return PublicResource{}, res.StatusCode, res.Header, nil
	}
	// net/http transparently decompresses gzip before this bound is applied.
	body, limit, contentType, err := publicDocumentBody(res.Body, res.Header.Get("Content-Type"), kind, limit)
	if err != nil {
		return PublicResource{}, 0, nil, err
	}
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		if ctx.Err() != nil {
			return PublicResource{}, 0, nil, ctx.Err()
		}
		return PublicResource{}, 0, nil, publicBodyError{err}
	}
	if int64(len(data)) > limit {
		return PublicResource{}, 0, nil, Error{"公开资料正文超过大小限制"}
	}
	return PublicResource{FinalURL: u.String(), ContentType: contentType, Bytes: data, Hash: publicHash(data), FetchedAt: p.Clock.Now().UTC().Format(time.RFC3339Nano)}, res.StatusCode, res.Header, nil
}

// Select a decoded-body cap before consuming the document. Generic/missing
// types permit only a bounded positive HTML/PDF sniff, never arbitrary text.
// The prefix is replayed into the same stream; no extra GET or decompression.
func publicDocumentBody(body io.Reader, declared, kind string, limit int64) (io.Reader, int64, string, error) {
	if kind != "html" && kind != "pdf" && kind != "document" {
		return body, limit, declared, nil
	}
	media := ""
	if declared != "" {
		var err error
		media, _, err = mime.ParseMediaType(declared)
		if err != nil {
			return nil, 0, "", Error{"公开资料响应类型无效"}
		}
	}
	switch media {
	case "text/html", "application/xhtml+xml":
		if kind == "pdf" {
			return nil, 0, "", Error{"链接打开的不是 PDF"}
		}
		return body, 4 << 20, media, nil
	case "application/pdf", "", "application/octet-stream", "text/plain":
	default:
		return nil, 0, "", Error{"公开资料响应不是 HTML 或 PDF"}
	}
	prefixSize := int64(512)
	if media == "application/pdf" {
		prefixSize = 5
	}
	prefix, err := io.ReadAll(io.LimitReader(body, prefixSize))
	if err != nil {
		return nil, 0, "", publicBodyError{err}
	}
	isPDF := bytes.HasPrefix(prefix, []byte("%PDF-"))
	if isPDF && kind != "html" {
		return io.MultiReader(bytes.NewReader(prefix), body), 64 << 20, "application/pdf", nil
	}
	if media == "application/pdf" || kind == "pdf" {
		return nil, 0, "", Error{"链接打开的不是 PDF"}
	}
	if !strings.HasPrefix(http.DetectContentType(prefix), "text/html") {
		return nil, 0, "", Error{"公开资料响应不是可识别的 HTML"}
	}
	return io.MultiReader(bytes.NewReader(prefix), body), 4 << 20, "text/html", nil
}

type publicBufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *publicBufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

// Tunnel both HTTP and HTTPS: net/http's ordinary WriteProxy uses req.Host
// for the absolute request-target, undoing IP pinning when preserving Host.
func publicProxyTunnel(ctx context.Context, p PublicConfig, proxy *url.URL, target string) (net.Conn, error) {
	port := proxy.Port()
	if port == "" {
		port = "80"
		if proxy.Scheme == "https" {
			port = "443"
		}
	}
	conn, err := p.DialContext(ctx, "tcp", net.JoinHostPort(proxy.Hostname(), port))
	if err != nil {
		return nil, err
	}
	baseConn := conn
	stop := context.AfterFunc(ctx, func() { baseConn.Close() })
	defer stop()
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	deadline := time.Now().Add(30 * time.Second)
	if at, yes := ctx.Deadline(); yes && at.Before(deadline) {
		deadline = at
	}
	conn.SetDeadline(deadline)
	if proxy.Scheme == "https" {
		cfg := &tls.Config{MinVersion: tls.VersionTLS12}
		if p.TLSConfig != nil {
			cfg = p.TLSConfig.Clone()
		}
		cfg.ServerName = proxy.Hostname()
		tlsConn := tls.Client(conn, cfg)
		if err = tlsConn.HandshakeContext(ctx); err != nil {
			return nil, fmt.Errorf("代理 TLS: %w", err)
		}
		conn = tlsConn
	}
	request := &http.Request{Method: http.MethodConnect, URL: &url.URL{Opaque: target}, Host: target, Header: make(http.Header)}
	if proxy.User != nil {
		password, _ := proxy.User.Password()
		request.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(proxy.User.Username()+":"+password)))
	}
	if err = request.Write(conn); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(io.LimitReader(conn, 32<<10))
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		return nil, fmt.Errorf("代理 CONNECT 未完成: %w", err)
	}
	if response.StatusCode != 200 {
		return nil, Error{fmt.Sprintf("代理不能建立固定公网 IP 隧道（%d）", response.StatusCode)}
	}
	// ReadResponse has consumed only CONNECT headers. Copy buffered bytes then
	// discard the header limit so it cannot cap the tunneled document body.
	buffered := make([]byte, reader.Buffered())
	_, _ = io.ReadFull(reader, buffered)
	conn.SetDeadline(time.Time{})
	ok = true
	return &publicBufferedConn{Conn: conn, reader: bufio.NewReader(io.MultiReader(bytes.NewReader(buffered), conn))}, nil
}

type publicBodyError struct{ err error }

func (e publicBodyError) Error() string { return "公开资料正文不完整" }
func (e publicBodyError) Unwrap() error { return e.err }

func safeGETRetry(err error) bool {
	var body publicBodyError
	var cert *tls.CertificateVerificationError
	var record tls.RecordHeaderError
	var unknown x509.UnknownAuthorityError
	if errors.As(err, &body) || errors.As(err, &cert) || errors.As(err, &record) || errors.As(err, &unknown) || errors.Is(err, io.ErrUnexpectedEOF) {
		return false
	}
	var op *net.OpError
	return errors.As(err, &op) && (op.Op == "dial" || op.Op == "read") && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)
}
func (c *Client) fetchPublic(ctx context.Context, raw, accept string, limit int64, source, kind string, legacy bool) (PublicResource, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	for redirects := 0; redirects <= 5; redirects++ {
		u, err := publicURL(raw)
		if legacy && c.AllowPrivateHosts {
			u, err = url.Parse(raw)
			if err == nil {
				err = c.checkURL(u)
			}
		}
		if err != nil {
			return PublicResource{}, err
		}
		slot := source
		if slot == "" {
			slot = publicSource(u)
		}
		var got PublicResource
		var status int
		var headers http.Header
		for attempt := 0; attempt < 3; attempt++ {
			got, status, headers, err = c.publicHop(ctx, u, accept, limit, slot, kind, legacy)
			if ctx.Err() != nil {
				return PublicResource{}, ctx.Err()
			}
			retry := err != nil && safeGETRetry(err) || err == nil && (status == 429 || status == 500 || status == 502 || status == 503 || status == 504)
			if !retry || attempt == 2 {
				break
			}
			delay := retryDelay(headers.Get("Retry-After"), c.publicConfig().Clock.Now())
			if delay < time.Second {
				delay = time.Duration(attempt+1) * time.Second
			}
			if err = c.publicConfig().Clock.Sleep(ctx, delay); err != nil {
				return PublicResource{}, err
			}
		}
		if err != nil {
			return PublicResource{}, err
		}
		if status == 301 || status == 302 || status == 303 || status == 307 || status == 308 {
			if redirects == 5 {
				return PublicResource{}, Error{"公开资料重定向超过 5 次"}
			}
			next, e := u.Parse(headers.Get("Location"))
			if e != nil || headers.Get("Location") == "" {
				return PublicResource{}, Error{"公开资料重定向无效"}
			}
			raw = next.String()
			continue
		}
		if status == 404 || status == 410 {
			return PublicResource{}, ErrNotFound
		}
		if status < 200 || status > 299 {
			return PublicResource{}, Error{fmt.Sprintf("公开资料服务返回 %d", status)}
		}
		return got, nil
	}
	return PublicResource{}, Error{"公开资料重定向无效"}
}
func (c *Client) FetchPublic(ctx context.Context, raw, kind string) (PublicResource, error) {
	limit := int64(8 << 20)
	accept := "application/json,application/atom+xml"
	switch kind {
	case "metadata":
	case "html":
		limit = 4 << 20
		accept = "text/html,application/xhtml+xml"
	case "pdf":
		limit = 64 << 20
		accept = "application/pdf"
	case "document":
		limit = 64 << 20
		accept = "application/pdf,text/html,application/xhtml+xml"
	default:
		return PublicResource{}, Error{"未知公开资料类型"}
	}
	got, err := c.fetchPublic(ctx, raw, accept, limit, "", kind, false)
	if err != nil {
		return got, err
	}
	got.FinalURL = PublicDisplayURL(got.FinalURL)
	if kind == "document" {
		if got.ContentType == "application/pdf" {
			return got, nil
		}
		kind = "html"
	}
	if kind == "html" {
		got.Bytes = []byte(PublicText(string(got.Bytes)))
		got.BodyParagraphs = publicArticleParagraphs(string(got.Bytes))
		got.Hash = publicHash(got.Bytes)
	}
	return got, nil
}

// PublicText deliberately returns plain text, never reusable active markup.
// Drop entire active/hidden subtrees, including script text and fallback frames.
func PublicText(raw string) string {
	root, err := nethtml.Parse(strings.NewReader(raw))
	if err != nil {
		return ""
	}
	var out strings.Builder
	var visit func(*nethtml.Node)
	visit = func(n *nethtml.Node) {
		if n.Type == nethtml.ElementNode {
			switch strings.ToLower(n.Data) {
			case "script", "style", "iframe", "object", "embed", "svg", "math", "form", "input", "button", "template", "noscript", "head":
				return
			}
			for _, a := range n.Attr {
				if a.Key == "hidden" || a.Key == "aria-hidden" && a.Val == "true" {
					return
				}
			}
			if n.Data == "p" || n.Data == "div" || n.Data == "br" || isPublicHeading(n.Data) || strings.HasSuffix(n.Data, ":p") {
				out.WriteByte('\n')
			}
		}
		if n.Type == nethtml.TextNode {
			out.WriteString(n.Data)
		}
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
		if n.Type == nethtml.ElementNode && (n.Data == "p" || n.Data == "div" || isPublicHeading(n.Data) || strings.HasSuffix(n.Data, ":p")) {
			out.WriteByte('\n')
		}
	}
	visit(root)
	lines := []string{}
	for _, line := range strings.Split(out.String(), "\n") {
		if s := clean(line); s != "" {
			lines = append(lines, s)
		}
	}
	return strings.Join(lines, "\n")
}

func isPublicHeading(tag string) bool {
	return len(tag) == 2 && tag[0] == 'h' && tag[1] >= '1' && tag[1] <= '6'
}

// Conservative structural qualification, not a scientific quality judgment.
// Abstracts, headings alone and access gates never prove readable full text.
func publicArticleParagraphs(text string) map[int]bool {
	lower := strings.ToLower(text)
	for _, gate := range []string{"purchase access", "sign in to access", "log in to access", "subscribe to access", "buy this article", "购买全文", "登录后查看"} {
		if strings.Contains(lower, gate) {
			return nil
		}
	}
	section := ""
	counts := map[string]int{}
	paragraphs := map[int]bool{}
	for i, line := range strings.Split(text, "\n") {
		heading := strings.Trim(strings.ToLower(line), "0123456789. :：")
		switch heading {
		case "methods", "method", "methodology", "materials and methods", "方法":
			section = "method"
			continue
		case "results", "experiments", "experimental results", "结果", "实验":
			section = "results"
			continue
		case "abstract", "references", "摘要", "参考文献":
			section = ""
			continue
		}
		if section != "" && len([]rune(line)) >= 80 {
			counts[section] += len([]rune(line))
			paragraphs[i+1] = true
		}
	}
	if counts["method"] < 160 || counts["results"] < 160 {
		return nil
	}
	return paragraphs
}
