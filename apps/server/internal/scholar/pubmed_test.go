package scholar

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPubMedIdentifiers(t *testing.T) {
	for ref, want := range map[string]string{
		"PMID: 12345678": "12345678",
		"PMID 12345678":  "12345678",
		"https://pubmed.ncbi.nlm.nih.gov/12345678/": "12345678",
		"12345678":                           "",
		"PMID: 12345678 is in this citation": "",
		"https://pubmed.ncbi.nlm.nih.gov/?term=12345678": "",
		"https://pubmed.ncbi.nlm.nih.gov.evil.org/123/":  "",
		"https://pubmed.ncbi.nlm.nih.gov/123/references": "",
	} {
		if got := pubMedRef(ref); got != want {
			t.Errorf("pubMedRef(%q) = %q, want %q", ref, got, want)
		}
	}
	ids := Detect("Title, issue 4\nPMID: 12345678. 2025")
	if ids.PMID != "12345678" {
		t.Fatalf("detected = %+v", ids)
	}
	if got := Detect("PMCID: PMC12345678; OtherPMID: 12345678; 2025"); got.PMID != "" {
		t.Fatalf("false positive: %+v", got)
	}
}

func TestPubMedLookupUsesExactRecordAndOnlyFreePDFLinks(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/search", func(w http.ResponseWriter, r *http.Request) {
		if q := r.URL.Query(); q.Get("query") != "EXT_ID:12345678 AND SRC:MED" || q.Get("resultType") != "core" || q.Get("format") != "json" || q.Get("pageSize") != "1" {
			t.Errorf("unexpected PubMed search: %q", r.URL.RawQuery)
		}
		if _, err := io.WriteString(w, `{
			"hitCount": 1,
			"resultList": {"result": [{
				"id": "12345678", "source": "MED",
				"doi": "10.1234/abcd", "title": "Learning in social contexts",
				"abstractText": "<p>Tests of social learning.</p>",
				"firstPublicationDate": "2024-04-03",
				"pageInfo": "17-35",
				"journalInfo": {"volume": "5", "issue": "2", "journal": {"title": "Journal of Social Learning"}},
				"authorList": {"author": [{"firstName": "Ana", "lastName": "García"}, {"collectiveName": "Cognition Lab"}]},
				"fullTextUrlList": {"fullTextUrl": [
					{"availabilityCode": "S", "documentStyle": "pdf", "url": "https://journal.example/subscription.pdf"},
					{"availabilityCode": "OA", "documentStyle": "html", "url": "https://journal.example/article"},
					{"availabilityCode": "OA", "documentStyle": "pdf", "url": "https://journal.example/article.pdf"}
				]}
			}]}
		}`); err != nil {
			t.Error(err)
		}
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := New(1 << 20)
	client.EuropePMC = server.URL + "/"
	client.AllowPrivateHosts = true

	article, err := client.pubMed(context.Background(), "12345678")
	if err != nil {
		t.Fatal(err)
	}
	m := article.Metadata
	if m.Title != "Learning in social contexts" || m.DOI != "10.1234/abcd" || m.Venue != "Journal of Social Learning" ||
		m.Date != "2024-04-03" || m.Volume != "5" || m.Issue != "2" || m.Pages != "17-35" || m.ItemType != "journal" ||
		m.URL != "https://pubmed.ncbi.nlm.nih.gov/12345678/" || m.Abstract != "Tests of social learning." ||
		len(m.Creators) != 2 || m.Creators[0] != (Creator{Given: "Ana", Family: "García"}) || m.Creators[1].Name != "Cognition Lab" {
		t.Fatalf("metadata = %+v", m)
	}
	if got := strings.Join(article.PDFURLs, ","); got != "https://journal.example/article.pdf" {
		t.Fatalf("PDF URLs = %q", got)
	}
}

func TestPubMedLookupRejectsWrongRecord(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"hitCount":1,"resultList":{"result":[{"id":"12345678","source":"PMC","title":"Different lookup result"}]}}`)
	}))
	t.Cleanup(server.Close)
	client := New(1 << 20)
	client.EuropePMC = server.URL + "/"
	client.AllowPrivateHosts = true
	if _, err := client.pubMed(context.Background(), "12345678"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong record returned: %v", err)
	}
}
