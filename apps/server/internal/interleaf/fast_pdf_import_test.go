package interleaf

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Keep queue/lifecycle tests portable and exercise the real child-process
// boundary without loading the layout model or depending on Node being installed.
func init() {
	if os.Getenv("INTERLEAF_FAST_PDF_TEST_CHILD") != "1" {
		return
	}
	input, output := "", ""
	for i, arg := range os.Args {
		if i+1 < len(os.Args) && arg == "--input" {
			input = os.Args[i+1]
		}
		if i+1 < len(os.Args) && arg == "--output" {
			output = os.Args[i+1]
		}
	}
	documentID := strings.TrimSuffix(filepath.Base(input), filepath.Ext(input))
	kind := "text"
	if len(os.Args) > 1 && os.Args[1] == "fast-layout" {
		kind = "layout"
	}
	dir := os.Getenv("INTERLEAF_FAST_PDF_MARKERS")
	_ = os.WriteFile(filepath.Join(dir, documentID+"."+kind), nil, 0600)
	if log, err := os.OpenFile(filepath.Join(dir, "calls"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); err == nil {
		_, _ = fmt.Fprintln(log, kind+":"+documentID)
		_ = log.Close()
	}
	if os.Getenv("INTERLEAF_FAST_PDF_BLOCK") == kind {
		for {
			if _, err := os.Stat(filepath.Join(dir, "release")); err == nil {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	if os.Getenv("INTERLEAF_FAST_PDF_FAIL") == documentID {
		os.Exit(3)
	}
	text := "needle" + documentID
	if kind == "text" {
		body := fmt.Sprintf(`{"totalPages":2,"pages":[{"page":1,"spans":[{"text":%q,"bounds":{"x":0.1,"y":0.2,"width":0.6,"height":0.1}}]},{"page":2,"spans":[]}],"outline":[]}`, text)
		_ = os.WriteFile(output, []byte(body), 0600)
	} else {
		_ = os.MkdirAll(output, 0700)
		body := fmt.Sprintf(`{"pages":2,"blocks":[{"id":"p1-b1","page":1,"label":"text","text":%q,"bounds":{"x":0.1,"y":0.2,"width":0.6,"height":0.1}}]}`, "fine "+text)
		_ = os.WriteFile(filepath.Join(output, "manifest.json"), []byte(body), 0600)
		fmt.Println(`{"event":"page","page":2,"total":2}`)
	}
	os.Exit(0)
}

func fastPDFWorkers(t *testing.T) string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Setenv("INTERLEAF_NODE", executable)
	t.Setenv("INTERLEAF_PROCESSOR", "fast-layout")
	t.Setenv("INTERLEAF_CORPUS_PROCESSOR", "fast-corpus")
	t.Setenv("INTERLEAF_FAST_PDF_TEST_CHILD", "1")
	t.Setenv("INTERLEAF_FAST_PDF_MARKERS", dir)
	return dir
}

func waitFastPDF(t *testing.T, description string, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(description)
}

func importFastPDF(t *testing.T, s *Server, suffix string) Document {
	t.Helper()
	data := append(append([]byte{}, sample(t, "reading-notes.pdf")...), []byte("\n% "+suffix)...)
	w := uploadToFolder(t, s, suffix+".pdf", data, "papers", "")
	if w.Code != 201 {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	d := decodeBody[Document](t, w.Body.Bytes())
	// Metadata network lookup is unrelated to local parsing/queue lifecycle.
	_, _ = s.Store.DB.Exec("UPDATE documents SET metadata='{}' WHERE id=?", d.ID)
	return d
}

func TestFastPDFBatchSearchableBeforeFirstLayoutFinishes(t *testing.T) {
	markers := fastPDFWorkers(t)
	t.Setenv("INTERLEAF_FAST_PDF_BLOCK", "layout")
	s := testServer(t)
	_, _ = s.Store.DB.Exec(`INSERT INTO settings(key,value) VALUES('interleaf','{"autoTranslateMaxPages":0}')`)
	docs := []Document{importFastPDF(t, s, "one"), importFastPDF(t, s, "two"), importFastPDF(t, s, "three")}
	ctx, cancel := context.WithCancel(t.Context())
	stop := s.StartProcessing(ctx)
	defer func() { cancel(); stop() }()
	waitFastPDF(t, "later imports waited for the first layout instead of becoming searchable", func() bool {
		var count int
		_ = s.Store.DB.QueryRow("SELECT count(*) FROM document_corpora").Scan(&count)
		return count == len(docs)
	})
	for _, d := range docs {
		w := request(t, s, "GET", "/api/search?q="+url.QueryEscape("needle"+d.ID), nil)
		hits := decodeBody[[]searchHit](t, w.Body.Bytes())
		if w.Code != 200 || len(hits) != 1 || hits[0].DocumentID != d.ID || hits[0].Unit != 1 {
			t.Fatalf("quick source unavailable to library search: %d %+v", w.Code, hits)
		}
		w = request(t, s, "GET", "/api/documents/"+d.ID+"/text", nil)
		text := decodeBody[documentText](t, w.Body.Bytes())
		if text.Parsed || text.Units != 2 || len(text.Blocks) != 1 {
			t.Fatalf("quick text must retain parsed=false and page precision: %+v", text)
		}
	}
	waitFastPDF(t, "layout did not continue after quick indexing", func() bool {
		_, err := os.Stat(filepath.Join(markers, docs[0].ID+".layout"))
		return err == nil
	})
	if err := os.WriteFile(filepath.Join(markers, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitFastPDF(t, "fine layout was not published", func() bool {
		m, err := s.readLayout(docs[0].ID)
		return err == nil && strings.HasPrefix(m.Blocks[0].Text, "fine ")
	})
}

func TestFastPDFProcessingAvailabilityIsDynamicAndPDFOnly(t *testing.T) {
	s, _ := processingFixture(t)
	s.Token = "test-secret"
	_, _ = s.Store.DB.Exec(`INSERT INTO documents(id,type,title,size,created_at,last_opened_at,library) VALUES('epub','epub','book',1,?,?,'books')`, now(), now())
	_ = s.Store.saveProcessing(initialProcessing("epub"))
	for _, tc := range []struct {
		status            string
		searchable, total int
	}{{"ready", 2, 2}, {"partial", 1, 2}, {"unavailable", 0, 2}} {
		t.Run(tc.status, func(t *testing.T) {
			c := documentCorpus{Coverage: corpusCoverage{TotalUnits: tc.total, SearchableUnits: tc.searchable}}
			_, _ = s.Store.DB.Exec("INSERT INTO document_corpora(document_id,fingerprint,revision,body) VALUES('doc','fp','rev',?) ON CONFLICT(document_id) DO UPDATE SET body=excluded.body", jsonText(c))
			_, _ = s.Store.DB.Exec("UPDATE document_corpus_jobs SET status='running' WHERE document_id='doc'")
			w := request(t, s, "GET", "/api/processing", nil)
			var values []map[string]json.RawMessage
			_ = json.Unmarshal(w.Body.Bytes(), &values)
			for _, value := range values {
				var id string
				_ = json.Unmarshal(value["documentId"], &id)
				if id == "epub" && value["textIndex"] != nil {
					t.Fatal("EPUB acquired PDF text availability")
				}
				if id != "doc" {
					continue
				}
				var index struct {
					Status                      string
					TotalPages, SearchablePages int
				}
				_ = json.Unmarshal(value["textIndex"], &index)
				if index.Status != tc.status || index.TotalPages != tc.total || index.SearchablePages != tc.searchable {
					t.Fatalf("availability must prefer usable corpus over refresh job: %+v", index)
				}
			}
			var stored string
			_ = s.Store.DB.QueryRow("SELECT body FROM document_processing WHERE document_id='doc'").Scan(&stored)
			if strings.Contains(stored, "textIndex") {
				t.Fatal("response-only availability was persisted")
			}
		})
	}
}

func TestFastPDFCachedTextRemainsSearchableOutsideParsedBookPages(t *testing.T) {
	s := textFixture(t)
	_, _ = s.Store.DB.Exec("UPDATE documents SET library='books' WHERE id='doc'")
	m, _ := s.readLayout("doc")
	m.ParsedPages = []int{1}
	m.Blocks = m.Blocks[:2]
	_ = os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600)
	c := documentCorpus{Coverage: corpusCoverage{TotalUnits: 2, SearchableUnits: 2}, Passages: []documentPassage{
		{ID: "quick-1", Text: "duplicate quick first page", Location: json.RawMessage(`{"type":"pdf","page":1}`)},
		{ID: "quick-2", Text: "unparsedneedle on second page", Location: json.RawMessage(`{"type":"pdf","page":2}`)},
	}}
	_, _ = s.Store.DB.Exec("INSERT INTO document_corpora(document_id,fingerprint,revision,body) VALUES('doc','fp','rev',?)", jsonText(c))
	w := request(t, s, "GET", "/api/search?q=unparsedneedle", nil)
	hits := decodeBody[[]searchHit](t, w.Body.Bytes())
	if w.Code != 200 || len(hits) != 1 || hits[0].Unit != 2 || hits[0].BlockID != "quick-2" {
		t.Fatalf("unparsed book page was lost after chapter layout: %+v", hits)
	}
	w = request(t, s, "GET", "/api/documents/doc/text", nil)
	text := decodeBody[documentText](t, w.Body.Bytes())
	if !text.Parsed || len(text.ParsedPages) != 1 || text.ParsedPages[0] != 1 || len(text.Blocks) != 3 {
		t.Fatalf("layout preference/parsed pages changed: %+v", text)
	}
}

func TestFastPDFPublicationDuringExtractionRetries(t *testing.T) {
	markers := fastPDFWorkers(t)
	t.Setenv("INTERLEAF_FAST_PDF_BLOCK", "text")
	s := testServer(t)
	d := importFastPDF(t, s, "race")
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); s.corpusWorker(ctx) }()
	defer func() { cancel(); <-done }()
	waitFastPDF(t, "quick extraction did not start during learning", func() bool { _, err := os.Stat(filepath.Join(markers, d.ID+".text")); return err == nil })
	finish := s.beginParserPublication(d.ID)
	_ = os.MkdirAll(s.analysisDir(d.ID), 0700)
	_ = os.WriteFile(filepath.Join(s.analysisDir(d.ID), "manifest.json"), []byte(`{"pages":2,"blocks":[{"id":"p1-b1","page":1,"label":"text","text":"published layout source","bounds":{"x":0.1,"y":0.2,"width":0.6,"height":0.1}}]}`), 0600)
	finish()
	_ = os.WriteFile(filepath.Join(markers, "release"), nil, 0600)
	waitFastPDF(t, "normal parser publication left indexing failed instead of retrying", func() bool {
		var body string
		_ = s.Store.DB.QueryRow("SELECT body FROM document_corpora WHERE document_id=?", d.ID).Scan(&body)
		return strings.Contains(body, "published layout source")
	})
	doc, _ := s.Store.Document(d.ID)
	fingerprint, _ := s.corpusFingerprintContext(t.Context(), doc)
	var stored string
	_ = s.Store.DB.QueryRow("SELECT fingerprint FROM document_corpora WHERE document_id=?", d.ID).Scan(&stored)
	if stored != fingerprint {
		t.Fatal("stale quick provenance was published")
	}
}

func TestFastPDFDeleteCancelsExtractionWithoutResurrection(t *testing.T) {
	markers := fastPDFWorkers(t)
	t.Setenv("INTERLEAF_FAST_PDF_BLOCK", "text")
	s := testServer(t)
	d := importFastPDF(t, s, "delete")
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); s.corpusWorker(ctx) }()
	defer func() { cancel(); <-done }()
	waitFastPDF(t, "extraction did not start", func() bool { _, err := os.Stat(filepath.Join(markers, d.ID+".text")); return err == nil })
	deletion, stop := context.WithTimeout(t.Context(), 3*time.Second)
	defer stop()
	if code, message := s.purgeDocument(deletion, d.ID); code != 204 {
		t.Fatalf("delete: %d %s", code, message)
	}
	for _, table := range []string{"documents", "document_corpora", "document_corpus_jobs", "document_passages_fts"} {
		var count int
		_ = s.Store.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&count)
		if count != 0 {
			t.Fatalf("deletion left %s: %d", table, count)
		}
	}
}

