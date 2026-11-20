package interleaf

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"interleaf.local/server/internal/scholar"
)

const lookupAtom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id>
<published>2017-06-12T00:00:00Z</published><title>Attention Is All You Need</title><summary>Abstract text.</summary>
<author><name>Ashish Vaswani</name></author></entry></feed>`

// scholarFixture serves an arXiv entry and its PDF; it counts requests.
func scholarFixture(t *testing.T, s *Server, pageCounts ...int) *atomic.Int32 {
	t.Helper()
	var hits atomic.Int32
	pages := 3
	if len(pageCounts) > 0 {
		pages = pageCounts[0]
	}
	pdf := testPDF(pages)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch {
		case strings.HasPrefix(r.URL.Path, "/api"):
			w.Write([]byte(lookupAtom))
		case strings.HasPrefix(r.URL.Path, "/pdf/"):
			w.Write(pdf)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	c := scholar.New(maxImportBytes)
	c.AllowPrivateHosts = true
	c.ArXivAPI, c.ArXivPDF = server.URL+"/api", server.URL+"/pdf/"
	c.Crossref, c.SemanticScholar = server.URL+"/none/", server.URL+"/none/"
	s.scholar = c
	return &hits
}
func TestResolveImportsPaperWithMetadata(t *testing.T) {
	s := testServer(t)
	scholarFixture(t, s)
	w := request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"arXiv:1706.03762"}`))
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	var d Document
	_ = json.Unmarshal(w.Body.Bytes(), &d)
	if d.Library != "papers" || d.Title != "Attention Is All You Need" || d.Author != "Ashish Vaswani" || d.Metadata.ArXiv != "1706.03762" || d.Metadata.Lookup != "done" || d.Metadata.Sources["title"] != "lookup" {
		t.Fatalf("resolved: %+v", d)
	}
	// Resolving again returns the same document without duplicating it.
	if w = request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"1706.03762"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"x"}`)); w.Code != 400 {
		t.Fatalf("bad reference: %d %s", w.Code, w.Body.String())
	}
}

func TestResolveRawPDFStillQueuesMetadataLookup(t *testing.T) {
	s := testServer(t)
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write(testPDF(2))
	}))
	t.Cleanup(service.Close)
	s.scholarClient().AllowPrivateHosts = true
	pdfURL := service.URL + "/paper.pdf"
	w := request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"`+pdfURL+`"}`))
	var doc Document
	if w.Code != http.StatusCreated || json.Unmarshal(w.Body.Bytes(), &doc) != nil {
		t.Fatalf("resolved PDF: %d %s", w.Code, w.Body.String())
	}
	if doc.Metadata.Lookup != "pending" || doc.Metadata.URL != pdfURL {
		t.Fatalf("raw PDF bypassed automatic lookup: %+v", doc.Metadata)
	}
}
func TestLookupKeepsManualEdits(t *testing.T) {
	s := testServer(t)
	scholarFixture(t, s)
	w := uploadTo(t, s, "papers", "paper.pdf", testPDF(2))
	var d Document
	_ = json.Unmarshal(w.Body.Bytes(), &d)
	if d.Metadata.Lookup != "pending" {
		t.Fatalf("file import not queued for lookup: %+v", d.Metadata)
	}
	request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"title":"My title","metadata":{"arxiv":"1706.03762","date":"2016"}}`))
	if w = request(t, s, "POST", "/api/documents/"+d.ID+"/metadata/lookup", nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, _ := s.Store.Document(d.ID)
	if got.Title != "My title" || got.Metadata.Date != "2016" || got.Metadata.Abstract != "Abstract text." || got.Author != "Ashish Vaswani" || got.Metadata.Lookup != "done" {
		t.Fatalf("lookup: %+v", got)
	}
}
func TestLookupDetectsIdentifierOnFirstPage(t *testing.T) {
	s := testServer(t)
	hits := scholarFixture(t, s)
	w := uploadTo(t, s, "papers", "paper.pdf", testPDF(2))
	var d Document
	_ = json.Unmarshal(w.Body.Bytes(), &d)
	if _, err := s.lookupDocument(context.Background(), d.ID, withoutTitle); err != errNoIdentifier || hits.Load() != 0 {
		t.Fatalf("lookup without identifiers: %v hits=%d", err, hits.Load())
	}
	dir := s.analysisDir(d.ID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := `{"pages":2,"metadata":{"Title":"Microsoft Word - draft.docx"},"blocks":[{"id":"p1-b1","page":1,"label":"text","bounds":{"x":0.1,"y":0.1,"width":0.5,"height":0.1},"text":"arXiv:1706.03762v7 [cs.CL] 2 Aug 2023"}]}`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := s.lookupDocument(context.Background(), d.ID, withoutTitle)
	if err != nil || got.Title != "Attention Is All You Need" || got.Metadata.ArXiv != "1706.03762v7" {
		t.Fatalf("detected lookup: %+v %v", got, err)
	}
}
func TestFileTitleOnlyFillsAPlainTitle(t *testing.T) {
	for title, want := range map[string]string{
		"Microsoft Word - paper.docx": "",
		"untitled document":           "",
		"main":                        "",
		"  Learning   Transferable Visual Models": "Learning Transferable Visual Models",
	} {
		if got := fileTitle(layoutManifest{Metadata: map[string]any{"Title": title}}); got != want {
			t.Errorf("%q: %q", title, got)
		}
	}
}

func TestMetadataLookupUsesEmbeddedFieldsWithoutNetwork(t *testing.T) {
	s := testServer(t)
	hits := scholarFixture(t, s)
	d := queuedMetadataPaper(t, s, 2, "")
	manifest := `{"pages":2,"metadata":{"Title":"Microsoft Word - paper.docx","XMPTitle":"注意偏向的实验研究","XMPCreators":["王小芳","Anne Marie Smith"]}}`
	if err := os.WriteFile(filepath.Join(s.analysisDir(d.ID), "manifest.json"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	_, _ = s.lookupDocument(context.Background(), d.ID, withoutTitle)
	got, err := s.Store.Document(d.ID)
	if err != nil || got.Title != "注意偏向的实验研究" || got.Author != "王小芳, Anne Marie Smith" ||
		got.Metadata.Sources["title"] != "file" || got.Metadata.Sources["creators"] != "file" || hits.Load() != 0 {
		t.Fatalf("embedded metadata: title=%q author=%q sources=%v hits=%d err=%v",
			got.Title, got.Author, got.Metadata.Sources, hits.Load(), err)
	}
}

func TestLocalMetadataRecoversArticleTitleBelowJournalMasthead(t *testing.T) {
	const title = "THE MAGICAL NUMBER SEVEN, PLUS OR MINUS TWO: SOME LIMITS ON OUR CAPACITY FOR PROCESSING INFORMATION"
	manifest := `{"pages":17,"blocks":[
		{"id":"p1-b1","page":1,"label":"header","bounds":{"x":0.096,"y":0.072,"width":0.196,"height":0.021},"text":"VOL. 63, No. 1"},
		{"id":"p1-b2","page":1,"label":"header","bounds":{"x":0.722,"y":0.072,"width":0.168,"height":0.022},"text":"MARCH, 1956"},
		{"id":"p1-b3","page":1,"label":"doc_title","bounds":{"x":0.173,"y":0.144,"width":0.633,"height":0.039},"text":"THE PSYCHOLOGICAL REVIEW"},
		{"id":"p1-b4","page":1,"label":"text","bounds":{"x":0.129,"y":0.222,"width":0.721,"height":0.062},"text":"` + title + ` 1"},
		{"id":"p1-b5","page":1,"label":"text","bounds":{"x":0.391,"y":0.300,"width":0.203,"height":0.017},"text":"GEORGE A. MILLER"},
		{"id":"p1-b6","page":1,"label":"text","bounds":{"x":0.408,"y":0.323,"width":0.169,"height":0.016},"text":"Harvard University"},
		{"id":"p1-b7","page":1,"label":"abstract","bounds":{"x":0.093,"y":0.355,"width":0.391,"height":0.295},"text":"Body text follows."},
		{"id":"p1-b13","page":1,"label":"footnote","bounds":{"x":0.094,"y":0.775,"width":0.391,"height":0.136},"text":"1 This paper was first read as an invited address."}
	]}`
	for _, tt := range []struct {
		name, raw, want string
	}{
		{"footnote", manifest, title},
		{"trailing digit without corresponding footnote", strings.Replace(manifest, `"text":"1 This paper`, `"text":"2 This paper`, 1), title + " 1"},
		{"insufficient article evidence", strings.Replace(manifest, `"label":"text","bounds":{"x":0.391`, `"label":"table","bounds":{"x":0.391`, 1), "paper"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := testServer(t)
			hits := scholarFixture(t, s)
			d := queuedMetadataPaper(t, s, 17, "")
			if err := os.WriteFile(filepath.Join(s.analysisDir(d.ID), "manifest.json"), []byte(tt.raw), 0600); err != nil {
				t.Fatal(err)
			}
			before := s.connectorRevision.Load()
			for range 2 {
				if _, err := s.lookupDocument(t.Context(), d.ID, withEmbeddedTitle); err != errNoIdentifier {
					t.Fatalf("layout-derived title attempted online lookup: %v", err)
				}
			}
			got, err := s.Store.Document(d.ID)
			wantRev := before
			if tt.want != "paper" {
				wantRev++
			}
			if err != nil || got.Title != tt.want || hits.Load() != 0 || s.connectorRevision.Load() != wantRev {
				t.Fatalf("local title=%q want %q; online hits=%d; revision=%d want %d; err=%v", got.Title, tt.want, hits.Load(), s.connectorRevision.Load(), wantRev, err)
			}
			items, err := s.Store.PaperItems()
			if err != nil || len(items) != 1 || items[0].Title != tt.want {
				t.Fatalf("paper item did not reflect local title: %+v %v", items, err)
			}
		})
	}
}

func TestMetadataLookupReadsScannedTitleLocallyAndPreservesManualTitle(t *testing.T) {
	const title = "Judgment under Uncertainty: Heuristics and Biases"
	s := testServer(t)
	hits := scholarFixture(t, s)
	d := queuedMetadataPaper(t, s, 9, "")
	manifest := `{"pages":9,"metadata":{"ScannedPageTitle":"` + title + `"}}`
	if err := os.WriteFile(filepath.Join(s.analysisDir(d.ID), "manifest.json"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.lookupDocument(t.Context(), d.ID, withEmbeddedTitle); err != errNoIdentifier || hits.Load() != 0 {
		t.Fatalf("scan should not be sent online: %v", err)
	}
	got, err := s.Store.Document(d.ID)
	if err != nil || got.Title != title || got.Metadata.Sources["title"] != "file" {
		t.Fatalf("scan title=%q sources=%v err=%v", got.Title, got.Metadata.Sources, err)
	}
	if w := request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"title":"My preferred title"}`)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	_, _ = s.lookupDocument(t.Context(), d.ID, withoutTitle)
	got, err = s.Store.Document(d.ID)
	if err != nil || got.Title != "My preferred title" || got.Metadata.Sources["title"] != "manual" {
		t.Fatalf("manual title was changed: title=%q sources=%v err=%v", got.Title, got.Metadata.Sources, err)
	}
}

