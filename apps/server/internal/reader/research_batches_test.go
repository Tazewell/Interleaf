package reader

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestResearchIdeasLargeEvidenceBatchResume(t *testing.T) {
	s, topic, _ := noveltyFixture(t, "full")
	var calls atomic.Int32
	var mu sync.Mutex
	prompts := map[string]int{}
	ideasModelObserved(t, s, &calls, nil, func(text string) {
		if strings.Contains(text, "RESEARCH_IDEA_EVIDENCE_JSON") {
			mu.Lock()
			prompts[text]++
			mu.Unlock()
		}
	})
	run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "allow-task", URLs: []string{"http://paper.example/large"}, IdeaCount: 1, Budget: ResearchBudget{MaxModelRequests: 2}})
	researchWaitJob(t, s, run, "paused")
	out := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	partial, ok := out["partialIdeas"].([]any)
	if !ok || len(partial) != 1 || len(out["ideas"].([]any)) != 0 {
		t.Fatal("successful partial idea unavailable", out)
	}
	batches := out["batches"].([]any)
	if len(batches) == 0 {
		t.Fatal("missing bounded progress")
	}
	progress := batches[0].(map[string]any)
	if progress["completedBatches"] != float64(1) {
		t.Fatal("completed batch count missing", progress)
	}
	sourceProgress, ok := progress["sources"].([]any)
	if !ok || len(sourceProgress) == 0 {
		t.Fatal("source ranges missing", progress)
	}
	if progress["done"].(float64) <= 0 || progress["done"].(float64) >= progress["total"].(float64) {
		t.Fatal(progress)
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`","budget":{"maxModelRequests":200,"maxSearchRequests":24,"maxRemoteReads":8,"maxMinutes":30}}`, 202)
	researchWaitJob(t, s, run, "completed")
	mu.Lock()
	defer mu.Unlock()
	if len(prompts) < 2 {
		t.Fatal("no actual batching")
	}
	for _, n := range prompts {
		if n != 1 {
			t.Fatal("successful batch repeated", n)
		}
	}
	result, _ := s.getResearchResults(t.Context(), run)
	assertResearchBatchCoverage(t, s, run, "ideas", prompts, result)
	if len(result.PartialIdeas) != 0 {
		t.Fatal("final candidate still marked partial")
	}
	for _, f := range result.Ideas[0].Basis {
		for _, sid := range f.EvidenceIDs {
			if _, err := s.resolveResearchSource(t.Context(), sid); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestResearchNoveltyBatchMergePreservesEvidence(t *testing.T) {
	rows := []NoveltyRow{
		{ClaimID: "c", Status: "high_overlap", RelatedWorkIDs: []string{"a"}, EvidenceIDs: []string{"a-source"}, Overlap: "method A", Difference: "condition A", Unverified: "limit A"},
		{ClaimID: "c", Status: "partial_overlap", RelatedWorkIDs: []string{"b"}, EvidenceIDs: []string{"b-source"}, Overlap: "method B", Difference: "condition B", Unverified: "limit B"},
		{ClaimID: "c", Status: "insufficient", EvidenceIDs: []string{"abstract"}, Unverified: "only abstract"},
	}
	got := mergeResearchNoveltyRows(rows)
	if got.Status != "high_overlap" || len(got.EvidenceIDs) != 3 || len(got.RelatedWorkIDs) != 2 || !strings.Contains(got.Overlap, "method B") || !strings.Contains(got.Difference, "condition B") || !strings.Contains(got.Unverified, "only abstract") {
		t.Fatal("lost assessed sources/limits", got)
	}
	if mergeResearchNoveltyRows([]NoveltyRow{{Status: "not_found"}, {Status: "insufficient"}}).Status != "insufficient" {
		t.Fatal("cleared incomplete evidence")
	}
}
func TestResearchNoveltyLargeEvidenceBatchResume(t *testing.T) {
	s, topic, _ := noveltyFixture(t, "full")
	var calls atomic.Int32
	var mu sync.Mutex
	prompts := map[string]int{}
	ideasModelObserved(t, s, &calls, nil, func(text string) {
		if strings.Contains(text, "RESEARCH_NOVELTY_INPUT_JSON") {
			mu.Lock()
			prompts[text]++
			mu.Unlock()
		}
	})
	first := ideasRun(t, s, topic, "", ResearchRunInput{IdeaCount: 1})
	researchWaitJob(t, s, first, "completed")
	r, _ := readResearchRecord(t.Context(), s.Store.DB, first)
	prior, _ := s.getResearchResults(t.Context(), first)
	mu.Lock()
	prompts = map[string]int{}
	mu.Unlock()
	run := ideasRun(t, s, topic, r.SessionID, ResearchRunInput{Mode: "novelty", IdeaID: prior.Ideas[0].ID, Network: "allow-task", URLs: []string{"http://paper.example/large"}, Budget: ResearchBudget{MaxModelRequests: 2}})
	researchWaitJob(t, s, run, "paused")
	out := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	if len(out["novelty"].([]any)) != 0 || len(out["pendingIdeaIds"].([]any)) != 1 {
		t.Fatal("partial check shown as final", out)
	}
	if len(out["batches"].([]any)) == 0 {
		t.Fatal("missing novelty batch progress", out)
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`","budget":{"maxModelRequests":200,"maxSearchRequests":24,"maxRemoteReads":8,"maxMinutes":30}}`, 202)
	researchWaitJob(t, s, run, "completed")
	mu.Lock()
	defer mu.Unlock()
	if len(prompts) < 2 {
		t.Fatal("no actual claim batching")
	}
	for _, n := range prompts {
		if n != 1 {
			t.Fatal("successful comparison repeated")
		}
	}
	result, _ := s.getResearchResults(t.Context(), run)
	assertResearchBatchCoverage(t, s, run, "novelty", prompts, result)
	if result.Novelty[0].Rows[0].Status != "high_overlap" {
		t.Fatal("lost overlap when merging batches", result)
	}
}

// Compare actual HTTP model inputs with the durable original sources. Every
// fragment must fit, cover its exact slice once, and retain its original kind.
func assertResearchBatchCoverage(t *testing.T, s *Server, run, stage string, prompts map[string]int, result ResearchResults) {
	t.Helper()
	parts := map[string][]researchEvidenceFragment{}
	snapshot := nativeTaskSnapshot{}
	for prompt := range prompts {
		if !nativeConversationFits(nativeInitialMessages(snapshot, AIInput{Prompt: prompt, SourceOnly: true}), nil, nativeInputLimit(snapshot)) {
			t.Fatal("batch exceeds frozen default window")
		}
		var batch []researchEvidenceFragment
		if stage == "ideas" {
			_, raw, _ := strings.Cut(prompt, "RESEARCH_IDEA_EVIDENCE_JSON\n")
			if err := json.Unmarshal([]byte(raw), &batch); err != nil {
				t.Fatal(err)
			}
		} else {
			_, raw, _ := strings.Cut(prompt, "RESEARCH_NOVELTY_INPUT_JSON\n")
			var v struct {
				Evidence []researchEvidenceFragment `json:"evidence"`
			}
			if err := json.Unmarshal([]byte(raw), &v); err != nil {
				t.Fatal(err)
			}
			batch = v.Evidence
		}
		for _, f := range batch {
			parts[f.ID] = append(parts[f.ID], f)
		}
	}
	var originals []ResearchEvidence
	for _, progress := range result.Batches {
		if progress.Stage != stage {
			continue
		}
		if progress.Done != progress.Total || progress.CompletedBatches != len(prompts) {
			t.Fatal("incomplete final progress", progress)
		}
		if len(progress.Sources) != len(parts) {
			t.Fatal("lost source progress")
		}
		for _, source := range progress.Sources {
			if source.Done != source.Total {
				t.Fatal("unprocessed final source", source)
			}
			ev, err := s.resolveResearchSource(t.Context(), source.SourceID)
			if err != nil {
				t.Fatal(err)
			}
			originals = append(originals, ev)
			fragments := parts[source.SourceID]
			sort.Slice(fragments, func(i, j int) bool { return fragments[i].From < fragments[j].From })
			end := 0
			var body strings.Builder
			for _, f := range fragments {
				if f.From != end || f.Total != len([]rune(ev.Excerpt)) || f.Kind != ev.Kind || f.ContentHash != ev.ContentHash {
					t.Fatal("skipped, repeated, or upgraded fragment", f)
				}
				end = f.To
				body.WriteString(f.Excerpt)
			}
			if body.String() != ev.Excerpt || end != len([]rune(ev.Excerpt)) {
				t.Fatal("incomplete source text")
			}
		}
	}
	if nativeConversationFits(nativeInitialMessages(snapshot, AIInput{Prompt: jsonText(originals), SourceOnly: true}), nil, nativeInputLimit(snapshot)) {
		t.Fatal("fixture no longer exceeds full window")
	}
}

func TestResearchIdeasBatchRejectsForgedSource(t *testing.T) {
	s, topic, _ := noveltyFixture(t, "full")
	var calls atomic.Int32
	ideasModel(t, s, &calls, func(v *ResearchIdea) { v.Basis[0].EvidenceIDs = []string{"ffffffffffffffffffffffffffffffff"} })
	run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "allow-task", URLs: []string{"http://paper.example/large"}, IdeaCount: 1})
	waitIdeasFailure(t, s, run)
	out := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	if len(out["partialIdeas"].([]any)) != 0 || len(out["ideas"].([]any)) != 0 {
		t.Fatal("forged batch saved", out)
	}
}

