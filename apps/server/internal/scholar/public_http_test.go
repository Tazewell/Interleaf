package scholar

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPublicFetchTrustedProxyPinsCONNECTAndHTTP(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "example.com" {
			t.Error(r.Host)
		}
		fmt.Fprint(w, "<p>verified</p>")
	}))
	defer target.Close()
	connectTarget := ""
	httpTarget := ""
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Api-Key") != "" {
			t.Error("leaked header")
		}
		if r.Method != http.MethodConnect {
			httpTarget = r.URL.Host
			fmt.Fprint(w, "<p>proxied</p>")
			return
		}
		connectTarget = r.Host
		if r.Host == "93.184.216.34:80" {
			httpTarget = r.Host
			conn, _, e := w.(http.Hijacker).Hijack()
			if e != nil {
				t.Error(e)
				return
			}
			defer conn.Close()
			fmt.Fprint(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
			request, e := http.ReadRequest(bufio.NewReader(conn))
			if e != nil {
				t.Error(e)
				return
			}
			if request.Host != "example.com" {
				t.Error(request.Host)
			}
			fmt.Fprint(conn, "HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\n<p>proxied</p>")
			return
		}
		upstream, err := net.Dial("tcp", target.Listener.Addr().String())
		if err != nil {
			t.Error(err)
			return
		}
		downstream, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			upstream.Close()
			return
		}
		fmt.Fprint(downstream, "HTTP/1.1 200 Connection Established\r\n\r\n")
		go func() {
			defer upstream.Close()
			defer downstream.Close()
			go io.Copy(upstream, downstream)
			io.Copy(downstream, upstream)
		}()
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	roots := x509.NewCertPool()
	roots.AddCert(target.Certificate())
	c := New(64 << 20)
	c.Public = &PublicConfig{LookupIP: func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("93.184.216.34")}, nil }, Proxy: func(*http.Request) (*url.URL, error) { return proxyURL, nil }, TLSConfig: target.Client().Transport.(*http.Transport).TLSClientConfig.Clone()}
	c.Public.TLSConfig.InsecureSkipVerify = false
	c.Public.TLSConfig.RootCAs = roots
	got, err := c.FetchPublic(t.Context(), "https://example.com/paper", "html")
	if err != nil || string(got.Bytes) != "verified" || connectTarget != "93.184.216.34:443" {
		t.Fatal(got, err, connectTarget)
	}
	got, err = c.FetchPublic(t.Context(), "http://example.com/paper", "html")
	if err != nil || string(got.Bytes) != "proxied" || httpTarget != "93.184.216.34:80" {
		t.Fatal(got, err, httpTarget)
	}
	proxyURL.Scheme = "socks5"
	if _, err = c.FetchPublic(t.Context(), "https://example.com/paper", "html"); err == nil {
		t.Fatal("unprovable proxy silently bypassed")
	}
}

type fastClock struct {
	mu    sync.Mutex
	at    time.Time
	waits []time.Duration
}