func TestFastPDFLayoutWaitsForOwnInitialIndexButFailedIndexContinues(t *testing.T) {
	markers := fastPDFWorkers(t)
	t.Setenv("INTERLEAF_FAST_PDF_BLOCK", "text")
	s := testServer(t)
	d := importFastPDF(t, s, "gate")
	ctx, cancel := context.WithCancel(t.Context())
	stop := s.StartProcessing(ctx)
	defer func() { cancel(); stop() }()
	waitFastPDF(t, "initial text extraction did not start", func() bool { _, err := os.Stat(filepath.Join(markers, d.ID+".text")); return err == nil })
	time.Sleep(1100 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(markers, d.ID+".layout")); err == nil {
		t.Fatal("layout ran while this paper's initial index was pending")
	}
	cancel()
	stop()
	// A failed quick extraction must never strand the heavyweight fallback.
	t.Setenv("INTERLEAF_FAST_PDF_BLOCK", "")
	t.Setenv("INTERLEAF_FAST_PDF_FAIL", d.ID)
	_, _ = s.Store.DB.Exec("UPDATE document_corpus_jobs SET status='failed' WHERE document_id=?", d.ID)
	ctx, cancel = context.WithCancel(t.Context())
	stop = s.StartProcessing(ctx)
	waitFastPDF(t, "failed text indexing stranded the layout queue", func() bool { _, err := os.Stat(filepath.Join(markers, d.ID+".layout")); return err == nil })
}

