package interleaf

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func nativeReadingTestJob(t *testing.T, s *Server, jobID string) *nativeReadingJob {
	t.Helper()
	s.nativeReadingMu.Lock()
	j := s.nativeReadingJobs[jobID]
	s.nativeReadingMu.Unlock()
	if j == nil {
		t.Fatalf("missing reading job %s", jobID)
	}
	return j
}

func nativeReadingWaitJob(t *testing.T, j *nativeReadingJob) {
	t.Helper()
	select {
	case <-j.done:
	case <-time.After(5 * time.Second):
		t.Fatal("reading task did not finish")
	}
}

func TestNativePDFReadingReportsChildProgressBeforeCompletion(t *testing.T) {
	s := nativeReadingFixture(t)
	gate := t.TempDir()
	t.Setenv("INTERLEAF_READING_TEST_GATE", gate)
	script := filepath.Join(filepath.Dir(os.Getenv("INTERLEAF_PROCESSOR")), "bilingual-pdf-cli.mjs")
	raw, e := os.ReadFile(script)
	if e != nil {
		t.Fatal(e)
	}
	prefix := `if(process.argv.includes('render')) {
 const fs=await import('node:fs'),gate=process.env.INTERLEAF_READING_TEST_GATE;
 console.log(JSON.stringify({stage:'layout',done:1,total:2}));
 fs.writeFileSync(gate+'/entered','');
 while(!fs.existsSync(gate+'/continue')) await new Promise(resolve=>setTimeout(resolve,10));
}
`
	if e = os.WriteFile(script, append([]byte(prefix), raw...), 0600); e != nil {
		t.Fatal(e)
	}
	defer os.WriteFile(filepath.Join(gate, "continue"), nil, 0600)
	v := nativeReadingCreate(t, s)
	jobID := v["id"].(string)
	deadline := time.Now().Add(5 * time.Second)
	progress := false
	for time.Now().Before(deadline) {
		w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/"+jobID, nil)
		if w.Code != 200 {
			t.Fatalf("poll %d %s", w.Code, w.Body.String())
		}
		v = bilingualJSON(t, w)
		if v["status"] == "failed" || v["status"] == "ready" {
			t.Fatalf("progress must arrive while child is blocked: %v", v)
		}
		if v["stage"] == "layout" && v["done"] == float64(1) && v["total"] == float64(2) {
			progress = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !progress {
		t.Fatalf("child progress never reached status: %v", v)
	}
	os.WriteFile(filepath.Join(gate, "continue"), nil, 0600)
	nativeReadingWaitJob(t, nativeReadingTestJob(t, s, jobID))
	w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/"+jobID, nil)
	v = bilingualJSON(t, w)
	if w.Code != 200 || v["status"] != "ready" || v["stage"] != "ready" || v["done"] != float64(2) || v["total"] != float64(2) {
		t.Fatalf("terminal progress regressed to child state: %d %v", w.Code, v)
	}
}

func TestNativePDFReadingTerminalJobsReleaseHeavySourceAndMetadata(t *testing.T) {
	for _, succeeds := range []bool{false, true} {
		t.Run(fmt.Sprint(succeeds), func(t *testing.T) {
			var s *Server
			if succeeds {
				s = nativeReadingFixture(t)
			} else {
				s = bilingualFixture(t)
			}
			v := nativeReadingCreate(t, s)
			j := nativeReadingTestJob(t, s, v["id"].(string))
			nativeReadingWaitJob(t, j)
			j.mu.Lock()
			defer j.mu.Unlock()
			if j.source != nil || j.cancel != nil || j.state.Metadata != nil {
				t.Fatal("terminal job retained full source, targets, translations, context or metadata")
			}
		})
	}
}

func TestNativePDFReadingTerminalStatusesRemainBoundedAcrossFailuresAndRevisions(t *testing.T) {
	for _, succeeds := range []bool{false, true} {
		t.Run(fmt.Sprint(succeeds), func(t *testing.T) {
			var s *Server
			if succeeds {
				s = nativeReadingFixture(t)
			} else {
				s = bilingualFixture(t)
			}
			var latest string
			for i := 0; i < 20; i++ {
				if succeeds {
					if e := s.saveTranslation("doc", TranslationBlock{BlockID: "p1-b1", SourceHash: translationHash("Hello world."), Status: "complete", Sentences: []TranslationSentence{{Source: "Hello world.", Target: fmt.Sprintf("译文 %d", i)}}}); e != nil {
						t.Fatal(e)
					}
				}
				v := nativeReadingCreate(t, s)
				latest = v["id"].(string)
				nativeReadingWaitJob(t, nativeReadingTestJob(t, s, latest))
			}
			s.nativeReadingMu.Lock()
			count := len(s.nativeReadingJobs)
			retained := s.nativeReadingJobs[latest] != nil
			s.nativeReadingMu.Unlock()
			if count > 16 || !retained {
				t.Fatalf("terminal status retention is unbounded or lost newest job: %d, latest %v", count, retained)
			}
		})
	}
}

func TestNativePDFReadingTerminalJobsEvictedOnDeleteAndCloseWithoutLosingPersistentCache(t *testing.T) {
	for _, action := range []string{"delete", "close"} {
		t.Run(action, func(t *testing.T) {
			s := nativeReadingFixture(t)
			v := nativeReadingReady(t, s)
			j := nativeReadingTestJob(t, s, v["id"].(string))
			nativeReadingWaitJob(t, j)
			if action == "delete" {
				w := request(t, s, "DELETE", "/api/documents/doc", nil)
				if w.Code != 204 {
					t.Fatalf("delete %d %s", w.Code, w.Body.String())
				}
			} else {
				s.Close()
			}
			s.nativeReadingMu.Lock()
			count := len(s.nativeReadingJobs)
			s.nativeReadingMu.Unlock()
			if count != 0 {
				t.Fatalf("%s retained %d terminal statuses", action, count)
			}
			if action == "close" {
				restarted := NewServer(s.Store, "test-secret", "")
				t.Cleanup(restarted.Close)
				t.Setenv("INTERLEAF_NODE", "")
				w := request(t, restarted, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{}`))
				if w.Code != 200 || bilingualJSON(t, w)["cacheKey"] != v["cacheKey"] {
					t.Fatalf("status eviction damaged persistent cache: %d %s", w.Code, w.Body.String())
				}
			}
		})
	}
}

func TestNativePDFReadingTerminalStatusExpiresWithoutRemovingDiskCache(t *testing.T) {
	s := nativeReadingFixture(t)
	v := nativeReadingReady(t, s)
	jobID := v["id"].(string)
	j := nativeReadingTestJob(t, s, jobID)
	nativeReadingWaitJob(t, j)
	j.mu.Lock()
	j.finishedAt = time.Now().Add(-31 * time.Minute)
	j.mu.Unlock()
	w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/"+jobID, nil)
	if w.Code != 404 {
		t.Fatalf("expired status retained: %d %s", w.Code, w.Body.String())
	}
	t.Setenv("INTERLEAF_NODE", "")
	w = request(t, s, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{}`))
	if w.Code != 200 || bilingualJSON(t, w)["cacheKey"] != v["cacheKey"] {
		t.Fatalf("status expiry damaged persistent cache: %d %s", w.Code, w.Body.String())
	}
}

func TestNativePDFReadingRequiresNoConfigAndDeduplicates(t *testing.T) {
	s := bilingualFixture(t)
	// Poison config: reading must never parse it.
	os.WriteFile(s.nativeAIPath(), []byte("invalid"), 0600)
	first := request(t, s, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{}`))
	if first.Code != 202 {
		t.Fatalf("create: %d %s", first.Code, first.Body.String())
	}
	second := request(t, s, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{}`))
	if second.Code != 202 || bilingualJSON(t, first)["id"] != bilingualJSON(t, second)["id"] {
		t.Fatalf("dedup: %d %s", second.Code, second.Body.String())
	}
	j := bilingualJSON(t, first)["id"].(string)
	cancelled := request(t, s, "DELETE", "/api/documents/doc/native-pdf-reading/"+j, nil)
	if cancelled.Code != 204 {
		t.Fatal(cancelled.Code)
	}
	s.Close()
}

func nativeReadingFixture(t *testing.T) *Server {
	t.Helper()
	s := bilingualFixture(t)
	p := filepath.Join(filepath.Dir(os.Getenv("INTERLEAF_PROCESSOR")), "bilingual-pdf-cli.mjs")
	raw, _ := os.ReadFile(p)
	script := string(raw) + `
if(args.stage==='render'&&args.reading==='true') {
 const prepared=JSON.parse(fs.readFileSync(args.prepared)),targets=JSON.parse(fs.readFileSync(args.targets));
 const pages=prepared.pages.map(p=>({page:p.page,width:p.width,height:p.height,outputWidth:args.mode==='translation-only'?p.width:2*p.width+12,translationOffsetX:args.mode==='translation-only'?0:p.width+12,paragraphs:p.paragraphs.map(q=>({id:q.id,blockId:q.blockId,sourceHash:crypto.createHash('sha256').update('zh-CN:v1:'+q.originalSource).digest('hex'),bounds:q.bounds,translated:!!targets[q.id],...(targets[q.id]?{target:targets[q.id]}:{})}))}));
 const all=pages.flatMap(p=>p.paragraphs);fs.writeFileSync(args['reading-metadata'],JSON.stringify({pages,translatedParagraphs:all.filter(q=>q.translated).length,originalParagraphs:all.filter(q=>!q.translated).length,warnings:[]}));
}
`
	if e := os.WriteFile(p, []byte(script), 0600); e != nil {
		t.Fatal(e)
	}
	v := TranslationBlock{BlockID: "p1-b1", SourceHash: translationHash("Hello world."), Status: "complete", Sentences: []TranslationSentence{{Source: "Hello world.", Target: "你好世界。"}}}
	if e := s.saveTranslation("doc", v); e != nil {
		t.Fatal(e)
	}
	// A corrupt existing native config must have no bearing on this path.
	os.WriteFile(s.nativeAIPath(), []byte("invalid config"), 0600)
	return s
}
func nativeReadingCreate(t *testing.T, s *Server) map[string]any {
	t.Helper()
	w := request(t, s, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{}`))
	if w.Code != 202 && w.Code != 200 {
		t.Fatalf("create %d %s", w.Code, w.Body.String())
	}
	return bilingualJSON(t, w)
}
func TestNativePDFReadingPrepareUsesReadingRecovery(t *testing.T) {
	s := nativeReadingFixture(t)
	p := filepath.Join(filepath.Dir(os.Getenv("INTERLEAF_PROCESSOR")), "bilingual-pdf-cli.mjs")
	raw, e := os.ReadFile(p)
	if e != nil {
		t.Fatal(e)
	}
	// A real ambiguous formula must opt into conservative reading preparation,
	// while the independent export path retains its strict default.
	raw = append(raw, []byte("\nif(args.stage==='prepare' && args.reading!=='true') throw new Error('reading preparation required');\n")...)
	if e = os.WriteFile(p, raw, 0600); e != nil {
		t.Fatal(e)
	}
	nativeReadingReady(t, s)
}
func nativeReadingReady(t *testing.T, s *Server) map[string]any {
	t.Helper()
	v := nativeReadingCreate(t, s)
	end := time.Now().Add(5 * time.Second)
	for v["status"] != "ready" && time.Now().Before(end) {
		if v["status"] == "failed" {
			t.Fatalf("failed %v", v)
		}
		time.Sleep(10 * time.Millisecond)
		w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/"+v["id"].(string), nil)
		if w.Code != 200 {
			t.Fatalf("poll %d %s", w.Code, w.Body.String())
		}
		v = bilingualJSON(t, w)
	}
	if v["status"] != "ready" {
		t.Fatal("not ready")
	}
	return v
}
func TestNativePDFReadingPersistentCacheAndAuthentication(t *testing.T) {
	s := nativeReadingFixture(t)
	before, _ := os.ReadFile(s.nativeAIPath())
	v := nativeReadingReady(t, s)
	key := v["cacheKey"].(string)
	entries, e := os.ReadDir(s.nativeReadingDir("doc", key))
	if e != nil || len(entries) != 2 {
		t.Fatalf("cache must contain only PDF and marker: %v %v", entries, e)
	}
	meta := v["metadata"].(map[string]any)
	if meta["translatedParagraphs"] != float64(1) || meta["originalParagraphs"] != float64(0) {
		t.Fatal(meta)
	}
	restarted := NewServer(s.Store, "test-secret", "")
	t.Cleanup(restarted.Close)
	// Disable processor: persistent hit cannot invoke subprocess or config parsing.
	t.Setenv("INTERLEAF_NODE", "")
	cached := request(t, restarted, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{}`))
	if cached.Code != 200 {
		t.Fatalf("restart %d %s", cached.Code, cached.Body.String())
	}
	base := "/api/documents/doc/native-pdf-reading/cache/" + key
	for _, path := range []string{base + "/metadata", base + "/file", "/pub/test-secret/doc/native-pdf-reading/" + key + "/file"} {
		w := request(t, restarted, "GET", path, nil)
		if w.Code != 200 {
			t.Fatalf("read %s: %d %s", path, w.Code, w.Body.String())
		}
	}
	for _, path := range []string{base + "/file", "/pub/wrong/doc/native-pdf-reading/" + key + "/file"} {
		r := httptest.NewRequest("GET", "http://127.0.0.1:17840"+path, nil)
		w := httptest.NewRecorder()
		restarted.Handler().ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("anonymous: %d", w.Code)
		}
	}
	after, _ := os.ReadFile(s.nativeAIPath())
	if string(before) != string(after) {
		t.Fatal("config was modified")
	}
	var count int
	s.Store.DB.QueryRow("SELECT count(*) FROM translations WHERE document_id='doc'").Scan(&count)
	if count != 1 {
		t.Fatal("translations changed")
	}
	var attachments int
	s.Store.DB.QueryRow("SELECT count(*) FROM documents").Scan(&attachments)
	if attachments != 1 {
		t.Fatal("attachment created")
	}
}
func TestNativePDFReadingInvalidationAndCorruption(t *testing.T) {
	for _, kind := range []string{"pdf", "layout", "translation", "missing-pdf", "corrupt-pdf", "missing-marker", "corrupt-marker"} {
		t.Run(kind, func(t *testing.T) {
			s := nativeReadingFixture(t)
			v := nativeReadingReady(t, s)
			key := v["cacheKey"].(string)
			dir := s.nativeReadingDir("doc", key)
			switch kind {
			case "pdf":
				d, _ := s.Store.Document("doc")
				os.WriteFile(s.Store.File(d), []byte("%PDF-changed"), 0600)
			case "layout":
				p := filepath.Join(s.analysisDir("doc"), "manifest.json")
				b, _ := os.ReadFile(p)
				os.WriteFile(p, append(b, ' '), 0600)
			case "translation":
				s.saveTranslation("doc", TranslationBlock{BlockID: "p1-b1", SourceHash: translationHash("Hello world."), Status: "complete", Sentences: []TranslationSentence{{Source: "Hello world.", Target: "另一译文"}}})
			case "missing-pdf":
				os.Remove(filepath.Join(dir, "reading.pdf"))
			case "corrupt-pdf":
				os.WriteFile(filepath.Join(dir, "reading.pdf"), []byte("%PDF-wrong"), 0600)
			case "missing-marker":
				os.Remove(filepath.Join(dir, "metadata.json"))
			case "corrupt-marker":
				os.WriteFile(filepath.Join(dir, "metadata.json"), []byte("{}"), 0600)
			}
			for _, suffix := range []string{"metadata", "file"} {
				w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/cache/"+key+"/"+suffix, nil)
				if w.Code != 409 {
					t.Fatalf("read %s: %d %s", suffix, w.Code, w.Body.String())
				}
			}
			w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/"+v["id"].(string), nil)
			if w.Code != 409 {
				t.Fatalf("poll %d", w.Code)
			}
			if strings.Contains(kind, "marker") || strings.Contains(kind, "-pdf") {
				next := nativeReadingCreate(t, s)
				if next["id"] == v["id"] {
					t.Fatal("corrupt cache deduped to old ready job")
				}
			}
		})
	}
}
func TestNativePDFReadingCancelDeleteCloseJoin(t *testing.T) {
	for _, action := range []string{"cancel", "delete", "close"} {
		t.Run(action, func(t *testing.T) {
			s := nativeReadingFixture(t)
			script := filepath.Join(filepath.Dir(os.Getenv("INTERLEAF_PROCESSOR")), "bilingual-pdf-cli.mjs")
			raw, _ := os.ReadFile(script)
			raw = append([]byte("await new Promise(resolve=>setTimeout(resolve,30000));\n"), raw...)
			os.WriteFile(script, raw, 0600)
			v := nativeReadingCreate(t, s)
			j := nativeReadingTestJob(t, s, v["id"].(string))
			j.mu.Lock()
			work := j.source.work
			j.mu.Unlock()
			start := time.Now()
			switch action {
			case "cancel":
				request(t, s, "DELETE", "/api/documents/doc/native-pdf-reading/"+v["id"].(string), nil)
			case "delete":
				w := request(t, s, "DELETE", "/api/documents/doc", nil)
				if w.Code != 204 {
					t.Fatalf("delete %d %s", w.Code, w.Body.String())
				}
			case "close":
				s.Close()
			}
			if time.Since(start) > 5*time.Second {
				t.Fatal("join too slow")
			}
			select {
			case <-j.done:
			default:
				t.Fatal("task not joined")
			}
			if _, e := os.Stat(work); !os.IsNotExist(e) {
				t.Fatalf("work retained: %v", e)
			}
			j.mu.Lock()
			retained := j.source != nil || j.state.Metadata != nil
			j.mu.Unlock()
			if retained {
				t.Fatal("cancelled task retained heavy state")
			}
			s.nativeReadingMu.Lock()
			count := len(s.nativeReadingJobs)
			s.nativeReadingMu.Unlock()
			if count != 0 {
				t.Fatalf("%s retained task status", action)
			}
			if _, e := os.Stat(filepath.Join(s.nativeReadingDir("doc", v["cacheKey"].(string)), "metadata.json")); !os.IsNotExist(e) {
				t.Fatal("cancelled task published marker")
			}
		})
	}
}

func TestNativePDFReadingPartialTargetsAndPreviousComplete(t *testing.T) {
	s := nativeReadingFixture(t)
	path := filepath.Join(s.analysisDir("doc"), "manifest.json")
	raw, _ := os.ReadFile(path)
	var manifest map[string]any
	json.Unmarshal(raw, &manifest)
	manifest["blocks"] = append(manifest["blocks"].([]any), map[string]any{"id": "p1-b2", "page": 1, "label": "text", "text": "Not translated."})
	raw, _ = json.Marshal(manifest)
	os.WriteFile(path, raw, 0600)
	ready := nativeReadingReady(t, s)
	m := ready["metadata"].(map[string]any)
	if m["translatedParagraphs"] != float64(1) || m["originalParagraphs"] != float64(1) {
		t.Fatal(m)
	}
	_, e := s.Store.DB.Exec(`INSERT INTO translation_previous(document_id,block_id,source_hash,body) SELECT document_id,block_id,source_hash,body FROM translations WHERE document_id='doc'`)
	if e != nil {
		t.Fatal(e)
	}
	s.saveTranslation("doc", TranslationBlock{BlockID: "p1-b1", SourceHash: translationHash("Hello world."), Status: "running", Sentences: []TranslationSentence{{Source: "Hello world.", Target: "partial"}}})
	cached := request(t, s, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{}`))
	if cached.Code != 200 || bilingualJSON(t, cached)["cacheKey"] != ready["cacheKey"] {
		t.Fatalf("visible previous complete lost %d %s", cached.Code, cached.Body.String())
	}
}
func TestNativePDFReadingChangedWhileRunningCannotPublish(t *testing.T) {
	s := nativeReadingFixture(t)
	script := filepath.Join(filepath.Dir(os.Getenv("INTERLEAF_PROCESSOR")), "bilingual-pdf-cli.mjs")
	raw, _ := os.ReadFile(script)
	os.WriteFile(script, append([]byte("await new Promise(resolve=>setTimeout(resolve,150));\n"), raw...), 0600)
	v := nativeReadingCreate(t, s)
	j := nativeReadingTestJob(t, s, v["id"].(string))
	s.saveTranslation("doc", TranslationBlock{BlockID: "p1-b1", SourceHash: translationHash("Hello world."), Status: "complete", Sentences: []TranslationSentence{{Source: "Hello world.", Target: "new translation"}}})
	select {
	case <-j.done:
	case <-time.After(5 * time.Second):
		t.Fatal("task did not exit")
	}
	if _, e := os.Stat(filepath.Join(s.nativeReadingDir("doc", v["cacheKey"].(string)), "metadata.json")); !os.IsNotExist(e) {
		t.Fatal("stale task published")
	}
}
func TestNativePDFReadingUnavailableTranslationHasRecoveryMessage(t *testing.T) {
	s := bilingualFixture(t)
	v := nativeReadingCreate(t, s)
	j := nativeReadingTestJob(t, s, v["id"].(string))
	select {
	case <-j.done:
	case <-time.After(5 * time.Second):
		t.Fatal("task did not exit")
	}
	w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/"+v["id"].(string), nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "可安全复用") {
		t.Fatalf("unhelpful error %d %s", w.Code, w.Body.String())
	}
}
func TestNativePDFReadingSlowDownloadDoesNotBlockClose(t *testing.T) {
	s := nativeReadingFixture(t)
	v := nativeReadingReady(t, s)
	slow := &bilingualSlowDownload{httptest.NewRecorder(), make(chan struct{}), make(chan struct{})}
	served := make(chan struct{})
	defer func() { close(slow.release); <-served }()
	req := httptest.NewRequest("GET", "http://127.0.0.1/api/documents/doc/native-pdf-reading/cache/"+v["cacheKey"].(string)+"/file", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	go func() { defer close(served); s.Handler().ServeHTTP(slow, req) }()
	select {
	case <-slow.entered:
	case <-time.After(time.Second):
		t.Fatal("download not started")
	}
	stopped := make(chan struct{})
	go func() { s.Close(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("download blocked close")
	}
}

func TestNativePDFReadingRejectsCorruptPersistentReports(t *testing.T) {
	cases := []struct {
		name   string
		change func(map[string]any)
	}{
		{"missing-report-hash", func(m map[string]any) { delete(m, "reportSha256") }},
		{"bad-report-hash", func(m map[string]any) { m["reportSha256"] = strings.Repeat("a", 64) }},
		{"changed-valid-bounds", func(m map[string]any) { nativeReadingMetadataParagraph(m)["bounds"].(map[string]any)["x"] = 20 }},
		{"absent-pages", func(m map[string]any) { delete(m, "pages") }},
		{"null-pages", func(m map[string]any) { m["pages"] = nil }},
		{"empty-pages", func(m map[string]any) { m["pages"] = []any{} }},
		{"wrong-page-count", func(m map[string]any) { m["pages"] = m["pages"].([]any)[:1] }},
		{"nonsequential-pages", func(m map[string]any) { m["pages"].([]any)[1].(map[string]any)["page"] = 1 }},
		{"bad-width", func(m map[string]any) { m["pages"].([]any)[0].(map[string]any)["width"] = 0 }},
		{"bad-height", func(m map[string]any) { m["pages"].([]any)[0].(map[string]any)["height"] = -1 }},
		{"bad-output-width", func(m map[string]any) { m["pages"].([]any)[0].(map[string]any)["outputWidth"] = 999 }},
		{"bad-offset", func(m map[string]any) { m["pages"].([]any)[0].(map[string]any)["translationOffsetX"] = 0 }},
		{"null-paragraphs", func(m map[string]any) { m["pages"].([]any)[0].(map[string]any)["paragraphs"] = nil }},
		{"bad-counts", func(m map[string]any) { m["translatedParagraphs"] = 99 }},
		{"negative-counts", func(m map[string]any) { m["originalParagraphs"] = -1 }},
		{"missing-warnings", func(m map[string]any) { delete(m, "warnings") }},
		{"bad-hash", func(m map[string]any) { nativeReadingMetadataParagraph(m)["sourceHash"] = strings.Repeat("a", 64) }},
		{"bad-target", func(m map[string]any) { nativeReadingMetadataParagraph(m)["target"] = "invented translation" }},
		{"bad-block", func(m map[string]any) { nativeReadingMetadataParagraph(m)["blockId"] = "unrelated" }},
		{"bad-bounds", func(m map[string]any) { nativeReadingMetadataParagraph(m)["bounds"].(map[string]any)["x"] = -1 }},
		{"outside-page", func(m map[string]any) { nativeReadingMetadataParagraph(m)["bounds"].(map[string]any)["width"] = 9000 }},
		{"duplicate-paragraph", func(m map[string]any) {
			p := m["pages"].([]any)[0].(map[string]any)
			p["paragraphs"] = append(p["paragraphs"].([]any), nativeReadingMetadataParagraph(m))
			m["translatedParagraphs"] = 2
		}},
		{"removed-paragraph", func(m map[string]any) {
			m["pages"].([]any)[0].(map[string]any)["paragraphs"] = []any{}
			m["translatedParagraphs"] = 0
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := nativeReadingFixture(t)
			v := nativeReadingReady(t, s)
			key := v["cacheKey"].(string)
			path := filepath.Join(s.nativeReadingDir("doc", key), "metadata.json")
			raw, e := os.ReadFile(path)
			if e != nil {
				t.Fatal(e)
			}
			var m map[string]any
			if json.Unmarshal(raw, &m) != nil {
				t.Fatal("invalid fixture")
			}
			tc.change(m)
			raw, _ = json.Marshal(m)
			// Recompute the checksum for structural cases to prove validation is
			// independent of the integrity stamp.
			switch tc.name {
			case "removed-paragraph", "changed-valid-bounds", "missing-report-hash", "bad-report-hash":
			default:
				var changed nativeReadingManifest
				if json.Unmarshal(raw, &changed) != nil {
					t.Fatal("invalid mutated fixture")
				}
				m["reportSha256"] = nativeReadingReportHash(changed.nativeReadingReport)
				raw, _ = json.Marshal(m)
			}
			if e = os.WriteFile(path, raw, 0600); e != nil {
				t.Fatal(e)
			}
			restarted := NewServer(s.Store, "test-secret", "")
			t.Cleanup(restarted.Close)
			for _, suffix := range []string{"metadata", "file"} {
				w := request(t, restarted, "GET", "/api/documents/doc/native-pdf-reading/cache/"+key+"/"+suffix, nil)
				if w.Code != 409 {
					t.Fatalf("corrupt %s accepted: %d %s", suffix, w.Code, w.Body.String())
				}
			}
			w := request(t, restarted, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{}`))
			if w.Code != 202 {
				t.Fatalf("corrupt cache did not rebuild: %d %s", w.Code, w.Body.String())
			}
			nativeReadingReady(t, restarted)
		})
	}
}
func nativeReadingMetadataParagraph(m map[string]any) map[string]any {
	return m["pages"].([]any)[0].(map[string]any)["paragraphs"].([]any)[0].(map[string]any)
}

