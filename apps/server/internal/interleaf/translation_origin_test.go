package interleaf

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func processingOriginFromAPI(t *testing.T, s *Server) string {
	t.Helper()
	s.Token = "test-secret"
	w := request(t, s, "GET", "/api/documents/doc/assistance", nil)
	var body struct {
		Origin string `json:"translationOrigin"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil {
		t.Fatalf("processing response: %d %s", w.Code, w.Body.String())
	}
	return body.Origin
}

func TestTranslationOriginSurvivesManualPauseResumeAndWorkerUpdates(t *testing.T) {
	s, p, _ := translationFixture(t)
	if _, err := s.Store.DB.Exec("UPDATE document_processing SET body=json_remove(body,'$.translationOrigin') WHERE document_id='doc'"); err != nil {
		t.Fatal(err)
	}
	p, err := s.Store.processing("doc")
	if err != nil {
		t.Fatal(err)
	}
	p.Phase, p.Status = "translating", "paused"
	p.Enabled = false
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	if got := processingOriginFromAPI(t, s); got != "" {
		t.Fatalf("legacy processing origin = %q", got)
	}
	started := assistanceRequest(t, s, "start")
	if got := processingOriginFromAPI(t, s); got != "manual" {
		t.Fatalf("manual start origin after reopening = %q", got)
	}
	if err := s.learnPDF(context.Background(), &started); err != nil {
		t.Fatal(err)
	}
	assistanceRequest(t, s, "pause")
	if got := processingOriginFromAPI(t, s); got != "manual" {
		t.Fatalf("pause lost manual origin: %q", got)
	}
	assistanceRequest(t, s, "resume")
	// A worker can save its progress with an older snapshot after the request.
	if err := json.Unmarshal([]byte(`{"translationOrigin":"automatic"}`), &p); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	if got := processingOriginFromAPI(t, s); got != "manual" {
		t.Fatalf("stale layout update lost manual origin: %q", got)
	}
	p.lane, p.Status = "translating", "running"
	if err := s.Store.saveProcessing(p); err != nil {
		t.Fatal(err)
	}
	if got := processingOriginFromAPI(t, s); got != "manual" {
		t.Fatalf("worker update lost manual origin: %q", got)
	}
}

func TestTranslationOriginUsesPaperImportPolicyWithoutMarkingParseRetry(t *testing.T) {
	for _, tc := range []struct {
		settings string
		want     string
	}{
		{settings: `{}`, want: "automatic"},
		{settings: `{"autoTranslateMaxPages":0}`},
	} {
		t.Run(tc.settings, func(t *testing.T) {
			s, _, _ := bookFixture(t)
			if _, err := s.Store.DB.Exec("UPDATE documents SET library='papers' WHERE id='doc'"); err != nil {
				t.Fatal(err)
			}
			p := importedProcessing("doc", "papers", tc.settings)
			p.Status = "failed"
			if err := s.Store.saveProcessing(p); err != nil {
				t.Fatal(err)
			}
			p = assistanceRequest(t, s, "resume")
			if err := s.learnPDF(context.Background(), &p); err != nil {
				t.Fatal(err)
			}
			if got := processingOriginFromAPI(t, s); got != tc.want {
				t.Fatalf("import origin = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTranslationOriginManualBookRangeAndRetranslation(t *testing.T) {
	t.Run("chapter", func(t *testing.T) {
		s, p, _ := bookFixture(t)
		if err := s.learnPDF(context.Background(), &p); err != nil {
			t.Fatal(err)
		}
		if code, result := requestRange(t, s, 1, 1); code != 202 || result.Queued != 1 {
			t.Fatalf("range request: %d %+v", code, result)
		}
		if got := processingOriginFromAPI(t, s); got != "manual" {
			t.Fatalf("book range origin = %q", got)
		}
	})
	t.Run("unparsed chapter", func(t *testing.T) {
		s, _, manifest := bookFixture(t)
		manifest.ParsedPages = []int{2}
		if err := os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(manifest)), 0600); err != nil {
			t.Fatal(err)
		}
		if code, result := requestRange(t, s, 1, 1); code != 202 || !result.Parsing {
			t.Fatalf("range request: %d %+v", code, result)
		}
		if got := processingOriginFromAPI(t, s); got != "manual" {
			t.Fatalf("unparsed chapter origin = %q", got)
		}
	})
	t.Run("retranslation", func(t *testing.T) {
		s, _, _ := completedTranslationFixture(t)
		assistanceRequest(t, s, "retranslate")
		if got := processingOriginFromAPI(t, s); got != "manual" {
			t.Fatalf("retranslation origin = %q", got)
		}
	})
	t.Run("explicit paragraph", func(t *testing.T) {
		s, p, _ := translationFixture(t)
		if err := s.learnPDF(context.Background(), &p); err != nil {
			t.Fatal(err)
		}
		s.Token = "test-secret"
		w := request(t, s, "POST", "/api/documents/doc/translations", strings.NewReader(`{"blockId":"p1-b1"}`))
		if w.Code != 202 {
			t.Fatalf("paragraph request: %d %s", w.Code, w.Body.String())
		}
		if got := processingOriginFromAPI(t, s); got != "manual" {
			t.Fatalf("paragraph origin = %q", got)
		}
	})
}