func (c *fastClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.at }
func (c *fastClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	c.at = c.at.Add(d)
	c.waits = append(c.waits, d)
	c.mu.Unlock()
	return nil
}
func publicFixture(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server, *fastClock) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	clock := &fastClock{at: time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)}
	c := New(64 << 20)
	c.Public = &PublicConfig{Clock: clock, Limiter: NewSourceLimiter(clock), Proxy: func(*http.Request) (*url.URL, error) { return nil, nil }, LookupIP: func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("93.184.216.34")}, nil }, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "93.184.216.34:80" {
			return nil, fmt.Errorf("unpinned dial: %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}}
	c.ArXivAPI = "http://paper.example/arxiv"
	c.Crossref = "http://paper.example/works/"
	return c, srv, clock
}

// Without DNS validation and a numeric dial, a rebind reaches the private target.
func TestPublicFetchRejectsResolvedPrivateTargets(t *testing.T) {
	c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Api-Key") != "" {
			t.Error("credentials leaked")
		}
		if r.Host != "paper.example" {
			t.Errorf("lost origin Host: %s", r.Host)
		}
		fmt.Fprint(w, "<p>safe</p><script>evil()</script><iframe>evil frame</iframe><p onclick='evil()'>result</p>")
	})
	resolutions := 0
	c.Public.LookupIP = func(context.Context, string) ([]net.IP, error) {
		resolutions++
		if resolutions > 1 {
			return []net.IP{net.ParseIP("127.0.0.1")}, nil
		}
		return []net.IP{net.ParseIP("93.184.216.34")}, nil
	}
	got, err := c.FetchPublic(t.Context(), "http://paper.example/page", "html")
	if err != nil || string(got.Bytes) != "safe\nresult" || resolutions != 1 {
		t.Fatal(got, err, resolutions)
	}
	if _, err = c.FetchPublic(t.Context(), "http://paper.example/page", "html"); err == nil {
		t.Fatal("rebound host accepted")
	}
	for _, host := range []string{"127.0.0.1", "10.1.2.3", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1", "2001:db8::1"} {
		t.Run(host, func(t *testing.T) {
			c.Public.LookupIP = func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP(host)}, nil }
			if _, err := c.FetchPublic(t.Context(), "http://paper.example/page", "html"); err == nil {
				t.Fatal("private DNS accepted")
			}
		})
	}
	for _, raw := range []string{"http://user:pass@paper.example/", "file:///etc/passwd", "ftp://paper.example/x", "http://[::ffff:127.0.0.1]/"} {
		if _, err := c.FetchPublic(t.Context(), raw, "html"); err == nil {
			t.Fatal("unsafe URL", raw)
		}
	}
}

func TestPublicFetchRedirectLimitsAndDecompression(t *testing.T) {
	c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/private":
			http.Redirect(w, r, "http://127.0.0.1/private", 302)
		case "/loop":
			http.Redirect(w, r, "/loop", 302)
		case "/big":
			w.Header().Set("Content-Encoding", "gzip")
			z := gzip.NewWriter(w)
			_, _ = z.Write([]byte(strings.Repeat("a", (4<<20)+1)))
			z.Close()
		case "/truncated":
			w.Header().Set("Content-Length", "100")
			fmt.Fprint(w, "short")
		default:
			fmt.Fprint(w, "<html>login</html>")
		}
	})
	for _, path := range []string{"private", "loop", "big", "truncated"} {
		if _, err := c.FetchPublic(t.Context(), "http://paper.example/"+path, "html"); err == nil {
			t.Fatal(path)
		}
	}
	if _, err := c.FetchPublic(t.Context(), "http://paper.example/fake.pdf", "pdf"); err == nil {
		t.Fatal("non PDF accepted")
	}
}

func TestPublicFetchCancelBody(t *testing.T) {
	started := make(chan struct{})
	c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { _, err := c.FetchPublic(ctx, "http://paper.example/page", "html"); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled body accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("body did not stop")
	}
}

func TestPublicFetchDetectsUserPDFAndDoesNotRetryTLSOrTruncation(t *testing.T) {
	calls := 0
	c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/pdf")
		w.Write([]byte("%PDF-1.4\n%%EOF"))
	})
	resource, err := c.FetchPublic(t.Context(), "http://paper.example/user-url", "document")
	if err != nil || !bytes.HasPrefix(resource.Bytes, []byte("%PDF-")) || calls != 1 {
		t.Fatal(resource, err, calls)
	}
	tlsTarget := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted TLS reached handler") }))
	defer tlsTarget.Close()
	dials := 0
	c.Public.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		dials++
		return (&net.Dialer{}).DialContext(ctx, network, tlsTarget.Listener.Addr().String())
	}
	if _, err = c.FetchPublic(t.Context(), "https://example.com/tls", "html"); err == nil || dials != 1 {
		t.Fatal(err, dials)
	}
}

type observedBodyConn struct {
	net.Conn
	once *sync.Once
	read chan struct{}
}

func (c observedBodyConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if bytes.Contains(p[:n], []byte("partial-body")) {
		c.once.Do(func() { close(c.read) })
	}
	return n, err
}

