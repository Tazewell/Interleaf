package interleaf

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const babeldocTestRequest = `{"layout":"translation-only","engine":"babeldoc"}`

func TestBabelDOCReadingPublishesMeasuredProgressWhileDetached(t *testing.T) {
	s := testServer(t)
	original := testPDF(1)
	mono := bytes.Replace(original, []byte("%PDF-1.4"), []byte("%PDF-1.5"), 1)
	seedBabelDOCReading(t, s, original, mono)
	bilingualConfig(t, s, "https://example.test/v1", "fixture-key", "openai")
	gate := filepath.Join(t.TempDir(), "release")
	t.Setenv("BABELDOC_READING_FIXTURE_PROGRESS", gate)
	const route = "/api/documents/doc/native-pdf-reading"
	w := request(t, s, "POST", route, strings.NewReader(babeldocTestRequest))
	if w.Code != http.StatusAccepted {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	accepted := bilingualJSON(t, w)
	progress, _ := accepted["progress"].(map[string]any)
	if progress["phase"] != "preparing" || progress["percent"] != nil || progress["remainingSeconds"] != nil {
		t.Fatalf("initial status reports progress the engine did not supply: %v", progress)
	}
	job := accepted["id"].(string)
	deadline := time.Now().Add(5 * time.Second)
	for {
		w = request(t, s, "GET", route+"/"+job, nil)
		state := bilingualJSON(t, w)
		progress, _ = state["progress"].(map[string]any)
		if state["status"] == "failed" || time.Now().After(deadline) {
			t.Fatalf("missing child progress after initial request completed: %v", state)
		}
		if progress["phase"] == "translation" && progress["percent"] == 53.0 {
			if w.Code != 200 || state["status"] != "running" || state["stage"] != "layout" ||
				progress["remainingSeconds"] == nil || strings.Contains(w.Body.String(), "private diagnostic") {
				t.Fatalf("progress or compatibility fields invalid: %v", state)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.WriteFile(gate, nil, 0600); err != nil {
		t.Fatal(err)
	}
	nativeReadingWaitJob(t, nativeReadingTestJob(t, s, job))
	w = request(t, s, "GET", route+"/"+job, nil)
	state := bilingualJSON(t, w)
	progress, _ = state["progress"].(map[string]any)
	if w.Code != 200 || state["status"] != "ready" || progress["percent"] != 100.0 || progress["remainingSeconds"] != nil {
		t.Fatalf("finished progress was not tied to publication: %v", state)
	}
}

func TestBabelDOCReadingWithoutInterleafAnalysis(t *testing.T) {
	s := testServer(t)
	original := testPDF(2)
	mono := bytes.Replace(original, []byte("%PDF-1.4"), []byte("%PDF-1.5"), 1)
	d := seedBabelDOCReading(t, s, original, mono)
	bilingualConfig(t, s, "https://example.test/v1", "fixture-key", "openai")

	const route = "/api/documents/doc/native-pdf-reading"
	w := request(t, s, "POST", route, strings.NewReader(babeldocTestRequest))
	if w.Code != http.StatusAccepted {
		t.Fatalf("create without layout or translations: %d %s", w.Code, w.Body.String())
	}
	job := bilingualJSON(t, w)["id"].(string)
	nativeReadingWaitJob(t, nativeReadingTestJob(t, s, job))
	w = request(t, s, "GET", route+"/"+job, nil)
	state := bilingualJSON(t, w)
	meta, _ := state["metadata"].(map[string]any)
	if w.Code != 200 || state["status"] != "ready" || meta["engine"] != "babeldoc" || meta["layout"] != "translation-only" {
		t.Fatalf("unexpected status: %d %v", w.Code, state)
	}
	pages := meta["pages"].([]any)
	if len(pages) != 2 || len(pages[0].(map[string]any)["paragraphs"].([]any)) != 0 {
		t.Fatalf("incorrect page geometry or fabricated paragraph mappings: %v", pages)
	}
	key := state["cacheKey"].(string)
	cached := request(t, s, "POST", route, strings.NewReader(babeldocTestRequest))
	if cached.Code != 200 || bilingualJSON(t, cached)["cacheKey"] != key {
		t.Fatalf("expected identical cached job: %d %s", cached.Code, cached.Body.String())
	}
	file := "/pub/test-secret/doc/native-pdf-reading/" + key + "/file"
	if w = request(t, s, "GET", file, nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), mono) {
		t.Fatalf("expected exact translated PDF from publication route: %d", w.Code)
	}
	if w = request(t, s, "GET", strings.Replace(file, "test-secret", "wrong", 1), nil); w.Code != 401 {
		t.Fatalf("publication route leaked cache: %d", w.Code)
	}
	source, err := os.ReadFile(s.Store.File(d))
	if err != nil || !bytes.Equal(source, original) {
		t.Fatal("reader changed the original PDF")
	}
	bilingualConfig(t, s, "https://example.test/changed", "fixture-key", "openai")
	if w = request(t, s, "GET", file, nil); w.Code != 409 {
		t.Fatalf("wrong endpoint reused a cached translation: %d", w.Code)
	}
}

func TestBabelDOCReadingInvalidOutputsNeverBecomeReadable(t *testing.T) {
	s := testServer(t)
	seedBabelDOCReading(t, s, testPDF(2), testPDF(1))
	bilingualConfig(t, s, "https://example.test/v1", "fixture-key", "openai")
	const route = "/api/documents/doc/native-pdf-reading"
	w := request(t, s, "POST", route, strings.NewReader(babeldocTestRequest))
	if w.Code != 202 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	job := bilingualJSON(t, w)["id"].(string)
	nativeReadingWaitJob(t, nativeReadingTestJob(t, s, job))
	w = request(t, s, "GET", route+"/"+job, nil)
	status := bilingualJSON(t, w)
	if w.Code != 200 || status["status"] != "failed" || status["metadata"] != nil {
		t.Fatalf("page-mismatched PDF was accepted: %d %v", w.Code, status)
	}
}

func TestBabelDOCReadingRejectsAmbiguousEngines(t *testing.T) {
	s := testServer(t)
	for _, body := range []string{
		`{"engine":"unknown","layout":"translation-only"}`,
		`{"engine":null,"layout":"translation-only"}`,
		`{"engine":"babeldoc","layout":"side-by-side"}`,
	} {
		w := request(t, s, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(body))
		if w.Code != 400 {
			t.Errorf("%s: %d %s", body, w.Code, w.Body.String())
		}
	}
}

func seedBabelDOCReading(t *testing.T, s *Server, original, mono []byte) Document {
	t.Helper()
	_, err := s.Store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library) VALUES('doc','pdf','Paper','Ada',?,?,?,'papers')`, len(original), now(), now())
	if err != nil {
		t.Fatal(err)
	}
	d, err := s.Store.Document("doc")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(s.Store.File(d), original, 0600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(t.TempDir(), "fixture.pdf")
	if err = os.WriteFile(output, mono, 0600); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("INTERLEAF_BABELDOC_EXECUTABLE", exe)
	t.Setenv("BABELDOC_READING_FIXTURE_OUTPUT", output)
	t.Setenv("INTERLEAF_TOKEN", "private-library-capability")
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	return d
}

func runBabelDOCReadingFixture(output string) int {
	if !slices.Contains(os.Args, "--openai") ||
		os.Getenv("PDF2ZH_OPENAI_API_KEY") != "fixture-key" ||
		os.Getenv("PDF2ZH_OPENAI_MODEL") != "frozen-model" ||
		os.Getenv("INTERLEAF_TOKEN") != "" {
		return 91
	}
	if gate := os.Getenv("BABELDOC_READING_FIXTURE_PROGRESS"); gate != "" {
		if os.Getenv("TTY_COMPATIBLE") != "1" || os.Getenv("TTY_INTERACTIVE") != "1" {
			return 96
		}
		fmt.Fprint(os.Stdout, "INFO private diagnostic: not a progress event\n",
			"Translate Paragraphs (1/1) ------ 12/26 0:00:08 0:00:20\r\n",
			"translate --------------------- 53/100 0:00:17 0:00:21\r\n")
		deadline := time.Now().Add(6 * time.Second)
		for {
			if _, err := os.Stat(gate); err == nil {
				break
			}
			if time.Now().After(deadline) {
				return 97
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	outIndex, langIndex := slices.Index(os.Args, "--output"), slices.Index(os.Args, "--lang-out")
	if outIndex < 0 || langIndex < 0 || outIndex+1 == len(os.Args) || langIndex+1 == len(os.Args) {
		return 92
	}
	data, err := os.ReadFile(output)
	if err != nil {
		return 93
	}
	name := "original.no_watermark." + os.Args[langIndex+1] + ".mono.pdf"
	if err = os.WriteFile(filepath.Join(os.Args[outIndex+1], name), data, 0600); err != nil {
		return 94
	}
	return 0
}
