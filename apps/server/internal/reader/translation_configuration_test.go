package reader

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPDFTranslationWaitsForConfigurationBeforeFormulaWork(t *testing.T) {
	s, p, m := formulaFixture(t)
	if err := s.learnPDF(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatalf("missing configuration must wait, not fail formula rows: %v", err)
	}
	if p.Status != "waiting" || strings.Count(p.Detail, "\n") != 0 {
		t.Fatalf("configuration wait not published once: %+v", p)
	}
	items, err := s.translations("doc", m)
	if err != nil || items[0].Status != "pending" || items[0].Error != "" {
		t.Fatalf("configuration block poisoned the formula: %+v %v", items, err)
	}
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[]}`)
	}))
	defer endpoint.Close()
	update := fmt.Sprintf(`{"version":2,"connection":{"protocol":"openai","url":%q,"key":null},"models":{"chat":"text","translation":"text"}}`, endpoint.URL)
	response := request(t, s, "PUT", "/api/ai/config", strings.NewReader(update))
	if response.Code != http.StatusOK {
		t.Fatal(response.Code, response.Body.String())
	}
	woken, err := s.Store.processing("doc")
	if err != nil || woken.Status != "queued" || woken.Translating.Status != "queued" {
		t.Fatalf("explicit config save did not wake accepted waiting job: %+v %v", woken, err)
	}
}

type gatedTranslationContext struct {
	context.Context
	once             sync.Once
	entered, release chan struct{}
}

func (c *gatedTranslationContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered); <-c.release })
	return c.Context.Done()
}

func TestTranslationConfigurationSaveDuringReadinessCheckDoesNotLoseWake(t *testing.T) {
	s, p, _ := formulaFixture(t)
	if err := s.learnPDF(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[]}`)
	}))
	defer endpoint.Close()
	ctx := &gatedTranslationContext{Context: t.Context(), entered: make(chan struct{}), release: make(chan struct{})}
	// An empty input isolates readiness and never submits a model request.
	done := make(chan error, 1)
	go func() { done <- s.translateContent(ctx, &p, layoutManifest{}) }()
	select {
	case <-ctx.entered:
	case <-time.After(time.Second):
		t.Fatal("readiness did not start")
	}
	update := fmt.Sprintf(`{"version":2,"connection":{"protocol":"openai","url":%q,"key":null},"models":{"chat":"text","translation":"text"}}`, endpoint.URL)
	response := request(t, s, "PUT", "/api/ai/config", strings.NewReader(update))
	close(ctx.release)
	if response.Code != http.StatusOK {
		t.Fatal(response.Code, response.Body.String())
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("readiness did not finish")
	}
	got, err := s.Store.processing("doc")
	if err != nil || got.Status == "waiting" || (got.Translating != nil && got.Translating.Status == "waiting") {
		t.Fatalf("configuration save was lost during readiness: %+v %v", got, err)
	}
}

func TestPDFFormulaProviderCapabilityErrorStillFails(t *testing.T) {
	s, p, m := formulaFixture(t)
	var calls atomic.Int32
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"id\":\"unexpected\",\"type\":\"function\",\"function\":{\"name\":\"unexpected\",\"arguments\":\"{}\"}}]}}]}\n\n")
	}))
	defer images.Close()
	text := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		input := readTranslationInput(t, r)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, para := range input.Batch.Paragraphs {
			sendTranslationDelta(w, translationParagraphLine(para))
		}
		finishTranslationStream(w)
	}))
	defer text.Close()
	configureFormulaTest(t, s, text.URL, images.URL)
	if err := s.learnPDF(t.Context(), &p); err != nil {
		t.Fatal(err)
	}
	if err := s.processTranslation(t.Context(), &p); err == nil {
		t.Error("provider tool-call error was hidden as preserved original")
	}
	items, err := s.translations("doc", m)
	if err != nil || items[0].Status != "failed" || items[0].Error == "" || items[0].FormulaMarkdown != "" || items[1].Status != "complete" || calls.Load() != 1 {
		t.Fatalf("provider failure must stay explicit without replaying completed text: %+v calls=%d err=%v", items, calls.Load(), err)
	}
}

func TestPDFTextTranslationKeepsOriginalFormulaWithoutVision(t *testing.T) {
	s, p, m := formulaFixture(t)
	var textCalls atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"data":[]}`)
			return
		}
		textCalls.Add(1)
		input := readTranslationInput(t, r)
		if len(input.Batch.Paragraphs) != 1 || input.Batch.Paragraphs[0].Source != m.Blocks[1].Caption {
			t.Error("only the caption belongs in the text model request")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, para := range input.Batch.Paragraphs {
			sendTranslationDelta(w, translationParagraphLine(para))
		}
		finishTranslationStream(w)
	}))
	defer endpoint.Close()
	configureNativeTest(t, s, endpoint.URL, "text-only", false)
	if err := s.learnPDF(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	if err := s.processTranslation(t.Context(), &p); err != nil {
		t.Fatalf("text translation blocked by unavailable image conversion: %v", err)
	}
	items, err := s.translations("doc", m)
	if err != nil || items[0].Status != "idle" || items[0].FormulaMarkdown != "" || items[1].Status != "complete" {
		t.Fatalf("formula must remain original, caption must complete: %+v %v", items, err)
	}
	if p.Status != "complete" || p.TranslationsDone != 1 || p.TranslationsTotal != 1 || textCalls.Load() != 1 {
		t.Fatalf("wrong text-only completion: %+v calls=%d", p, textCalls.Load())
	}
	if err := s.processTranslation(t.Context(), &p); err != nil || textCalls.Load() != 1 {
		t.Fatal("completed text was replayed", err, textCalls.Load())
	}
}
