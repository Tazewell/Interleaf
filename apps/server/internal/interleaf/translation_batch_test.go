package interleaf

import (
	"bufio"
	"context"
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

func configureTranslationTest(t *testing.T, s *Server, url string) {
	t.Helper()
	configureNativeTest(t, s, url, "test", false)
}
func translationParagraphLine(p translationParagraph) string {
	data, _ := json.Marshal(map[string]any{"blockId": p.BlockID, "sourceHash": p.SourceHash, "sentences": []TranslationSentence{{Source: p.Source, Target: "译文。"}}})
	return string(data) + "\n"
}
func translationLine(b PDFBlock) string {
	return translationParagraphLine(translationParagraph{b.ID, translationHash(translationSource(b)), translationSource(b)})
}

type translationTestInput struct {
	Title       string           `json:"title"`
	Author      string           `json:"author"`
	FrontMatter []string         `json:"frontMatter"`
	Batch       translationBatch `json:"batch"`
}

func readTranslationInput(t *testing.T, r *http.Request) translationTestInput {
	t.Helper()
	var request struct {
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		t.Error(err)
		return translationTestInput{}
	}
	prompt := request.Messages[len(request.Messages)-1].Content
	_, raw, ok := strings.Cut(prompt, "输入资料：\n")
	if !ok {
		t.Error("missing batch input")
		return translationTestInput{}
	}
	var input translationTestInput
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		t.Error(err)
	}
	return input
}
func TestTranslationBatchBoundariesAndContext(t *testing.T) {
	m := layoutManifest{}
	for i, source := range []string{"一二三四五六七", "八九十甲乙丙丁", "第三段", "第四段", "第五段"} {
		m.Blocks = append(m.Blocks, PDFBlock{ID: fmt.Sprintf("p1-b%d", i+1), Page: 1, Label: "text", Text: source})
	}
	items := []TranslationBlock{}
	for _, b := range m.Blocks {
		items = append(items, newTranslation(b))
	}
	batches := translationBatches(m, items, 10)
	if len(batches) != 2 || len(batches[0].Paragraphs) != 2 || batches[0].Paragraphs[1].Source != "八九十甲乙丙丁" {
		t.Fatalf("split paragraph or counted UTF-8 bytes: %+v", batches)
	}
	if len(batches[0].After) != 2 || len(batches[1].Before) != 2 {
		t.Fatalf("missing context: %+v", batches)
	}
	items[0].Status = "complete"
	retry := translationBatches(m, items, 10)
	if len(retry[0].Paragraphs) != 1 || retry[0].Paragraphs[0].BlockID != m.Blocks[1].ID || retry[0].After[0].BlockID != m.Blocks[2].ID {
		t.Fatal("retry changed boundaries or regenerated completed text")
	}
	prompt := translationPrompt(Document{Title: "论文标题", Author: "作者"}, m, batches[0], "")
	if !strings.Contains(prompt, `"title":"论文标题"`) || !strings.Contains(prompt, `"author":"作者"`) {
		t.Fatal("metadata not attached")
	}
}
func TestTranslationJSONLPublishesOnlyCompleteValidatedLines(t *testing.T) {
	p := translationParagraph{"p1-b1", "version", "Sentence."}
	var saved []TranslationBlock
	d := newTranslationJSONL(translationBatch{Paragraphs: []translationParagraph{p}}, func(b TranslationBlock) error { saved = append(saved, b); return nil })
	line := translationParagraphLine(p)
	for _, chunk := range []string{`{"oops":`, "\n", strings.Replace(line, "version", "wrong", 1), strings.Replace(line, "p1-b1", "p1-b9", 1), line[:len(line)-1]} {
		if err := d.feed(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if len(saved) != 0 {
		t.Fatal("published invalid or incomplete line")
	}
	if err := d.feed("\n" + line); err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 || saved[0].BlockID != p.BlockID {
		t.Fatalf("line not published immediately or duplicate overwritten: %+v", saved)
	}
}
func sendTranslationDelta(w http.ResponseWriter, text string) {
	data, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": text}}}})
	fmt.Fprintf(w, "data: %s\n\n", data)
	w.(http.Flusher).Flush()
}
func finishTranslationStream(w http.ResponseWriter) {
	fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	w.(http.Flusher).Flush()
}
func waitTranslationSignal(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case id := <-ch:
		return id
	case <-time.After(10 * time.Second):
		t.Fatal("timed out")
		return ""
	}
}
func TestTranslationRunsThreeBatchesAndWaitsForProviderCompletion(t *testing.T) {
	s, p, m := translationFixture(t)
	m.Blocks = append(m.Blocks, m.Blocks[1], m.Blocks[1])
	m.Blocks[2].ID = "p1-b3"
	m.Blocks[3].ID = "p1-b4"
	for i := range m.Blocks {
		m.Blocks[i].Text = strings.Repeat(fmt.Sprintf("段%d", i), 5001)
	}
	started := make(chan string, 4)
	released := make(chan struct{})
	defer close(released)
	var active, maxActive atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[]}`))
			return
		}
		batch := readTranslationInput(t, r).Batch
		n := active.Add(1)
		defer active.Add(-1)
		for old := maxActive.Load(); n > old; old = maxActive.Load() {
			if maxActive.CompareAndSwap(old, n) {
				break
			}
		}
		started <- batch.Paragraphs[0].BlockID
		w.Header().Set("Content-Type", "text/event-stream")
		sendTranslationDelta(w, translationParagraphLine(batch.Paragraphs[0]))
		select {
		case <-released:
		case <-r.Context().Done():
			return
		}
		finishTranslationStream(w)
	}))
	// Close release before the HTTP server so blocked handlers cannot hang cleanup.
	t.Cleanup(provider.Close)
	configureTranslationTest(t, s, provider.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.settleTranslations(ctx, &p, m) }()
	first, second, third := waitTranslationSignal(t, started), waitTranslationSignal(t, started), waitTranslationSignal(t, started)
	if first == second || first == third || second == third || first == "p1-b4" || second == "p1-b4" || third == "p1-b4" {
		t.Fatalf("bad batch scheduling: %s %s %s", first, second, third)
	}

	// Give the decoder time to receive the flushed complete JSONL rows while all
	// three requests remain gated before their successful terminal events.
	time.Sleep(100 * time.Millisecond)
	items, err := s.translations("doc", m)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.Status == "complete" {
			t.Errorf("published before provider completion: %+v", item)
		}
	}
	select {
	case <-started:
		t.Fatal("started a fourth concurrent batch")
	default:
	}
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("workers ignored cancellation")
	}
	items, err = s.translations("doc", m)
	if err != nil {
		t.Fatal(err)
	}
	if maxActive.Load() != 3 {
		t.Fatalf("concurrency=%d", maxActive.Load())
	}
	for _, item := range items {
		if item.Status != "pending" {
			t.Errorf("canceled row was published: %+v", item)
		}
	}
	saved, err := s.Store.processing("doc")
	if err != nil || saved.Phase != "translating" || saved.TranslationsDone != 0 || saved.TranslationsTotal != 4 {
		t.Fatalf("canceled draft became progress: %+v, %v", saved, err)
	}

}
func TestTranslationSubscriptionSnapshotAndLiveLine(t *testing.T) {
	s, _, m := translationFixture(t)
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/documents/doc/translations/stream", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	scan := bufio.NewScanner(res.Body)
	next := func() string {
		t.Helper()
		for scan.Scan() {
			if strings.HasPrefix(scan.Text(), "data: ") {
				return strings.TrimPrefix(scan.Text(), "data: ")
			}
		}
		t.Fatalf("stream ended: %v", scan.Err())
		return ""
	}
	if !strings.Contains(next(), `"pending"`) {
		t.Fatal("missing initial snapshot")
	}
	t1 := newTranslation(m.Blocks[0])
	t1.Status = "complete"
	t1.Sentences = []TranslationSentence{{Source: m.Blocks[0].Text, Target: "译文"}}
	if err = s.saveTranslation("doc", t1); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(next(), `"complete"`) {
		t.Fatal("saved line not pushed")
	}
	cancel()
	res.Body.Close()
	req, _ = http.NewRequest("GET", server.URL+"/api/documents/doc/translations/stream", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	scan = bufio.NewScanner(res.Body)
	if !strings.Contains(next(), `"complete"`) {
		t.Fatal("reconnect lost committed paragraph")
	}
}
func TestTranslationTruncatedBatchRetriesAllUncommittedRows(t *testing.T) {
	s, p, m := translationFixture(t)
	sentinel := m.Blocks[1]
	sentinel.ID = "p1-b3"
	m.Blocks = append(m.Blocks, sentinel)
	if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(m)), 0600); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[]}`))
			return
		}
		batch := readTranslationInput(t, r).Batch
		w.Header().Set("Content-Type", "text/event-stream")
		n := calls.Add(1)
		if n == 1 {
			if len(batch.Paragraphs) != 1 || batch.Paragraphs[0].BlockID != sentinel.ID {
				t.Errorf("wrong completed batch: %+v", batch.Paragraphs)
			}
			sendTranslationDelta(w, translationParagraphLine(batch.Paragraphs[0]))
			finishTranslationStream(w)
			return
		}
		if n == 2 {
			sendTranslationDelta(w, translationParagraphLine(batch.Paragraphs[0]))
			tail := translationParagraphLine(batch.Paragraphs[1])
			sendTranslationDelta(w, tail[:len(tail)/2])
			return // Upstream disconnects without a successful terminal event.
		}
		if len(batch.Paragraphs) != 2 {
			t.Errorf("retry omitted uncommitted row: %+v", batch.Paragraphs)
		}
		for _, row := range batch.Paragraphs {
			sendTranslationDelta(w, translationParagraphLine(row))
		}
		finishTranslationStream(w)
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	doc, err := s.Store.Document("doc")
	if err != nil {
		t.Fatal(err)
	}
	source := translationParagraph{sentinel.ID, translationHash(translationSource(sentinel)), translationSource(sentinel)}
	if err := s.translateBatch(t.Context(), doc, m, translationBatch{Paragraphs: []translationParagraph{source}}, s.currentGenerationService(taskTranslation), func() {}); err != nil {
		t.Fatal(err)
	}
	before, err := s.translations("doc", m)
	if err != nil {
		t.Fatal(err)
	}
	if before[2].Status != "complete" {
		t.Fatal("first batch not committed")
	}

	if err := s.settleTranslations(context.Background(), &p, m); err == nil {
		t.Fatal("truncated batch reported complete")
	}
	items, err := s.translations("doc", m)
	if err != nil {
		t.Fatal(err)
	}
	if items[0].Status != "failed" || items[1].Status != "failed" {
		t.Fatalf("truncated rows published: %+v", items)
	}
	p.Status = "failed"
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	if res := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{}`)); res.Code != 202 {
		t.Fatal(res.Body.String())
	}
	configureTranslationTest(t, s, provider.URL)
	if err := s.settleTranslations(context.Background(), &p, m); err != nil {
		t.Fatal(err)
	}
	items, err = s.translations("doc", m)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 || items[0].Status != "complete" || items[1].Status != "complete" {
		t.Fatal("resume failed")
	}
	if jsonText(items[2]) != jsonText(before[2]) {
		t.Fatal("previous completed batch changed")
	}
}
func TestTranslationDeadlineDoesNotChangeChatDeadline(t *testing.T) {
	for _, timeout := range []time.Duration{0, translationBatchTimeout} {
		service := &GenerationService{primary: "api", timeout: timeout, connections: map[string]generationConnection{}}
		service.connections["api"] = generationConnection{VerifiedText: true, Adapter: adapterFunc(func(ctx context.Context, _ GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
			deadline, ok := ctx.Deadline()
			want := timeout
			if want == 0 {
				want = 3 * time.Minute
			}
			if !ok || time.Until(deadline) > want || time.Until(deadline) < want-time.Second {
				t.Errorf("unexpected timeout: %v", time.Until(deadline))
			}
			if err := emit(ProviderEvent{Text: "ok"}); err != nil {
				return GenerateResult{}, err
			}
			return GenerateResult{Text: "ok", FinishReason: "stop"}, nil
		})}
		if _, err := service.Generate(context.Background(), AIInput{}, false, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTranslationJSONLRepairsUnescapedLatexBackslashes(t *testing.T) {
	p := translationParagraph{"p1-b2", "h2", "Two."}
	var got TranslationBlock
	d := newTranslationJSONL(translationBatch{Paragraphs: []translationParagraph{p}}, func(block TranslationBlock) error {
		got = block
		return nil
	})
	line := `{"blockId":"p1-b2","sourceHash":"h2","sentences":[{"source":"Two.","target":"$\pi$、$\eta$、$\ll$、$\log n$"}]}`
	if err := d.feed(line + "\n"); err != nil {
		t.Fatal(err)
	}
	if !d.completed[p.BlockID] || len(got.Sentences) != 1 || got.Sentences[0].Target != `$\pi$、$\eta$、$\ll$、$\log n$` {
		t.Fatalf("unescaped LaTeX was not repaired: decoder=%+v block=%+v", d, got)
	}
}

func TestRepairInvalidJSONEscapesPreservesValidEscapesAndOutsideText(t *testing.T) {
	valid := `{"target":"quote: \" newline: \n unicode: \u03c0 slash: \\ solidus: \/"}`
	if got, changed := repairInvalidJSONEscapes(valid); changed || got != valid {
		t.Fatalf("valid JSON changed: changed=%v %q", changed, got)
	}
	broken := `{"target":"$\pi$"}\tail`
	want := `{"target":"$\\pi$"}\tail`
	if got, changed := repairInvalidJSONEscapes(broken); !changed || got != want {
		t.Fatalf("wrong repair: changed=%v got=%q want=%q", changed, got, want)
	}
}

func TestTranslationJSONLNamesStructurallyBrokenLines(t *testing.T) {
	a, b := translationParagraph{"p1-b1", "h1", "One."}, translationParagraph{"p1-b2", "h2", "Two."}
	d := newTranslationJSONL(translationBatch{Paragraphs: []translationParagraph{a, b}}, func(TranslationBlock) error { return nil })
	for _, line := range []string{"```jsonl", `{"blockId":"p1-b2","sourceHash":"h2","sentences":`, translationParagraphLine(a)} {
		if err := d.feed(strings.TrimSuffix(line, "\n") + "\n"); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.HasPrefix(d.invalid["p1-b2"], "第 2 行不是合法的 JSON") || d.malformed != 1 || !strings.HasPrefix(d.firstMalformed, "第 1 行") || !d.completed["p1-b1"] {
		t.Fatalf("broken lines not attributed: %+v %d %q", d.invalid, d.malformed, d.firstMalformed)
	}
}
func TestTranslationAsksOnceMoreForParagraphsTheModelSkipped(t *testing.T) {
	s, p, m := translationFixture(t)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[]}`))
			return
		}
		batch := readTranslationInput(t, r).Batch
		if calls.Add(1) == 2 && (len(batch.Paragraphs) != 1 || batch.Paragraphs[0].BlockID != m.Blocks[1].ID) {
			t.Errorf("follow-up did not ask for the skipped paragraph only: %+v", batch.Paragraphs)
		}
		// The model ends normally after the first paragraph it was given.
		writeAPIReply(w, translationParagraphLine(batch.Paragraphs[0]))
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	if err := s.settleTranslations(context.Background(), &p, m); err != nil {
		t.Fatal(err)
	}
	items, _ := s.translations("doc", m)
	if calls.Load() != 2 || items[0].Status != "complete" || items[1].Status != "complete" {
		t.Fatalf("skipped paragraph not recovered: calls=%d %+v", calls.Load(), items)
	}
	if _, err := os.Stat(filepath.Join(s.Store.Root, "cache", "doc", "translation-failures")); !os.IsNotExist(err) {
		t.Fatal("recorded a failure for a recovered batch")
	}
}
func TestTranslationFailureNamesTheCauseAndKeepsTheOutput(t *testing.T) {
	s, p, m := translationFixture(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[]}`))
			return
		}
		batch := readTranslationInput(t, r).Batch
		text := "not json at all\n"
		if len(batch.Paragraphs) == 2 {
			text = translationParagraphLine(batch.Paragraphs[0])
		}
		writeAPIReply(w, text)
	}))
	defer provider.Close()
	configureTranslationTest(t, s, provider.URL)
	if err := s.settleTranslations(context.Background(), &p, m); err == nil {
		t.Fatal("unrecovered paragraph reported complete")
	}
	items, _ := s.translations("doc", m)
	want := "补译后仍未完成：模型只返回了 0/1 段，另有 1 行无法解析（第 1 行不是合法的 JSON"
	if items[0].Status != "complete" || items[1].Status != "failed" || !strings.HasPrefix(items[1].Error, want) {
		t.Fatalf("failure cause not recorded: %+v", items[1])
	}
	dir := filepath.Join(s.Store.Root, "cache", "doc", "translation-failures")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("diagnostic not written: %v %v", entries, err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	cut := strings.Index(string(data), "--- raw output ---")
	if cut < 0 || !strings.Contains(string(data)[:cut], "=== attempt 2:") {
		t.Fatal("trusted retry statistics must precede all model output")
	}
	for _, part := range []string{"batch: p1-b1…p1-b2 (2 paragraphs)", "failed p1-b2: " + want, "=== attempt 2: 1 paragraphs requested, 0 saved, 1 output lines, 1 unparsable", "not json at all"} {
		if !strings.Contains(string(data), part) {
			t.Fatalf("diagnostic misses %q:\n%s", part, data)
		}
	}
	// Only the most recent diagnostics are kept.
	batch := translationBatch{Paragraphs: []translationParagraph{{BlockID: "p1-b2"}}}
	attempt := &translationAttempt{decoder: newTranslationJSONL(batch, nil)}
	for i := 0; i < translationFailureLogs+2; i++ {
		s.recordTranslationFailure("doc", batch, []*translationAttempt{attempt}, []TranslationBlock{{BlockID: "p1-b2", Error: "x"}})
	}
	if entries, _ = os.ReadDir(dir); len(entries) != translationFailureLogs {
		t.Fatalf("kept %d diagnostics", len(entries))
	}
}

