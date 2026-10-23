package scholar

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type SearchQuery struct {
	Source, Text     string
	FromYear, ToYear int
	Cursor           string
	Limit            int
}
type SearchPage struct {
	Items                         []Candidate
	NextCursor, Source, FetchedAt string
}
type Candidate struct {
	IdentityKey, Title, Authors, DOI, ArXiv, PublishedAt, UpdatedAt, Abstract, LandingURL, PDFURL string
	Aliases                                                                                       []string
}
type searchCursor struct {
	Query        string
	Start, Total int
	Remote       string
}
type searchCacheEntry struct {
	Page    SearchPage
	Expires time.Time
}
type searchRefreshKey struct{}

// WithSearchRefresh is for a new novelty investigation. Resuming an old run
// should reuse its persisted searches/evidence and original fetchedAt instead.
func WithSearchRefresh(ctx context.Context) context.Context {
	return context.WithValue(ctx, searchRefreshKey{}, true)
}
func encodeSearchCursor(c searchCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}
func cloneSearchPage(p SearchPage) SearchPage {
	p.Items = append([]Candidate{}, p.Items...)
	for i := range p.Items {
		p.Items[i].Aliases = append([]string{}, p.Items[i].Aliases...)
	}
	return p
}
func (c *Client) Search(ctx context.Context, in SearchQuery) (SearchPage, error) {
	page := SearchPage{Items: []Candidate{}, Source: in.Source}
	if err := ctx.Err(); err != nil {
		return page, err
	}
	if (in.Source != "arxiv" && in.Source != "crossref") || strings.TrimSpace(in.Text) == "" || len(in.Text) > 4096 || in.Limit < 1 || in.Limit > 20 || (in.FromYear != 0 && (in.FromYear < 1000 || in.FromYear > 9999)) || (in.ToYear != 0 && (in.ToYear < 1000 || in.ToYear > 9999)) || (in.FromYear > 0 && in.ToYear > 0 && in.FromYear > in.ToYear) {
		return page, Error{"论文检索参数无效"}
	}
	base := in
	base.Cursor = ""
	signature, _ := json.Marshal(base)
	fingerprint := publicHash(signature)
	cursor := searchCursor{Query: fingerprint, Total: -1}
	if in.Cursor != "" {
		b, e := base64.RawURLEncoding.DecodeString(in.Cursor)
		if e != nil || len(b) > 16384 || json.Unmarshal(b, &cursor) != nil || cursor.Query != fingerprint || cursor.Start < 0 || cursor.Total < 0 || in.Source == "crossref" && cursor.Remote == "" {
			return page, Error{"检索游标与查询不符"}
		}
	}
	cacheKey := fingerprint + ":" + in.Cursor
	clock := c.publicConfig().Clock
	c.searchMu.Lock()
	cached, ok := c.searchCache[cacheKey]
	c.searchMu.Unlock()
	if refresh, _ := ctx.Value(searchRefreshKey{}).(bool); !refresh && ok && clock.Now().Before(cached.Expires) {
		return cloneSearchPage(cached.Page), nil
	}
	var raw string
	if in.Source == "arxiv" {
		u, err := url.Parse(c.ArXivAPI)
		if err != nil {
			return page, err
		}
		q := u.Query()
		text := "all:" + strconv.Quote(in.Text)
		if in.FromYear > 0 || in.ToYear > 0 {
			from, to := in.FromYear, in.ToYear
			if from == 0 {
				from = 1000
			}
			if to == 0 {
				to = 9999
			}
			text += fmt.Sprintf(" AND submittedDate:[%04d01010000 TO %04d12312359]", from, to)
		}
		q.Set("search_query", text)
		q.Set("start", strconv.Itoa(cursor.Start))
		q.Set("max_results", strconv.Itoa(in.Limit))
		q.Set("sortBy", "relevance")
		u.RawQuery = q.Encode()
		raw = u.String()
	} else {
		u, err := url.Parse(strings.TrimRight(c.Crossref, "/"))
		if err != nil {
			return page, err
		}
		q := u.Query()
		q.Set("query", in.Text)
		q.Set("rows", strconv.Itoa(in.Limit))
		remote := cursor.Remote
		if remote == "" {
			remote = "*"
		}
		q.Set("cursor", remote)
		filters := []string{}
		if in.FromYear > 0 {
			filters = append(filters, fmt.Sprintf("from-pub-date:%04d-01-01", in.FromYear))
		}
		if in.ToYear > 0 {
			filters = append(filters, fmt.Sprintf("until-pub-date:%04d-12-31", in.ToYear))
		}
		if len(filters) > 0 {
			q.Set("filter", strings.Join(filters, ","))
		}
		u.RawQuery = q.Encode()
		raw = u.String()
	}
	resource, err := c.fetchPublic(ctx, raw, "application/atom+xml,application/json", 8<<20, in.Source, false)
	if err != nil {
		return page, err
	}
	page.FetchedAt = resource.FetchedAt
	var next searchCursor
	next.Query = fingerprint
	if in.Source == "arxiv" {
		page.Items, next, err = parseArxivSearch(resource.Bytes, in, cursor)
	} else {
		page.Items, next, err = parseCrossrefSearch(resource.Bytes, in, cursor)
	}
	if err != nil {
		return SearchPage{}, err
	}
	next.Query = fingerprint
	if next.Start > cursor.Start {
		page.NextCursor = encodeSearchCursor(next)
	}
	page.Items = mergeCandidates(page.Items)
	c.searchMu.Lock()
	if c.searchCache == nil {
		c.searchCache = map[string]searchCacheEntry{}
	}
	if len(c.searchCache) >= 128 {
		for key := range c.searchCache {
			delete(c.searchCache, key)
			break
		}
	}
	c.searchCache[cacheKey] = searchCacheEntry{cloneSearchPage(page), clock.Now().Add(24 * time.Hour)}
	c.searchMu.Unlock()
	return page, nil
}
func parseArxivSearch(data []byte, in SearchQuery, cur searchCursor) ([]Candidate, searchCursor, error) {
	var f arxivSearchFeed
	decoder := xml.NewDecoder(bytes.NewReader(data))
	if decoder.Decode(&f) != nil {
		return nil, searchCursor{}, Error{"arXiv 返回了畸形 Atom"}
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, searchCursor{}, Error{"arXiv 正文不完整"}
		}
		switch v := token.(type) {
		case xml.CharData:
			if strings.TrimSpace(string(v)) != "" {
				return nil, searchCursor{}, Error{"arXiv 返回了额外正文"}
			}
		case xml.Comment:
		default:
			return nil, searchCursor{}, Error{"arXiv 返回了额外 XML"}
		}
	}

	if f.Total == nil || f.Start == nil || f.Size == nil || *f.Total < 0 || *f.Start != cur.Start || *f.Size < 0 || *f.Size > in.Limit || len(f.Entries) > in.Limit || len(f.Entries) > *f.Size || cur.Total >= 0 && *f.Total != cur.Total || cur.Start+len(f.Entries) > *f.Total || len(f.Entries) == 0 && cur.Start < *f.Total {
		return nil, searchCursor{}, Error{"arXiv 分页数据无效或已变化"}
	}
	out := []Candidate{}
	for _, e := range f.Entries {
		id := strings.TrimPrefix(strings.TrimPrefix(e.ID, "http://arxiv.org/abs/"), "https://arxiv.org/abs/")
		if strings.Contains(e.ID, "api/errors") || !arxivID.MatchString(id) || clean(e.Title) == "" {
			return nil, searchCursor{}, Error{"arXiv 返回了错误条目"}
		}
		if e.Published != "" {
			if _, err := time.Parse(time.RFC3339, e.Published); err != nil {
				return nil, searchCursor{}, Error{"arXiv 日期无效"}
			}
		}
		if e.Updated != "" {
			if _, err := time.Parse(time.RFC3339, e.Updated); err != nil {
				return nil, searchCursor{}, Error{"arXiv 版本日期无效"}
			}
		}
		authors := []string{}
		for _, a := range e.Authors {
			authors = append(authors, clean(a.Name))
		}
		doi := normalizeSearchDOI(e.DOI)
		item := Candidate{IdentityKey: "arxiv:" + bareArXiv(id), Title: clean(e.Title), Authors: strings.Join(authors, ", "), DOI: doi, ArXiv: id, PublishedAt: e.Published, UpdatedAt: e.Updated, Abstract: PublicText(e.Summary), LandingURL: "https://arxiv.org/abs/" + id, PDFURL: "https://arxiv.org/pdf/" + id, Aliases: []string{"arxiv:" + id, "arxiv:" + bareArXiv(id)}}
		if doi != "" {
			item.Aliases = append(item.Aliases, "doi:"+doi)
		}
		// Published is first submission, not updated/version date. Unknown dates
		// stay unknown; never invent a year or treat them as verified in-range.
		if knownOutsideYear(item.PublishedAt, in) {
			continue
		}
		out = append(out, item)
	}
	next := searchCursor{}
	if cur.Start+len(f.Entries) < *f.Total {
		if len(f.Entries) == 0 {
			return nil, next, Error{"arXiv 分页未推进"}
		}
		next = searchCursor{Start: cur.Start + len(f.Entries), Total: *f.Total}
	}
	return out, next, nil
}