func TestPublicFetchBodyResetIsNotRetried(t *testing.T) {
	read := make(chan struct{})
	var observed sync.Once
	var calls atomic.Int32
	c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		conn, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		fmt.Fprint(buffered, "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\npartial-body")
		buffered.Flush()
		select {
		case <-read:
		case <-r.Context().Done():
			return
		}
		conn.(*net.TCPConn).SetLinger(0) // actual RST after the client received a partial body
	})
	dial := c.Public.DialContext
	c.Public.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dial(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return observedBodyConn{conn, &observed, read}, nil
	}
	_, err := c.FetchPublic(t.Context(), "http://paper.example/reset", "html")
	if err == nil || calls.Load() != 1 {
		t.Fatalf("partial body retried: calls=%d err=%v", calls.Load(), err)
	}
}

func TestPublicFetchDocumentMIME(t *testing.T) {
	for _, tc := range []struct {
		name, mime, body, kind string
		ok                     bool
	}{
		{"json", "application/json", `{"error":"unavailable"}`, "document", false},
		{"json-as-html", "application/json", "<p>error</p>", "html", false},
		{"image", "image/png", "<p>not html</p>", "document", false},
		{"binary", "application/octet-stream", "\x00\x01\x02", "document", false},
		{"html", "text/html; charset=utf-8", "<p>Article.</p>", "document", true},
		{"xhtml", "application/xhtml+xml", `<html xmlns="http://www.w3.org/1999/xhtml"><p>Article.</p></html>`, "html", true},
		{"missing-html", "", "<!doctype html><p>Article.</p>", "document", true},
		{"generic-html", "application/octet-stream", "<html><p>Article.</p></html>", "document", true},
		{"missing-json", "", `{"error":"unavailable"}`, "document", false},
		{"plain-error", "text/plain", "service unavailable", "document", false},
		{"missing-pdf", "", "%PDF-1.7\n", "document", true},
		{"generic-pdf", "application/octet-stream", "%PDF-1.7\n", "pdf", true},
		{"fake-pdf", "application/pdf", "<p>error</p>", "document", false},
		{"wrong-declared-pdf", "image/png", "%PDF-1.7\n", "pdf", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header()["Content-Type"] = nil
				if tc.mime != "" {
					w.Header().Set("Content-Type", tc.mime)
				}
				fmt.Fprint(w, tc.body)
			})
			got, err := c.FetchPublic(t.Context(), "http://paper.example/content", tc.kind)
			if (err == nil) != tc.ok {
				t.Fatalf("MIME=%q kind=%s got=%q err=%v", tc.mime, tc.kind, got.Bytes, err)
			}
		})
	}
}

func TestPublicFetchDocumentDecodedCap(t *testing.T) {
	for _, tc := range []struct {
		name, mime, prefix string
		gzip               bool
		limit              int
	}{
		{"html", "text/html", "<p>", false, 4 << 20},
		{"gzip-html", "text/html", "<p>", true, 4 << 20},
		{"missing-html", "", "<html>", false, 4 << 20},
		{"generic-html", "application/octet-stream", "<html>", true, 4 << 20},
		{"pdf", "application/pdf", "%PDF-1.7\n", false, 64 << 20},
	} {
		t.Run(tc.name, func(t *testing.T) {
			closed := make(chan struct{})
			c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
				defer close(closed)
				w.Header()["Content-Type"] = nil
				if tc.mime != "" {
					w.Header().Set("Content-Type", tc.mime)
				}
				var output io.Writer = w
				var z *gzip.Writer
				if tc.gzip {
					w.Header().Set("Content-Encoding", "gzip")
					z = gzip.NewWriter(w)
					output = z
				}
				fmt.Fprint(output, tc.prefix)
				io.CopyN(output, strings.NewReader(strings.Repeat("a", tc.limit)), int64(tc.limit+1-len(tc.prefix)))
				if z != nil {
					z.Flush()
				}
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			})
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			_, err := c.FetchPublic(ctx, "http://paper.example/over", "document")
			if err == nil || errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "大小限制") {
				t.Fatalf("decoded cap was not early: %v", err)
			}
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("oversized body not closed")
			}
		})
	}
	c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		fmt.Fprint(w, "%PDF-1.7\n"+strings.Repeat("a", 4<<20))
	})
	got, err := c.FetchPublic(t.Context(), "http://paper.example/large-pdf", "document")
	if err != nil || len(got.Bytes) <= 4<<20 {
		t.Fatal("PDF incorrectly limited to HTML cap", len(got.Bytes), err)
	}
}