func TestTranslationAttemptPublishesOnlyAfterSuccessfulResult(t *testing.T) {
	for _, outcome := range []string{"complete", "truncated", "canceled"} {
		t.Run(outcome, func(t *testing.T) {
			s, _, m := translationFixture(t)
			doc, err := s.Store.Document("doc")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			paragraphs := m.translationParagraphs()
			batch := translationBatch{Paragraphs: paragraphs}
			service := &GenerationService{primary: "api", connections: map[string]generationConnection{}}
			service.connections["api"] = generationConnection{VerifiedText: true, Adapter: adapterFunc(func(ctx context.Context, _ GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
				var text string
				for _, row := range paragraphs {
					text += translationParagraphLine(row)
				}
				if err := emit(ProviderEvent{Text: text}); err != nil {
					return GenerateResult{}, err
				}
				// Synchronous callback returned: every valid row reached the decoder.
				// Query the real persisted store before this request is allowed to finish.
				var n int
				if err := s.Store.DB.QueryRow("SELECT count(*) FROM translations WHERE document_id='doc' AND status='complete'").Scan(&n); err != nil {
					t.Fatal(err)
				}
				if n != 0 {
					t.Errorf("rows published before successful result: %d", n)
				}
				if outcome == "truncated" {
					return GenerateResult{}, generationError(ErrorProtocol, "incomplete terminal")
				}
				if outcome == "canceled" {
					cancel()
					return GenerateResult{}, ctx.Err()
				}
				return GenerateResult{Text: text, FinishReason: "stop"}, nil
			})}
			a, err := s.translationAttempt(ctx, doc, m, batch, service, func() {})
			if err != nil {
				t.Fatal(err)
			}
			var n int
			if err := s.Store.DB.QueryRow("SELECT count(*) FROM translations WHERE document_id='doc' AND status='complete'").Scan(&n); err != nil {
				t.Fatal(err)
			}
			if outcome == "complete" {
				if a.err != nil || n != len(paragraphs) {
					t.Fatalf("normal completion not committed: %d %v", n, a.err)
				}
			} else if a.err == nil || n != 0 {
				t.Fatalf("unconfirmed rows committed: %d %v", n, a.err)
			}
		})
	}
}