func TestResearchIdeasBatchHistoricalPartialRemainsReadable(t *testing.T) {
	s, topic, _ := noveltyFixture(t, "full")
	var calls atomic.Int32
	ideasModel(t, s, &calls, nil)
	run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "allow-task", URLs: []string{"http://paper.example/large"}, IdeaCount: 1, Budget: ResearchBudget{MaxModelRequests: 2}})
	researchWaitJob(t, s, run, "paused")
	if _, err := s.Store.DB.Exec(`UPDATE research_evidence SET availability='stale',body=json_set(body,'$.availability','stale') WHERE run_id=?`, run); err != nil {
		t.Fatal(err)
	}
	before := calls.Load()
	out := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	if len(out["partialIdeas"].([]any)) != 1 || calls.Load() != before {
		t.Fatal("historical partial lost or GET started model", out)
	}
	for _, key := range []string{"usage", "control", "snapshot", "units", "fingerprint", "rows"} {
		if _, ok := out[key]; ok {
			t.Fatal("private batch leaked", key)
		}
	}
	partial := out["partialIdeas"].([]any)[0].(map[string]any)
	basis := partial["basis"].([]any)[0].(map[string]any)
	sid := basis["evidenceIds"].([]any)[0].(string)
	if _, err := s.resolveResearchSource(t.Context(), sid); err == nil {
		t.Fatal("stale historical source usable for model/navigation")
	}
}