func TestFastPDFNewImportsTakePriorityOverIndexUpgrades(t *testing.T) {
	markers := fastPDFWorkers(t)
	s := testServer(t)
	old := importFastPDF(t, s, "old")
	if _, err := s.documentCorpus(t.Context(), old.ID, nil); err != nil {
		t.Fatal(err)
	}
	// Force an actual upgrade instead of the old corpus's cache-hit path.
	_, _ = s.Store.DB.Exec("UPDATE document_corpora SET fingerprint='old-parser' WHERE document_id=?", old.ID)
	_ = os.WriteFile(filepath.Join(markers, "calls"), nil, 0600)
	docs := []Document{importFastPDF(t, s, "new-one"), importFastPDF(t, s, "new-two"), importFastPDF(t, s, "new-three")}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); s.corpusWorker(ctx) }()
	defer func() { cancel(); <-done }()
	waitFastPDF(t, "text lane did not drain new imports and the queued upgrade", func() bool {
		var n int
		_ = s.Store.DB.QueryRow("SELECT count(*) FROM document_corpus_jobs").Scan(&n)
		return n == 0
	})
	data, _ := os.ReadFile(filepath.Join(markers, "calls"))
	calls := strings.Fields(string(data))
	if len(calls) != len(docs)+1 || calls[len(calls)-1] != "text:"+old.ID {
		t.Fatalf("existing-index upgrade ran before new imports: %v", calls)
	}
}