type arxivSearchFeed struct {
	XMLName xml.Name `xml:"http://www.w3.org/2005/Atom feed"`
	Total   *int     `xml:"http://a9.com/-/spec/opensearch/1.1/ totalResults"`
	Start   *int     `xml:"http://a9.com/-/spec/opensearch/1.1/ startIndex"`
	Size    *int     `xml:"http://a9.com/-/spec/opensearch/1.1/ itemsPerPage"`
	Entries []struct {
		ID        string `xml:"id"`
		Title     string `xml:"title"`
		Summary   string `xml:"summary"`
		Published string `xml:"published"`
		Updated   string `xml:"updated"`
		DOI       string `xml:"http://arxiv.org/schemas/atom doi"`
		Authors   []struct {
			Name string `xml:"name"`
		} `xml:"author"`
	} `xml:"entry"`
}

func knownOutsideYear(date string, q SearchQuery) bool {
	if len(date) < 4 {
		return false
	}
	y, err := strconv.Atoi(date[:4])
	return err == nil && (q.FromYear > 0 && y < q.FromYear || q.ToYear > 0 && y > q.ToYear)
}
func normalizeSearchDOI(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	raw = strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(raw, "https://doi.org/"), "http://doi.org/"), "doi:")
	return strings.TrimSpace(raw)
}
func parseCrossrefSearch(data []byte, in SearchQuery, cur searchCursor) ([]Candidate, searchCursor, error) {
	type date struct {
		Parts [][]int `json:"date-parts"`
		Time  string  `json:"date-time"`
	}
	var body struct {
		Status  string `json:"status"`
		Type    string `json:"message-type"`
		Message struct {
			Total  *int   `json:"total-results"`
			Size   *int   `json:"items-per-page"`
			Cursor string `json:"next-cursor"`
			Items  *[]struct {
				DOI                        string
				Title                      []string
				Author                     []struct{ Given, Family, Name string }
				Published, Issued, Indexed date
				Abstract, URL              string
				Link                       []struct {
					URL  string
					Type string `json:"content-type"`
				}
			} `json:"items"`
		} `json:"message"`
	}
	if json.Unmarshal(data, &body) != nil || body.Status != "ok" || body.Type != "work-list" || body.Message.Total == nil || body.Message.Size == nil || body.Message.Items == nil {
		return nil, searchCursor{}, Error{"Crossref 返回了畸形结果"}
	}
	m := body.Message
	items := *m.Items
	if *m.Total < 0 || *m.Size != in.Limit || len(items) > in.Limit || cur.Total >= 0 && cur.Total != *m.Total || cur.Start+len(items) > *m.Total || len(items) == in.Limit && cur.Start+len(items) < *m.Total && (m.Cursor == "" || m.Cursor == cur.Remote) {
		return nil, searchCursor{}, Error{"Crossref 分页数据无效或已变化"}
	}
	out := []Candidate{}
	for _, v := range items {
		doi := normalizeSearchDOI(v.DOI)
		if !strings.HasPrefix(doi, "10.") || !strings.Contains(doi, "/") || len(v.Title) == 0 || clean(v.Title[0]) == "" {
			return nil, searchCursor{}, Error{"Crossref 条目标识无效"}
		}
		authors := []string{}
		for _, a := range v.Author {
			name := clean(a.Name)
			if name == "" {
				name = clean(a.Given + " " + a.Family)
			}
			authors = append(authors, name)
		}
		published := datePart(v.Published.Parts)
		if published == "" {
			published = datePart(v.Issued.Parts)
		}
		// Crossref indexed is metadata retrieval/index time, not a paper revision.
		item := Candidate{IdentityKey: "doi:" + doi, DOI: doi, Title: clean(v.Title[0]), Authors: strings.Join(authors, ", "), PublishedAt: published, Abstract: PublicText(v.Abstract), LandingURL: v.URL, Aliases: []string{"doi:" + doi}}
		if item.LandingURL == "" {
			item.LandingURL = "https://doi.org/" + doi
		}
		for _, link := range v.Link {
			if link.Type == "application/pdf" {
				item.PDFURL = link.URL
				break
			}
		}
		if knownOutsideYear(published, in) {
			continue
		}
		out = append(out, item)
	}
	next := searchCursor{}
	if len(items) == in.Limit && cur.Start+len(items) < *m.Total {
		next = searchCursor{Start: cur.Start + len(items), Total: *m.Total, Remote: m.Cursor}
	}
	return out, next, nil
}
func mergeCandidates(items []Candidate) []Candidate {
	out := []Candidate{}
	for _, item := range items {
		match := -1
		for i, old := range out {
			if item.DOI != "" && old.DOI == item.DOI || item.ArXiv != "" && bareArXiv(old.ArXiv) == bareArXiv(item.ArXiv) {
				match = i
				break
			}
		}
		if match < 0 {
			out = append(out, item)
			continue
		}
		old := out[match]
		aliases := append(append([]string{}, old.Aliases...), item.Aliases...)
		if item.UpdatedAt > old.UpdatedAt || item.UpdatedAt == old.UpdatedAt && arxivVersionNumber(item.ArXiv) > arxivVersionNumber(old.ArXiv) {
			old = item
		}
		old.Aliases = nil
		seen := map[string]bool{}
		for _, a := range aliases {
			if !seen[a] {
				seen[a] = true
				old.Aliases = append(old.Aliases, a)
			}
		}
		out[match] = old
	}
	return out
}

func arxivVersionNumber(id string) int {
	at := strings.LastIndex(id, "v")
	if at < 0 {
		return 0
	}
	n, _ := strconv.Atoi(id[at+1:])
	return n
}