func TestLocalMetadataDoesNotUseSupplementTitle(t *testing.T) {
	s := testServer(t)
	d := queuedMetadataPaper(t, s, 2, "")
	if _, err := s.Store.DB.Exec(`UPDATE paper_attachments SET role='supplement' WHERE document_id=?`, d.ID); err != nil {
		t.Fatal(err)
	}
	before := s.connectorRevision.Load()
	got, err := s.applyLocalPaperMetadata(d.ID, layoutManifest{
		Metadata: map[string]any{"Title": "Supplementary Materials for the Study"},
	})
	if err != nil || got.Title != d.Title || s.connectorRevision.Load() != before {
		t.Fatalf("supplement changed the title: title=%q want %q err=%v", got.Title, d.Title, err)
	}
}

func TestMetadataLookupUsesEmbeddedDOI(t *testing.T) {
	s := testServer(t)
	d := queuedMetadataPaper(t, s, 2, "")
	manifest := `{"pages":2,"metadata":{"Title":"Survey of Social Identity","Author":"Mina Lee","DOI":"https://doi.org/10.1037/pspa0000123"}}`
	if err := os.WriteFile(filepath.Join(s.analysisDir(d.ID), "manifest.json"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/crossref/10.1037/pspa0000123" {
			_, _ = w.Write([]byte(`{"message":{"type":"journal-article","title":["Survey of Social Identity"],"container-title":["Journal of Personality and Social Psychology"]}}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(service.Close)
	client := scholar.New(maxImportBytes)
	client.AllowPrivateHosts = true
	client.Crossref, client.SemanticScholar = service.URL+"/crossref/", service.URL+"/scholar/"
	s.scholar = client
	got, err := s.lookupDocument(context.Background(), d.ID, withoutTitle)
	if err != nil || got.Metadata.DOI != "10.1037/pspa0000123" ||
		got.Metadata.Venue != "Journal of Personality and Social Psychology" || got.Author != "Mina Lee" {
		t.Fatalf("journal lookup: title=%q author=%q metadata=%+v err=%v", got.Title, got.Author, got.Metadata, err)
	}
}

func TestMetadataLookupTitleFallbackRequiresOptInAndEmbeddedTitle(t *testing.T) {
	s := testServer(t)
	var titleRequests atomic.Int32
	service := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/scholar/search/match" {
			titleRequests.Add(1)
			if query := r.URL.Query().Get("query"); query != "Survey of Social Identity" {
				t.Errorf("unexpected title query %q", query)
			}
			_, _ = w.Write([]byte(`{"data":[{"title":"Survey of Social Identity","venue":"Psychological Review"}]}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(service.Close)
	client := scholar.New(maxImportBytes)
	client.AllowPrivateHosts = true
	client.Crossref, client.SemanticScholar = service.URL+"/crossref/", service.URL+"/scholar/"
	s.scholar = client
	d := queuedMetadataPaper(t, s, 2, "")
	manifestPath := filepath.Join(s.analysisDir(d.ID), "manifest.json")
	manifest := `{"pages":2,"metadata":{"Title":"Survey of Social Identity"},"blocks":[{"id":"p1-b1","page":1,"label":"text","bounds":{"x":0.1,"y":0.1,"width":0.5,"height":0.1},"text":"Unpublished manuscript text."}]}`
	if err := os.WriteFile(manifestPath, []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.lookupDocument(t.Context(), d.ID, withoutTitle); err != errNoIdentifier || titleRequests.Load() != 0 {
		t.Fatalf("title sent without opt-in: %v, requests=%d", err, titleRequests.Load())
	}
	request(t, s, "PUT", "/api/preferences/library", strings.NewReader(`{"papers":{"autoLookupByTitle":true}}`))
	enabled, titleMode := s.metadataLookupOptions()
	if !enabled || !s.lookupPendingMetadata(t.Context(), d.ID, titleMode) {
		t.Fatal("opted-in lookup was skipped")
	}
	got, err := s.Store.Document(d.ID)
	if err != nil || got.Metadata.Lookup != "done" || got.Metadata.Venue != "Psychological Review" || titleRequests.Load() != 1 {
		t.Fatalf("opted-in lookup failed: lookup=%q venue=%q requests=%d err=%v",
			got.Metadata.Lookup, got.Metadata.Venue, titleRequests.Load(), err)
	}

	noTitle := queuedMetadataPaper(t, s, 3, "")
	request(t, s, "PATCH", "/api/documents/"+noTitle.ID, strings.NewReader(`{"title":"Private document title"}`))
	s.lookupPendingMetadata(t.Context(), noTitle.ID, titleMode)
	got, err = s.Store.Document(noTitle.ID)
	if err != nil || got.Metadata.Lookup != "notFound" || titleRequests.Load() != 1 {
		t.Fatalf("non-embedded title changed lookup: lookup=%q requests=%d err=%v",
			got.Metadata.Lookup, titleRequests.Load(), err)
	}
}

func TestAutoLookupPreference(t *testing.T) {
	s := testServer(t)
	if enabled, titleMode := s.metadataLookupOptions(); !enabled || titleMode != withoutTitle {
		t.Fatal("only identifier lookup should default on")
	}
	request(t, s, "PUT", "/api/preferences/library", strings.NewReader(`{"papers":{"autoLookup":false,"autoLookupByTitle":true}}`))
	if enabled, titleMode := s.metadataLookupOptions(); enabled || titleMode != withoutTitle {
		t.Fatal("disabling automatic lookup must also disable automatic title matching")
	}
}

func TestResolveLargePaperConfirmation(t *testing.T) {
	for _, library := range []string{"papers", "books"} {
		t.Run(library, func(t *testing.T) {
			s := testServer(t)
			scholarFixture(t, s, 160)
			w := request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"1706.03762"}`))
			if w.Code != 409 || !strings.Contains(w.Body.String(), "large-paper") {
				t.Fatalf("missing confirmation: %d %s", w.Code, w.Body.String())
			}
			w = request(t, s, "POST", "/api/documents/resolve", strings.NewReader(`{"ref":"1706.03762","allowLarge":true,"library":"`+library+`"}`))
			var d Document
			if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &d) != nil || d.Library != library {
				t.Fatalf("confirmed destination: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