func TestFastPDFGenerationRejectsPublicationWithUnchangedFileMetadata(t *testing.T) {
	s := textFixture(t)
	path := filepath.Join(s.analysisDir("doc"), "manifest.json")
	info, _ := os.Stat(path)
	data, _ := os.ReadFile(path)
	_, err := s.documentCorpus(t.Context(), "doc", func() error {
		finish := s.beginParserPublication("doc")
		defer finish()
		if err := os.WriteFile(path, data, 0600); err != nil {
			return err
		}
		return os.Chtimes(path, info.ModTime(), info.ModTime())
	})
	if !errors.Is(err, errCorpusChanged) {
		t.Fatalf("parser generation change escaped unchanged-stat fingerprint: %v", err)
	}
	var count int
	_ = s.Store.DB.QueryRow("SELECT count(*) FROM document_corpora").Scan(&count)
	if count != 0 {
		t.Fatal("stale corpus committed after generation changed")
	}
}

func TestFastPDFFingerprintFileFailureIsNotPublicationRetry(t *testing.T) {
	fastPDFWorkers(t)
	s := testServer(t)
	d := importFastPDF(t, s, "fingerprint-file-failure")
	_, err := s.documentCorpus(t.Context(), d.ID, func() error {
		// The original passed its first fingerprint. A later filesystem failure
		// must retain its error instead of making the background queue retry it
		// forever as though normal layout publication had changed the source.
		if err := os.Remove(s.Store.File(d)); err != nil {
			return err
		}
		return os.Mkdir(s.Store.File(d), 0700)
	})
	if err == nil || errors.Is(err, errCorpusChanged) || err.Error() != "原文不是普通文件" {
		t.Fatalf("lost final fingerprint filesystem failure: %v", err)
	}
	var count int
	_ = s.Store.DB.QueryRow("SELECT count(*) FROM document_corpora WHERE document_id=?", d.ID).Scan(&count)
	if count != 0 {
		t.Fatal("filesystem failure published an index")
	}
}