func nativeReadingCreateLayout(t *testing.T, s *Server, layout string) map[string]any {
	t.Helper()
	w := request(t, s, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{"layout":"`+layout+`"}`))
	if w.Code != 202 && w.Code != 200 {
		t.Fatalf("layout create %d %s", w.Code, w.Body.String())
	}
	return bilingualJSON(t, w)
}
func nativeReadingReadyLayout(t *testing.T, s *Server, layout string) map[string]any {
	t.Helper()
	v := nativeReadingCreateLayout(t, s, layout)
	if v["status"] != "ready" {
		nativeReadingWaitJob(t, nativeReadingTestJob(t, s, v["id"].(string)))
		w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/"+v["id"].(string), nil)
		if w.Code != 200 {
			t.Fatalf("poll %d %s", w.Code, w.Body.String())
		}
		v = bilingualJSON(t, w)
	}
	if v["status"] != "ready" {
		t.Fatalf("not ready %v", v)
	}
	return v
}
func TestNativePDFReadingLayoutCacheIsolationAndLegacy(t *testing.T) {
	s := nativeReadingFixture(t)
	legacy := nativeReadingReady(t, s)
	// Simulate a completed pre-layout manifest, keeping its historical identity and report hash.
	legacyPath := filepath.Join(s.nativeReadingDir("doc", legacy["cacheKey"].(string)), "metadata.json")
	legacyRaw, _ := os.ReadFile(legacyPath)
	var legacyMetadata map[string]any
	json.Unmarshal(legacyRaw, &legacyMetadata)
	delete(legacyMetadata, "layout")
	legacyRaw, _ = json.Marshal(legacyMetadata)
	os.WriteFile(legacyPath, legacyRaw, 0600)
	single := nativeReadingReadyLayout(t, s, "translation-only")
	if legacy["cacheKey"] == single["cacheKey"] {
		t.Fatal("cache collision")
	}
	m := single["metadata"].(map[string]any)
	if m["layout"] != "translation-only" || m["rendererVersion"] == legacy["metadata"].(map[string]any)["rendererVersion"] {
		t.Fatal("layout identity missing")
	}
	for _, p := range m["pages"].([]any) {
		p := p.(map[string]any)
		if p["outputWidth"] != p["width"] || p["translationOffsetX"] != float64(0) {
			t.Fatal("single geometry", p)
		}
	}
	snap, e := s.nativeReadingSnapshot("doc")
	if e != nil {
		t.Fatal(e)
	}
	expected := sourceKey(snap.originalHash + ":" + snap.layoutHash + ":" + snap.translationHash + ":" + nativeReadingVersion)
	if legacy["cacheKey"] != expected {
		t.Fatal("legacy key changed")
	}
	restarted := NewServer(s.Store, "test-secret", "")
	t.Cleanup(restarted.Close)
	t.Setenv("INTERLEAF_NODE", "")
	for _, layout := range []string{"side-by-side", "translation-only"} {
		w := request(t, restarted, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(`{"layout":"`+layout+`"}`))
		if w.Code != 200 {
			t.Fatalf("persistent %s %d %s", layout, w.Code, w.Body.String())
		}
	}
	for _, v := range []map[string]any{legacy, single} {
		for _, suffix := range []string{"metadata", "file"} {
			w := request(t, restarted, "GET", "/api/documents/doc/native-pdf-reading/cache/"+v["cacheKey"].(string)+"/"+suffix, nil)
			if w.Code != 200 {
				t.Fatalf("cache %d %s", w.Code, w.Body.String())
			}
		}
	}
}
func TestNativePDFReadingLayoutRejectsUnknown(t *testing.T) {
	s := nativeReadingFixture(t)
	for _, body := range []string{`{"layout":"other"}`, `{"layout":""}`, `{"layout":null}`, `{"layout":42}`, `{"mode":"translation-only"}`} {
		w := request(t, s, "POST", "/api/documents/doc/native-pdf-reading", strings.NewReader(body))
		if w.Code != 400 {
			t.Fatalf("accepted %s: %d %s", body, w.Code, w.Body.String())
		}
	}
}
func TestNativePDFReadingLayoutConcurrentCancelIsolation(t *testing.T) {
	s := nativeReadingFixture(t)
	script := filepath.Join(filepath.Dir(os.Getenv("INTERLEAF_PROCESSOR")), "bilingual-pdf-cli.mjs")
	raw, _ := os.ReadFile(script)
	os.WriteFile(script, append([]byte("await new Promise(resolve=>setTimeout(resolve,150));\n"), raw...), 0600)
	left := nativeReadingCreate(t, s)
	single := nativeReadingCreateLayout(t, s, "translation-only")
	duplicate := nativeReadingCreateLayout(t, s, "translation-only")
	if left["id"] == single["id"] || left["cacheKey"] == single["cacheKey"] || single["id"] != duplicate["id"] {
		t.Fatal("job collision")
	}
	w := request(t, s, "DELETE", "/api/documents/doc/native-pdf-reading/"+single["id"].(string), nil)
	if w.Code != 204 {
		t.Fatal(w.Code)
	}
	nativeReadingWaitJob(t, nativeReadingTestJob(t, s, left["id"].(string)))
	w = request(t, s, "GET", "/api/documents/doc/native-pdf-reading/"+left["id"].(string), nil)
	if w.Code != 200 || bilingualJSON(t, w)["status"] != "ready" {
		t.Fatalf("other layout cancelled %d %s", w.Code, w.Body.String())
	}
	if _, e := os.Stat(filepath.Join(s.nativeReadingDir("doc", single["cacheKey"].(string)), "metadata.json")); !os.IsNotExist(e) {
		t.Fatal("cancelled layout published")
	}
}
func TestNativePDFReadingLayoutRejectsMixedMetadata(t *testing.T) {
	for _, kind := range []string{"missing-layout", "other-layout", "unknown-layout", "empty-layout", "null-layout", "renderer", "geometry"} {
		t.Run(kind, func(t *testing.T) {
			s := nativeReadingFixture(t)
			v := nativeReadingReadyLayout(t, s, "translation-only")
			key := v["cacheKey"].(string)
			path := filepath.Join(s.nativeReadingDir("doc", key), "metadata.json")
			raw, _ := os.ReadFile(path)
			var m map[string]any
			json.Unmarshal(raw, &m)
			switch kind {
			case "missing-layout":
				delete(m, "layout")
			case "other-layout":
				m["layout"] = "side-by-side"
			case "unknown-layout":
				m["layout"] = "other"
			case "empty-layout":
				m["layout"] = ""
			case "null-layout":
				m["layout"] = nil
			case "renderer":
				m["rendererVersion"] = nativeReadingVersion
			case "geometry":
				p := m["pages"].([]any)[0].(map[string]any)
				p["outputWidth"] = 2*p["width"].(float64) + 12
				p["translationOffsetX"] = p["width"].(float64) + 12
			}
			raw, _ = json.Marshal(m)
			var changed nativeReadingManifest
			json.Unmarshal(raw, &changed)
			m["reportSha256"] = nativeReadingReportHash(changed.nativeReadingReport)
			raw, _ = json.Marshal(m)
			os.WriteFile(path, raw, 0600)
			for _, suffix := range []string{"metadata", "file"} {
				w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/cache/"+key+"/"+suffix, nil)
				if w.Code != 409 {
					t.Fatalf("mixed %s %d %s", kind, w.Code, w.Body.String())
				}
			}
			w := request(t, s, "GET", "/api/documents/doc/native-pdf-reading/"+v["id"].(string), nil)
			if w.Code != 409 {
				t.Fatal("mixed status accepted")
			}
		})
	}
}

func TestNativePDFReadingLayoutsNeverCallModelOrMutateInputs(t *testing.T) {
	s := nativeReadingFixture(t)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer provider.Close()
	os.Remove(s.nativeAIPath()) // Replace the fixture's intentionally corrupt configuration with a counted provider.
	bilingualConfig(t, s, provider.URL, "secret", "openai")
	d, _ := s.Store.Document("doc")
	original, _ := os.ReadFile(s.Store.File(d))
	config, _ := os.ReadFile(s.nativeAIPath())
	before, _ := s.visibleTranslations("doc", layoutManifest{Pages: 2, Blocks: []PDFBlock{{ID: "p1-b1", Page: 1, Text: "Hello world."}}})
	beforeRaw, _ := json.Marshal(before)
	nativeReadingReady(t, s)
	nativeReadingReadyLayout(t, s, "translation-only")
	if calls.Load() != 0 {
		t.Fatal("reading called provider", calls.Load())
	}
	actual, _ := os.ReadFile(s.Store.File(d))
	actualConfig, _ := os.ReadFile(s.nativeAIPath())
	after, _ := s.visibleTranslations("doc", layoutManifest{Pages: 2, Blocks: []PDFBlock{{ID: "p1-b1", Page: 1, Text: "Hello world."}}})
	afterRaw, _ := json.Marshal(after)
	if string(original) != string(actual) || string(config) != string(actualConfig) || string(beforeRaw) != string(afterRaw) {
		t.Fatal("reading modified original, configuration or translations")
	}
}

func TestNativePDFReadingLayoutRejectsWrongRendererGeometry(t *testing.T) {
	for _, layout := range []string{"side-by-side", "translation-only"} {
		t.Run(layout, func(t *testing.T) {
			s := nativeReadingFixture(t)
			script := filepath.Join(filepath.Dir(os.Getenv("INTERLEAF_PROCESSOR")), "bilingual-pdf-cli.mjs")
			raw, _ := os.ReadFile(script)
			raw = append(raw, []byte(`
if(args.stage==='render'&&args.reading==='true') {
 const report=JSON.parse(fs.readFileSync(args['reading-metadata']));
 for(const p of report.pages) {p.outputWidth=args.mode==='translation-only'?2*p.width+12:p.width;p.translationOffsetX=args.mode==='translation-only'?p.width+12:0;}
 fs.writeFileSync(args['reading-metadata'],JSON.stringify(report));
}
`)...)
			os.WriteFile(script, raw, 0600)
			v := nativeReadingCreateLayout(t, s, layout)
			j := nativeReadingTestJob(t, s, v["id"].(string))
			nativeReadingWaitJob(t, j)
			if j.snapshot().Status != "failed" {
				t.Fatal("wrong-layout renderer report accepted")
			}
			if _, e := os.Stat(filepath.Join(s.nativeReadingDir("doc", v["cacheKey"].(string)), "metadata.json")); !os.IsNotExist(e) {
				t.Fatal("invalid layout published")
			}
		})
	}
}
