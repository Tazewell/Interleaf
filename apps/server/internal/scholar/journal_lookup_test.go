package scholar

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestJournalTitleLookupPrefersExactCrossrefTitle(t *testing.T) {
	const psychology = "The social consequences of emotion regulation in everyday life"
	const title = "The Social Consequences of Emotion Regulation in Everyday Life"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/s2/search/match":
			t.Error("exact Crossref title should take priority over fuzzy title search")
			w.Write([]byte(`{"data":[{"title":"The social consequences of emotion regulation in early life","externalIds":{"DOI":"10.1234/other"}}]}`))
		case "/works":
			if r.URL.Query().Get("query.title") != psychology {
				t.Errorf("unexpected Crossref query: %s", r.URL.RawQuery)
			}
			w.Write([]byte(`{"message":{"items":[{"DOI":"10.1234/other","title":["Emotion at work"]},{"DOI":"10.1234/psych","type":"journal-article","title":["` + title + `"],"container-title":["Journal of Personality and Social Psychology"],"author":[{"given":"Ada","family":"Researcher"}]}]}}`))
		case "/works/10.1234/psych":
			w.Write([]byte(`{"message":{"DOI":"10.1234/psych","type":"journal-article","title":["` + title + `"],"container-title":["Journal of Personality and Social Psychology"]}}`))
		case "/doi/10.1234/psych":
			w.Header().Set("Content-Type", "application/pdf")
			w.Write([]byte(pdfBytes))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	c := New(1 << 20)
	c.AllowPrivateHosts = true
	c.Crossref = server.URL + "/works/"
	c.SemanticScholar = server.URL + "/s2/"
	c.DOIResolver = server.URL + "/doi/"

	meta, err := c.Lookup(context.Background(), Identifiers{Title: psychology})
	if err != nil || meta.DOI != "10.1234/psych" || meta.ItemType != "journal" || meta.Venue != "Journal of Personality and Social Psychology" || len(meta.Creators) != 1 {
		t.Fatalf("Crossref metadata: %#v, %v", meta, err)
	}
	result, err := c.Resolve(context.Background(), psychology)
	if err != nil || string(result.PDF) != pdfBytes || result.Metadata.DOI != "10.1234/psych" {
		t.Fatalf("Crossref import: %#v, %v", result, err)
	}
}

func TestCrossrefTitleLookupDeclinesConflictingSameTitleRecords(t *testing.T) {
	const title = "The social consequences of emotion regulation"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/works" {
			http.NotFound(w, r)
			return
		}
		quoted := strconv.Quote(title)
		w.Write([]byte(`{"message":{"items":[{"DOI":"10.1234/first","title":[` + quoted + `]},{"DOI":"10.1234/second","title":[` + quoted + `]}]}}`))
	}))
	defer server.Close()
	c := New(1 << 20)
	c.AllowPrivateHosts = true
	c.Crossref = server.URL + "/works/"
	c.SemanticScholar = server.URL + "/s2/"

	if meta, err := c.Lookup(context.Background(), Identifiers{Title: title}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ambiguous match: %#v, %v", meta, err)
	}
}

func TestAutomaticTitleLookupRequiresAnExactTitle(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/works":
			w.Write([]byte(`{"message":{"items":[]}}`))
		case "/s2/search/match":
			w.Write([]byte(`{"data":[{"title":"Adolescent and Childhood Depression Screening Guidelines"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	c := New(1 << 20)
	c.AllowPrivateHosts = true
	c.Crossref = server.URL + "/works/"
	c.SemanticScholar = server.URL + "/s2/"
	title := "Childhood and Adolescent Depression Screening Guidelines"

	if meta, err := c.Lookup(context.Background(), Identifiers{Title: title, ExactTitle: true}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("automatic lookup accepted a different title: %#v, %v", meta, err)
	}
}

func TestResolvePubMedPaperWithPublicPDF(t *testing.T) {
	var publicPDF string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/search":
			w.Write([]byte(`{"resultList":{"result":[{"id":"12345","source":"MED","title":"Adolescent Mental Health","fullTextUrlList":{"fullTextUrl":[{"availabilityCode":"OA","documentStyle":"pdf","url":` + strconv.Quote(publicPDF) + `}]}}]}}`))
		case "/paper.pdf":
			w.Header().Set("Content-Type", "application/pdf")
			w.Write([]byte(pdfBytes))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	publicPDF = server.URL + "/paper.pdf"
	c := New(1 << 20)
	c.AllowPrivateHosts = true
	c.EuropePMC = server.URL + "/"

	for _, ref := range []string{"PMID:12345", "https://pubmed.ncbi.nlm.nih.gov/12345/"} {
		result, err := c.Resolve(context.Background(), ref)
		if err != nil || string(result.PDF) != pdfBytes || result.Metadata.Title != "Adolescent Mental Health" {
			t.Fatalf("PubMed import for %q: %#v, %v", ref, result, err)
		}
	}
}
