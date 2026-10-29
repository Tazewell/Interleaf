package reader

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
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
