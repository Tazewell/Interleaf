package scholar

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

const searchAtom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"><opensearch:totalResults>3</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>2</opensearch:itemsPerPage><entry><id>http://arxiv.org/abs/1706.03762v1</id><published>2017-06-12T17:57:34Z</published><updated>2017-06-12T17:57:34Z</updated><title>Attention Is All You Need</title><summary>First version.</summary><author><name>Ashish Vaswani</name></author><arxiv:doi>10.5555/3295222.3295349</arxiv:doi><link href="http://arxiv.org/abs/1706.03762v1" rel="alternate" type="text/html"/><link href="http://arxiv.org/pdf/1706.03762v1" title="pdf" rel="related" type="application/pdf"/></entry><entry><id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published><updated>2023-08-02T00:00:00Z</updated><title>Attention Is All You Need</title><summary>Latest version.</summary><author><name>Ashish Vaswani</name></author><arxiv:doi>10.5555/3295222.3295349</arxiv:doi></entry></feed>`
const searchCrossref = `{"status":"ok","message-type":"work-list","message-version":"1.0.0","message":{"total-results":3,"items-per-page":2,"query":{"start-index":0,"search-terms":"attention"},"next-cursor":"opaque+/==","items":[{"DOI":"10.1000/ONE","title":["Same title"],"author":[{"given":"Ada","family":"Lovelace"}],"published":{"date-parts":[[2020]]},"indexed":{"date-time":"2026-10-22T01:02:03Z"},"URL":"https://doi.org/10.1000/ONE","abstract":"<jats:p>Safe <b>abstract</b>.</jats:p><script>bad</script>"},{"DOI":"10.1000/two","title":["Same title"],"author":[{"name":"Other author"}],"published":{"date-parts":[]},"URL":"https://doi.org/10.1000/two"}]}}`

func TestScholarSearchPaginationIdentityAndVersions(t *testing.T) {
	hits := 0
	c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		hits++
		q := r.URL.Query()
		switch r.URL.Path {
		case "/arxiv":
			if !strings.Contains(q.Get("search_query"), "submittedDate:[201701010000 TO 202312312359]") {
				t.Error(q)
			}
			if q.Get("start") == "2" {
				fmt.Fprint(w, strings.ReplaceAll(strings.ReplaceAll(searchAtom, "<opensearch:startIndex>0", "<opensearch:startIndex>2"), "<opensearch:totalResults>3", "<opensearch:totalResults>4"))
				return
			}
			fmt.Fprint(w, searchAtom)
		default:
			if q.Get("filter") != "from-pub-date:2020-01-01,until-pub-date:2023-12-31" {
				t.Error(q)
			}
			if q.Get("cursor") == "opaque+/==" {
				fmt.Fprint(w, `{"status":"ok","message-type":"work-list","message":{"total-results":3,"items-per-page":2,"items":[]}}`)
				return
			}
			fmt.Fprint(w, searchCrossref)
		}
	})
	q := SearchQuery{Source: "arxiv", Text: "attention", FromYear: 2017, ToYear: 2023, Limit: 2}
	p, err := c.Search(t.Context(), q)
	if err != nil || len(p.Items) != 1 || p.NextCursor == "" {
		t.Fatal(p, err)
	}
	if p.Items[0].ArXiv != "1706.03762v7" || p.Items[0].PublishedAt != "2017-06-12T17:57:34Z" || !strings.Contains(strings.Join(p.Items[0].Aliases, " "), "1706.03762v1") {
		t.Fatal(p.Items)
	}
	cached, err := c.Search(t.Context(), q)
	if err != nil || cached.FetchedAt != p.FetchedAt || hits != 1 {
		t.Fatal("cache lost fetchedAt", cached, err, hits)
	}
	q.Cursor = p.NextCursor
	if _, err = c.Search(t.Context(), q); err == nil {
		t.Fatal("changed total accepted")
	}
	q = SearchQuery{Source: "crossref", Text: "attention", FromYear: 2020, ToYear: 2023, Limit: 2}
	p, err = c.Search(t.Context(), q)
	if err != nil || len(p.Items) != 2 || p.Items[0].IdentityKey != "doi:10.1000/one" || p.Items[0].Abstract != "Safe abstract." || p.Items[1].PublishedAt != "" {
		t.Fatal(p, err)
	}
	q.Cursor = p.NextCursor
	last, err := c.Search(t.Context(), q)
	if err != nil || len(last.Items) != 0 || last.NextCursor != "" {
		t.Fatal(last, err)
	}
	q.Text = "other"
	if _, err = c.Search(t.Context(), q); err == nil {
		t.Fatal("cursor changed query accepted")
	}
}