func TestFastPDFCloseJoinsBlockedExtraction(t *testing.T) {
	markers := fastPDFWorkers(t)
	t.Setenv("INTERLEAF_FAST_PDF_BLOCK", "text")
	s := testServer(t)
	d := importFastPDF(t, s, "close")
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); s.corpusWorker(ctx) }()
	defer func() { cancel(); <-done }()
	waitFastPDF(t, "extraction did not start", func() bool { _, err := os.Stat(filepath.Join(markers, d.ID+".text")); return err == nil })
	closed := make(chan struct{})
	go func() { s.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("close did not cancel and join extraction")
	}
	var count int
	_ = s.Store.DB.QueryRow("SELECT count(*) FROM document_corpora").Scan(&count)
	if count != 0 {
		t.Fatal("canceled extraction published text")
	}
}

func TestFastPDFOverviewWaitsForFineLayout(t *testing.T) {
	fastPDFWorkers(t)
	s := testServer(t)
	d := importFastPDF(t, s, "overview")
	if _, err := s.documentCorpus(t.Context(), d.ID, nil); err != nil {
		t.Fatal(err)
	}
	_, _ = s.Store.DB.Exec("DELETE FROM document_corpus_jobs WHERE document_id=?", d.ID)
	_, _ = s.Store.DB.Exec("INSERT INTO document_overview_jobs(document_id,job_id,status,error) VALUES(?,?,'queued','')", d.ID, id())
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); s.overviewWorker(ctx) }()
	defer func() { cancel(); <-done }()
	time.Sleep(1500 * time.Millisecond)
	var status string
	_ = s.Store.DB.QueryRow("SELECT status FROM document_overview_jobs WHERE document_id=?", d.ID).Scan(&status)
	if status != "queued" {
		t.Fatalf("paid overview advanced on quick corpus before fine layout: %s", status)
	}
}

func TestFastPDFOverviewWaitsWhenFineLayoutFailedOrPaused(t *testing.T) {
	for _, status := range []string{"failed", "paused"} {
		t.Run(status, func(t *testing.T) {
			fastPDFWorkers(t)
			s := testServer(t)
			_, _ = s.Store.DB.Exec(`INSERT INTO settings(key,value) VALUES('interleaf','{"autoGenerateOverview":true}')`)
			d := importFastPDF(t, s, "overview-"+status)
			if _, err := s.documentCorpus(t.Context(), d.ID, nil); err != nil {
				t.Fatal(err)
			}
			_, _ = s.Store.DB.Exec("DELETE FROM document_corpus_jobs WHERE document_id=?", d.ID)
			p, err := s.Store.processing(d.ID)
			if err != nil {
				t.Fatal(err)
			}
			p.Status = status
			if err = s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan struct{})
			go func() { defer close(done); s.overviewWorker(ctx) }()
			defer func() { cancel(); <-done }()
			time.Sleep(1500 * time.Millisecond)
			var saved string
			if err = s.Store.DB.QueryRow("SELECT status FROM document_overview_jobs WHERE document_id=?", d.ID).Scan(&saved); err != nil {
				t.Fatal(err)
			}
			if saved != "queued" {
				t.Fatalf("automatic paid overview advanced before fine layout (%s): %s", status, saved)
			}
		})
	}
}
