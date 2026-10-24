package reader

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func ideasModel(t *testing.T, s *Server, calls *atomic.Int32, mutate func(*ResearchIdea), mutateRow ...func(*NoveltyRow)) {
	t.Helper()
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"test"}]}`)
			return
		}
		calls.Add(1)
		var input struct {
			Messages []toolCompletionMessage `json:"messages"`
			Tools    []any                   `json:"tools"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		if len(input.Tools) > 0 {
			t.Error("structured research falsely advertised tool capability")
		}
		result := `{"content":"资料不足","sourceIds":[]}`
		for _, msg := range input.Messages {
			text, ok := msg.Content.(string)
			if !ok {
				continue
			}
			if at := strings.Index(text, "RESEARCH_EVIDENCE_JSON\n"); at >= 0 {
				var ev []struct {
					SourceID string `json:"sourceId"`
				}
				_ = json.Unmarshal([]byte(text[at+len("RESEARCH_EVIDENCE_JSON\n"):]), &ev)
				if len(ev) > 0 {
					result = jsonText(researchCardFacts{Problem: ResearchFact{Text: "Observed source condition", EvidenceIDs: []string{ev[0].SourceID}}})
				}
			}
			if at := strings.Index(text, "RESEARCH_IDEA_EVIDENCE_JSON\n"); at >= 0 {
				var ev []ResearchEvidence
				_ = json.Unmarshal([]byte(text[at+len("RESEARCH_IDEA_EVIDENCE_JSON\n"):]), &ev)
				count := 3
				if strings.Contains(text, "候选数量=1") {
					count = 1
				}
				if strings.Contains(text, "候选数量=2") {
					count = 2
				}
				ideas := []ResearchIdea{}
				for i := 0; i < count; i++ {
					v := ResearchIdea{ID: fmt.Sprintf("idea-%d", i), Basis: []ResearchFact{{Text: "Observed source condition", EvidenceIDs: []string{ev[0].ID}}}, Problem: "Sparse graph propagation lacks calibrated uncertainty", Mechanism: "Proposed uncertainty weighted message passing", Hypotheses: []string{"Adaptive weights improve calibration under sparsity"}, Changes: []string{"Replace uniform aggregation by uncertainty weights"}, NearestWorkIDs: []string{researchWorkID(ev[0])}, MinimumExperiment: "Fixed graph split compare calibration error against uniform aggregation", Baselines: []string{"Uniform graph aggregation"}, Ablations: []string{"Remove uncertainty weighting"}, Falsification: "No improvement over uniform aggregation on held-out calibration", Resources: "unknown", Claims: []ResearchClaim{{ID: "method-1", Kind: "method", Text: "Uncertainty weighted graph propagation"}}}
					if mutate != nil {
						mutate(&v)
					}
					ideas = append(ideas, v)
				}
				result = jsonText(map[string]any{"ideas": ideas})
			}
			if strings.Contains(text, "RESEARCH_NOVELTY_QUERY\n") {
				result = `{"synonym":"uncertainty graph propagation","mechanism":"variance weighted aggregation","adjacent":"confidence sensor fusion"}`
			}
			if at := strings.Index(text, "RESEARCH_NOVELTY_INPUT_JSON\n"); at >= 0 {
				var v struct {
					Idea     ResearchIdea       `json:"idea"`
					Evidence []ResearchEvidence `json:"evidence"`
					Complete bool               `json:"coverageComplete"`
				}
				_ = json.Unmarshal([]byte(text[at+len("RESEARCH_NOVELTY_INPUT_JSON\n"):]), &v)
				rows := []NoveltyRow{}
				for _, c := range v.Idea.Claims {
					row := NoveltyRow{ClaimID: c.ID, Status: "insufficient", RelatedWorkIDs: []string{}, EvidenceIDs: []string{}, Unverified: "Only checked supplied scope; remaining methods require full text"}
					for _, ev := range v.Evidence {
						if ev.CandidateID != "" && ev.Kind == "remote-html" && strings.Contains(ev.Excerpt, "uncertainty weighted") {
							row.Status = "high_overlap"
							row.RelatedWorkIDs = []string{ev.CandidateID}
							row.EvidenceIDs = []string{ev.ID}
							row.Overlap = "Both use uncertainty weighted graph propagation"
							break
						}
					}
					for _, fn := range mutateRow {
						fn(&row)
					}
					rows = append(rows, row)
				}
				result = jsonText(map[string]any{"rows": rows})
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": result}, "finish_reason": "stop"}}})+"\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(endpoint.Close)
	if _, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":null},"models":{"chat":"test"}}`)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
}
func ideasRun(t *testing.T, s *Server, topic, session string, input ResearchRunInput) string {
	t.Helper()
	if session == "" {
		session = paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions", `{"title":"Ideas"}`, 201)["id"].(string)
	}
	input.UserMessageID = id()
	if input.Question == "" {
		input.Question = "Explore falsifiable graph ideas"
	}
	if input.Mode == "" {
		input.Mode = "ideas"
	}
	if input.Network == "" {
		input.Network = "deny"
	}
	run := paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions/"+session+"/runs", jsonText(input), 201)["id"].(string)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	return run
}

// Removing the ideas worker branch or dropping experiment/provenance fields
// fails at the durable public run/results boundary.
func TestResearchIdeasHaveMechanismAndFalsification(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	ideasModel(t, s, &calls, nil)
	run := ideasRun(t, s, topic, "", ResearchRunInput{})
	researchWaitJob(t, s, run, "completed")
	result := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	if len(result["ideas"].([]any)) != 3 || len(result["novelty"].([]any)) != 3 || len(result["pendingIdeaIds"].([]any)) != 0 {
		t.Fatal(result)
	}
	for _, v := range result["ideas"].([]any) {
		idea := v.(map[string]any)
		for _, key := range []string{"problem", "mechanism", "minimumExperiment", "falsification", "resources"} {
			if idea[key] == "" {
				t.Fatal(key)
			}
		}
		if len(idea["basis"].([]any)) == 0 {
			t.Fatal("missing basis")
		}
	}
	if len(result["queries"].([]any)) != 0 || result["capability"] != "text-search-assistance" {
		t.Fatal("local capability contract", result)
	}
	before := calls.Load()
	paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	if calls.Load() != before {
		t.Fatal("GET triggered model")
	}
}
func TestResearchIdeasBudgetKeepsTypedResultsAndRefinement(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	ideasModel(t, s, &calls, nil)
	session := paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions", `{"title":"Ideas"}`, 201)["id"].(string)
	run := ideasRun(t, s, topic, session, ResearchRunInput{IdeaCount: 1, Budget: ResearchBudget{MaxModelRequests: 2}})
	researchWaitJob(t, s, run, "paused")
	results := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	if len(results["ideas"].([]any)) != 1 || len(results["pendingIdeaIds"].([]any)) != 1 {
		t.Fatal(results)
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`"}`, 202)
	researchWaitJob(t, s, run, "completed")
	if calls.Load() != 3 {
		t.Fatal("resume repeated successful paper or idea", calls.Load())
	}
	ideaID := results["ideas"].([]any)[0].(map[string]any)["id"].(string)
	refined := ideasRun(t, s, topic, session, ResearchRunInput{IdeaID: ideaID})
	researchWaitJob(t, s, refined, "completed")
	if calls.Load() != 5 {
		t.Fatal("refinement repeated cached paper", calls.Load())
	}
	output := paperCall(t, s, "GET", "/api/research/runs/"+refined+"/results", "", 200)
	idea := output["ideas"].([]any)[0].(map[string]any)
	if len(output["ideas"].([]any)) != 1 || idea["derivedFromId"] != ideaID || idea["id"] == ideaID {
		t.Fatal(output)
	}
}

func TestResearchIdeasInvalidOutputPreservesHistory(t *testing.T) {
	for _, field := range []string{"title", "basis", "experiment", "citation"} {
		t.Run(field, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			var calls atomic.Int32
			var invalid atomic.Bool
			ideasModel(t, s, &calls, func(v *ResearchIdea) {
				if !invalid.Load() {
					return
				}
				switch field {
				case "title":
					v.Mechanism = ""
				case "basis":
					v.Basis = nil
				case "experiment":
					v.Ablations = nil
				case "citation":
					v.Basis[0].EvidenceIDs = []string{"ffffffffffffffffffffffffffffffff"}
				}
			})
			first := ideasRun(t, s, topic, "", ResearchRunInput{IdeaCount: 1})
			done := researchWaitJob(t, s, first, "completed")
			reportID := done["latestReportId"].(string)
			before := paperCall(t, s, "GET", "/api/research/reports/"+reportID, "", 200)["content"]
			invalid.Store(true)
			bad := ideasRun(t, s, topic, "", ResearchRunInput{IdeaCount: 1})
			waitIdeasFailure(t, s, bad)
			results := paperCall(t, s, "GET", "/api/research/runs/"+bad+"/results", "", 200)
			if len(results["ideas"].([]any)) != 0 {
				t.Fatal("invalid idea became durable success", results)
			}
			if after := paperCall(t, s, "GET", "/api/research/reports/"+reportID, "", 200)["content"]; after != before {
				t.Fatal("old report changed")
			}
		})
	}
}
func waitIdeasFailure(t *testing.T, s *Server, run string) {
	t.Helper()
	for i := 0; i < 500; i++ {
		r := paperCall(t, s, "GET", "/api/research/runs/"+run, "", 200)
		if r["status"] == "failed" || r["status"] == "interrupted" {
			return
		}
		if r["status"] == "completed" {
			t.Fatal("invalid model output completed", r)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("run did not stop")
}
func TestResearchIdeasHistoricalResultsRemainReadable(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	ideasModel(t, s, &calls, nil)
	run := ideasRun(t, s, topic, "", ResearchRunInput{IdeaCount: 1})
	researchWaitJob(t, s, run, "completed")
	if _, err := s.Store.DB.Exec(`UPDATE research_evidence SET availability='stale',body=json_set(body,'$.availability','stale') WHERE run_id=?`, run); err != nil {
		t.Fatal(err)
	}
	before := calls.Load()
	out := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	if len(out["ideas"].([]any)) != 1 || calls.Load() != before {
		t.Fatal(out)
	}
	for _, key := range []string{"usage", "control", "snapshot", "units"} {
		if _, ok := out[key]; ok {
			t.Fatal("private result leak", key)
		}
	}
}

func TestResearchIdeasRejectsUnattributedInlineCitation(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	ideasModel(t, s, &calls, func(v *ResearchIdea) { v.Basis[0].Text = "Fact [ffffffffffffffffffffffffffffffff]" })
	run := ideasRun(t, s, topic, "", ResearchRunInput{IdeaCount: 1})
	waitIdeasFailure(t, s, run)
	out := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	if len(out["ideas"].([]any)) != 0 {
		t.Fatal("unread inline citation entered successful idea unit")
	}
}

func TestResearchIdeasTwoCandidatesKeepCheckedUnitsOnResume(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	ideasModel(t, s, &calls, nil)
	run := ideasRun(t, s, topic, "", ResearchRunInput{IdeaCount: 2, Budget: ResearchBudget{MaxModelRequests: 3}})
	researchWaitJob(t, s, run, "paused")
	before, err := s.getResearchResults(t.Context(), run)
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Ideas) != 2 || len(before.Novelty) != 1 || len(before.PendingIdeaIDs) != 1 {
		t.Fatal(before)
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`"}`, 202)
	researchWaitJob(t, s, run, "completed")
	after, err := s.getResearchResults(t.Context(), run)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 4 || len(after.Novelty) != 2 || after.Ideas[0].ID != before.Ideas[0].ID {
		t.Fatal("resume repeated checked units", calls.Load(), after)
	}
	for _, n := range after.Novelty {
		if n.IdeaID == before.Novelty[0].IdeaID && n.AsOf != before.Novelty[0].AsOf {
			t.Fatal("checked date rewritten")
		}
	}
}
func TestResearchIdeasSelectedOwnership(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	ideasModel(t, s, &calls, nil)
	run := ideasRun(t, s, topic, "", ResearchRunInput{IdeaCount: 1})
	researchWaitJob(t, s, run, "completed")
	result, err := s.getResearchResults(t.Context(), run)
	if err != nil {
		t.Fatal(err)
	}
	bad := ideasRun(t, s, topic, "", ResearchRunInput{Mode: "novelty", IdeaID: result.Ideas[0].ID})
	waitIdeasFailure(t, s, bad)
	out, err := s.getResearchResults(t.Context(), bad)
	if err != nil || len(out.Ideas) != 0 {
		t.Fatal("foreign session idea accepted", out, err)
	}
}

func TestResearchIdeasSelectedInlineCitationRemapsAllText(t *testing.T) {
	for _, mode := range []string{"ideas", "novelty"} {
		t.Run(mode, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			var calls atomic.Int32
			ideasModel(t, s, &calls, func(v *ResearchIdea) {
				ref := " [" + v.Basis[0].EvidenceIDs[0] + "]"
				v.Basis[0].Text += ref
				v.Problem += ref
				v.Mechanism += ref
				v.MinimumExperiment += ref
				v.Falsification += ref
				v.Resources += ref
				v.Hypotheses[0] += ref
				v.Changes[0] += ref
				v.Baselines[0] += ref
				v.Ablations[0] += ref
				v.Claims[0].Text += ref
			})
			first := ideasRun(t, s, topic, "", ResearchRunInput{IdeaCount: 1})
			researchWaitJob(t, s, first, "completed")
			record, err := readResearchRecord(t.Context(), s.Store.DB, first)
			if err != nil {
				t.Fatal(err)
			}
			original, err := s.getResearchResults(t.Context(), first)
			if err != nil {
				t.Fatal(err)
			}
			oldText := jsonText(original.Ideas[0])
			oldID := original.Ideas[0].Basis[0].EvidenceIDs[0]
			second := ideasRun(t, s, topic, record.SessionID, ResearchRunInput{Mode: mode, IdeaID: original.Ideas[0].ID})
			researchWaitJob(t, s, second, "completed")
			current, err := s.getResearchResults(t.Context(), second)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(jsonText(current.Ideas[0]), "["+oldID+"]") {
				t.Fatal("old inline token survived")
			}
			for _, f := range current.Ideas[0].Basis {
				for _, sid := range f.EvidenceIDs {
					ev, e := s.resolveResearchSource(t.Context(), sid)
					if e != nil || ev.RunID != second {
						t.Fatal("citation not rebound", ev, e)
					}
				}
			}
			history, err := s.getResearchResults(t.Context(), first)
			if err != nil || jsonText(history.Ideas[0]) != oldText {
				t.Fatal("historical idea mutated", err)
			}
		})
	}
}