func TestScholarSearchRejectsProtocolErrors(t *testing.T) {
	cases := []struct{ source, body string }{
		{"arxiv", `<feed><entry><id>http://arxiv.org/api/errors#bad</id><title>Error</title><summary>bad query</summary></entry></feed>`},
		{"arxiv", `<feed></feed>`}, {"arxiv", strings.TrimSuffix(searchAtom, "</feed>")}, {"arxiv", searchAtom + `<unexpected/>`},
		{"crossref", `{"status":"failed","message":[]}`}, {"crossref", `{"status":"ok","message-type":"work-list","message":{"items":[]}}`},
		{"crossref", strings.TrimSuffix(searchCrossref, "}")}, {"crossref", strings.ReplaceAll(searchCrossref, `"next-cursor":"opaque+/==",`, "")},
		{"crossref", strings.Repeat("x", (8<<20)+1)},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, tc.body) })
			if _, err := c.Search(t.Context(), SearchQuery{Source: tc.source, Text: "x", Limit: 2}); err == nil {
				t.Fatal("bad protocol accepted")
			}
		})
	}
	c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:o="http://a9.com/-/spec/opensearch/1.1/"><o:totalResults>0</o:totalResults><o:startIndex>0</o:startIndex><o:itemsPerPage>2</o:itemsPerPage></feed>`)
	})
	p, err := c.Search(t.Context(), SearchQuery{Source: "arxiv", Text: "none", Limit: 2})
	if err != nil || len(p.Items) != 0 || p.NextCursor != "" {
		t.Fatal(p, err)
	}
}

func TestScholarSearchCrossrefTerminalFullPageAndLegacySanitization(t *testing.T) {
	c, _, _ := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "10.1000") {
			fmt.Fprint(w, `{"message":{"title":["Paper"],"abstract":"<jats:p>Safe.</jats:p><script>active payload</script>"}}`)
			return
		}
		fmt.Fprint(w, strings.ReplaceAll(strings.ReplaceAll(searchCrossref, `"total-results":3`, `"total-results":2`), `"next-cursor":"opaque+/==",`, ""))
	})
	p, err := c.Search(t.Context(), SearchQuery{Source: "crossref", Text: "x", Limit: 2})
	if err != nil || len(p.Items) != 2 || p.NextCursor != "" {
		t.Error(p, err)
	}
	metadata, err := c.crossref(t.Context(), "10.1000/one")
	if err != nil || metadata.Abstract != "Safe." {
		t.Fatal(metadata, err)
	}
}

func TestScholarSearchVersionsAndRefresh(t *testing.T) {
	calls := 0
	c, _, clock := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		fmt.Fprint(w, strings.ReplaceAll(strings.ReplaceAll(searchAtom, "1706.03762v1", "1706.03762v10"), "2023-08-02T00:00:00Z", "2017-06-12T17:57:34Z"))
	})
	q := SearchQuery{Source: "arxiv", Text: "version", Limit: 2}
	p, err := c.Search(t.Context(), q)
	if err != nil || len(p.Items) != 1 || p.Items[0].ArXiv != "1706.03762v10" {
		t.Fatal(p, err)
	}
	clock.Sleep(t.Context(), time.Hour)
	fresh, err := c.Search(WithSearchRefresh(t.Context()), q)
	if err != nil || calls != 2 || fresh.FetchedAt == p.FetchedAt {
		t.Fatal(fresh, err, calls)
	}
	clock.Sleep(t.Context(), 25*time.Hour)
	if _, err = c.Search(t.Context(), q); err != nil || calls != 3 {
		t.Fatal(err, calls)
	}
}
