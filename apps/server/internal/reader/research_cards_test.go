package reader

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Only the paid HTTP boundary is a fixture. Parsing, scoped reads, SQLite
// evidence, the native completion gate, and cross-run cache adoption are real.
func researchCardModel(t *testing.T, s *Server, mode *string, calls *int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			if *mode == "smallwindow" {
				fmt.Fprint(w, `{"data":[{"id":"model-a","context_window":4096}]}`)
				return
			}
			fmt.Fprint(w, `{"data":[{"id":"model-a"},{"id":"model-b"}]}`)
			return
		}
		*calls++
		var input struct {
			Model    string          `json:"model"`
			Tools    json.RawMessage `json:"tools"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		wire := input.Messages[len(input.Messages)-1].Content
		marker := strings.Index(wire, "RESEARCH_EVIDENCE_JSON\n")
		if marker < 0 {
			t.Error("Reader did not prepare source text")
			return
		}
		var evidence []struct {
			SourceID string `json:"sourceId"`
			Text     string `json:"text"`
		}
		if err := json.Unmarshal([]byte(wire[marker+len("RESEARCH_EVIDENCE_JSON\n"):]), &evidence); err != nil || len(evidence) == 0 {
			t.Error(err, wire)
			return
		}
		source := evidence[0].SourceID
		if *mode == "interrupt" {
			s.Store.DB.Exec(`UPDATE research_runs SET status='interrupted',body=json_set(body,'$.status','interrupted') WHERE id=(SELECT run_id FROM research_evidence WHERE id=?)`, source)
		}
		if *mode == "replace" {
			researchSetLayoutSource(t, s, "doc", "replaced-during-model-call")
		}
		if *mode == "freeze" && *calls == 1 {
			raw, err := os.ReadFile(filepath.Join(s.Store.Root, "ai-connections.json"))
			if err != nil {
				t.Error(err)
			}
			raw = []byte(strings.ReplaceAll(string(raw), `"model-a"`, `"model-b"`))
			if err = os.WriteFile(filepath.Join(s.Store.Root, "ai-connections.json"), raw, 0600); err != nil {
				t.Error(err)
			}
		}
		if *mode == "freeze" && input.Model != "model-a" {
			t.Error("model changed during batch analysis", input.Model)
		}
		if len(input.Tools) > 0 {
			t.Error("prepared-source extraction advertised callable tools")
		}
		if *mode == "forged" {
			source = "ffffffffffffffffffffffffffffffff"
		}
		text := jsonText(map[string]any{"problem": ResearchFact{Text: evidence[0].Text, EvidenceIDs: []string{source}}, "method": ResearchFact{}, "assumptions": ResearchFact{}, "dataAndEvaluation": ResearchFact{}, "findings": ResearchFact{}, "limitations": ResearchFact{}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": text}, "finish_reason": "stop"}}})+"\n\n")
		if *mode != "partial" {
			fmt.Fprint(w, "data: [DONE]\n\n")
		}
	}))
	t.Cleanup(server.Close)
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+server.URL+`/v1","key":null},"models":{"chat":"model-a"}}`))
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func TestResearchCardsSmallContextUsesCursorBatches(t *testing.T) {
	s, topic, paper := researchFixture(t)
	researchLongPDF(t, s, 10)
	mode := "smallwindow"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
	if err != nil || len(card.EvidenceIDs) != 10 || calls < 3 {
		t.Fatal("small window could not continue reading", err, len(card.EvidenceIDs), calls)
	}
}

func TestResearchCardsConflictingPapersKeepOwnEvidence(t *testing.T) {
	s, topic, _ := researchFixture(t)
	mode := "ok"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	papers := []string{paperCreate(t, s, "Positive"), paperCreate(t, s, "Negative")}
	claims := []string{"The intervention improves accuracy.", "The intervention reduces accuracy."}
	for i, paper := range papers {
		paperCall(t, s, "PATCH", "/api/papers/"+paper, jsonText(map[string]any{"folders": []string{"ML"}, "metadata": map[string]any{"abstract": claims[i]}}), 200)
	}
	run := researchRunFixture(t, s, topic)
	for i, paper := range papers {
		card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
		if err != nil || card.Problem.Text != claims[i] {
			t.Fatal(card, err)
		}
		for _, source := range card.Problem.EvidenceIDs {
			ev, err := s.resolveResearchSource(t.Context(), source)
			if err != nil || ev.PaperID != paper || ev.Excerpt != claims[i] {
				t.Fatal("borrowed conflicting source", ev, err)
			}
		}
	}
}

func TestResearchCardsDeletionCancelsAndJoinsModel(t *testing.T) {
	s, topic, paper := researchFixture(t)
	started := make(chan struct{})
	modelDone := make(chan error, 1)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"test"}]}`)
			return
		}
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer endpoint.Close()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":null},"models":{"chat":"test"}}`))
	if err != nil {
		t.Fatal(err)
	}
	run := researchRunFixture(t, s, topic)
	go func() { _, err := s.analyzeResearchPaper(t.Context(), run.ID, paper); modelDone <- err }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("model did not start")
	}
	deleted := make(chan int, 1)
	go func() { status, _ := s.purgeDocument(t.Context(), "doc"); deleted <- status }()
	select {
	case err := <-modelDone:
		if err == nil {
			t.Fatal("deleted source still completed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("model not canceled/joined")
	}
	select {
	case status := <-deleted:
		if status != 204 {
			t.Fatal("delete failed", status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("delete did not join")
	}
	var count int
	s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards`).Scan(&count)
	if count != 0 {
		t.Fatal("canceled model saved card")
	}
}

// Omitting any one of these inputs would reuse facts produced under a different
// extraction contract. These inputs are independent, concrete cache boundaries.
func TestResearchCardsCacheIdentity(t *testing.T) {
	member := ResearchMember{PaperID: "paper", DocumentID: "doc", SourceHash: "content-a", CorpusRevision: "parser-a", Title: "Title", Coverage: "fulltext"}
	snapshot := nativeTaskSnapshot{Model: "model-a", Fingerprint: "connection-a", Effort: "medium"}
	base := researchCardKey(member, snapshot, "protocol-a", "prompt-a")
	for _, field := range []string{"source", "parser", "level", "title", "model", "connection", "effort", "protocol", "prompt"} {
		t.Run(field, func(t *testing.T) {
			m, s := member, snapshot
			protocol, prompt := "protocol-a", "prompt-a"
			switch field {
			case "source":
				m.SourceHash = "content-b"
			case "parser":
				m.CorpusRevision = "parser-b"
			case "level":
				m.Coverage = "abstract"
			case "title":
				m.Title = "Changed title"
			case "model":
				s.Model = "model-b"
			case "connection":
				s.Fingerprint = "connection-b"
			case "effort":
				s.Effort = "high"
			case "protocol":
				protocol = "protocol-b"
			case "prompt":
				prompt = "prompt-b"
			}
			if got := researchCardKey(m, s, protocol, prompt); got == base {
				t.Fatal("cache ignored", field)
			}
		})
	}
}

func TestResearchCardsRejectCachedVersionForgery(t *testing.T) {
	s, topic, _ := researchFixture(t)
	mode := "ok"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	paper := paperCreate(t, s, "Metadata")
	paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"]}`, 200)
	run := researchRunFixture(t, s, topic)
	card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
	if err != nil {
		t.Fatal(err)
	}
	card.Revision = "forged-revision"
	s.Store.DB.Exec(`UPDATE research_cards SET revision=?,body=? WHERE cache_key=?`, card.Revision, jsonText(card), card.CacheKey)
	if _, err = s.analyzeResearchPaper(t.Context(), run.ID, paper); err == nil {
		t.Fatal("cache revision not bound to snapshot")
	}
}

func TestResearchCardsCacheRequiresHistoricalSnapshotMembership(t *testing.T) {
	s, topic, paper := researchFixture(t)
	mode := "ok"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	if _, err := s.analyzeResearchPaper(t.Context(), run.ID, paper); err != nil {
		t.Fatal(err)
	}
	var raw string
	s.Store.DB.QueryRow(`SELECT body FROM research_snapshots WHERE id=?`, run.SnapshotID).Scan(&raw)
	var snapshot ResearchSnapshot
	json.Unmarshal([]byte(raw), &snapshot)
	snapshot.Members = nil
	s.Store.DB.Exec(`UPDATE research_snapshots SET body=? WHERE id=?`, jsonText(snapshot), snapshot.ID)
	fresh := researchRunFixture(t, s, topic)
	if _, err := s.analyzeResearchPaper(t.Context(), fresh.ID, paper); err == nil {
		t.Fatal("cache trusted source outside its historical snapshot")
	}
}

func TestResearchCardsFinalSaveRejectsReplacement(t *testing.T) {
	for _, modeValue := range []string{"replace", "interrupt"} {
		t.Run(modeValue, func(t *testing.T) {
			s, topic, paper := researchFixture(t)
			mode := modeValue
			calls := 0
			researchCardModel(t, s, &mode, &calls)
			run := researchRunFixture(t, s, topic)
			if _, err := s.analyzeResearchPaper(t.Context(), run.ID, paper); err == nil {
				t.Fatal("saved model facts after source replacement or interruption")
			}
			var n int
			s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards`).Scan(&n)
			if n != 0 {
				t.Fatal("saved invalidated card")
			}
		})
	}
}

func TestResearchCardsLongPaperFrozenModelAndCompletedBatches(t *testing.T) {
	s, topic, paper := researchFixture(t)
	researchLongPDF(t, s, 35)
	mode := "freeze"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	reserved := 0
	ctx := context.WithValue(t.Context(), researchModelReservationKey{}, func(context.Context) error { reserved++; return nil })
	card, err := s.analyzeResearchPaper(ctx, run.ID, paper)
	if err != nil || calls < 2 || reserved != calls || card.ReadCoverage.ReadUnits != 1 || card.ReadCoverage.TotalUnits != 1 || len(card.ReadCoverage.Ranges) != 35 || len(card.EvidenceIDs) != 35 {
		t.Fatal(card, err, calls, reserved)
	}
	if !strings.Contains(card.Problem.Text, "Fact 0 ") || !strings.Contains(card.Problem.Text, "Fact 30 ") {
		t.Fatal("lost completed batches", card.Problem.Text)
	}
}

func TestResearchCardsCoverageCacheAndInvalidation(t *testing.T) {
	s, topic, paper := researchFixture(t)
	mode := "ok"
	calls := 0
	endpoint := researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
	if err != nil || card.Level != "fulltext" || card.ReadCoverage.ReadUnits != card.ReadCoverage.TotalUnits || card.ReadCoverage.ReadUnits < 2 || len(card.Problem.EvidenceIDs) == 0 {
		t.Fatal(card, err)
	}
	firstCalls := calls
	secondRun := researchRunFixture(t, s, topic)
	cached, err := s.analyzeResearchPaper(t.Context(), secondRun.ID, paper)
	if err != nil || calls != firstCalls || cached.Problem.Text != card.Problem.Text || cached.EvidenceIDs[0] == card.EvidenceIDs[0] {
		t.Fatal("unsafe cache adoption", cached, err, calls)
	}
	if err = s.validateResearchSources(t.Context(), secondRun.ID, cached.EvidenceIDs); err != nil {
		t.Fatal(err)
	}
	if err = s.validateResearchSources(t.Context(), secondRun.ID, card.EvidenceIDs); err == nil {
		t.Fatal("old run references accepted")
	}
	_, err = s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`/v1"},"models":{"chat":"model-b"}}`))
	if err != nil {
		t.Fatal(err)
	}
	changed, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
	if err != nil || calls <= firstCalls || changed.CacheKey == card.CacheKey {
		t.Fatal("model cache identity", changed, err, calls)
	}
	beforeChange := calls
	researchSetLayoutSource(t, s, "doc", "new-source-bytes")
	newRun := researchRunFixture(t, s, topic)
	newCard, err := s.analyzeResearchPaper(t.Context(), newRun.ID, paper)
	if err != nil || calls <= beforeChange || newCard.CacheKey == changed.CacheKey {
		t.Fatal("original hash cache identity", newCard, err, calls)
	}
	raw, err := os.ReadFile(filepath.Join(s.analysisDir("doc"), "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	raw = []byte(strings.ReplaceAll(string(raw), "Introduction", "Changed parser heading"))
	os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), raw, 0600)
	beforeChange = calls
	newRun = researchRunFixture(t, s, topic)
	parsedCard, err := s.analyzeResearchPaper(t.Context(), newRun.ID, paper)
	if err != nil || calls <= beforeChange || parsedCard.CacheKey == newCard.CacheKey {
		t.Fatal("parser cache identity", parsedCard, err, calls)
	}
	paperCall(t, s, "DELETE", "/api/documents/doc", "", 204)
	before := calls
	if _, err = s.analyzeResearchPaper(t.Context(), secondRun.ID, paper); err == nil || calls != before {
		t.Fatal("removed cache resurrected", err, calls)
	}
}

func TestResearchCardsAbstractMetadataAndCompletion(t *testing.T) {
	for _, modeValue := range []string{"ok", "forged", "partial"} {
		t.Run(modeValue, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			mode := modeValue
			calls := 0
			researchCardModel(t, s, &mode, &calls)
			paper := paperCreate(t, s, "Abstract paper")
			meta := paperCreate(t, s, "Metadata paper")
			paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"],"metadata":{"abstract":"Actual abstract claim."}}`, 200)
			paperCall(t, s, "PATCH", "/api/papers/"+meta, `{"folders":["ML"]}`, 200)
			run := researchRunFixture(t, s, topic)
			card, err := s.analyzeResearchPaper(t.Context(), run.ID, meta)
			if err != nil || card.Level != "metadata" || card.Method.Text != "" || card.Problem.Text != "" || card.ReadCoverage.ReadUnits != 0 || calls != 0 {
				t.Fatal("title turned into fact", card, err, calls)
			}
			card, err = s.analyzeResearchPaper(t.Context(), run.ID, paper)
			if mode == "ok" {
				if err != nil || card.Level != "abstract" || card.ReadCoverage.ReadUnits != 1 || card.Problem.Text != "Actual abstract claim." {
					t.Fatal(card, err)
				}
				paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"metadata":{"abstract":"Changed claim."}}`, 200)
				if _, err = s.analyzeResearchPaper(t.Context(), run.ID, paper); err == nil {
					t.Fatal("changed abstract cache hit")
				}
			} else {
				if err == nil {
					t.Fatal("saved unverified output", card)
				}
				var n int
				s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards WHERE paper_id=?`, paper).Scan(&n)
				if n != 0 {
					t.Fatal("partial card checkpoint", n)
				}
			}
		})
	}
}

func TestResearchCardsReserveEveryModelCall(t *testing.T) {
	s, topic, paper := researchFixture(t)
	mode := "ok"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	reserved := 0
	ctx := context.WithValue(t.Context(), researchModelReservationKey{}, func(context.Context) error { reserved++; return fmt.Errorf("budget exhausted") })
	if _, err := s.analyzeResearchPaper(ctx, run.ID, paper); err == nil || reserved != 1 || calls != 0 {
		t.Fatal("unaccounted model request", reserved, calls, err)
	}
}
