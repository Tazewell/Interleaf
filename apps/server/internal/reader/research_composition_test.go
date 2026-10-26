package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestResearchCompositionRetainedWindowResumeAndFollowup(t *testing.T) {
	s, topic, paper := researchFixture(t)
	var calls, compacts, sections atomic.Int32
	sources := []string{}
	factsSeen := map[string]bool{}
	factBytes, nearWindow := 0, 0
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var in struct {
			Messages []toolCompletionMessage `json:"messages"`
			Tools    []any                   `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
			return
		}
		if len(in.Tools) != 0 {
			t.Error("composition advertised tools")
		}
		wire := jsonText(in.Messages)
		result := ""
		if strings.Contains(fmt.Sprint(in.Messages[0].Content), "整理对话检查点") {
			compacts.Add(1)
			result = "User goal: compare all facts and preserve REQUIREMENT. Verified earlier evidence: "
			for _, sid := range sources {
				if strings.Contains(wire, sid) {
					result += "[" + sid + "] "
				}
			}
		} else {
			sections.Add(1)
			last := fmt.Sprint(in.Messages[len(in.Messages)-1].Content)
			at := strings.Index(last, "RESEARCH_CARDS_JSON\n")
			if at < 0 {
				t.Error("missing composition input")
				return
			}
			var items []researchCompositionItem
			if err := json.Unmarshal([]byte(last[at+len("RESEARCH_CARDS_JSON\n"):]), &items); err != nil {
				t.Error(err)
				return
			}
			if conversationTokens(in.Messages[len(in.Messages)-1:]) > 1700 {
				nearWindow++
			}
			for _, item := range items {
				factBytes += len(item.Fact.Text)
			}
			for _, item := range items {
				for i := 0; i < 6; i++ {
					if strings.Contains(item.Fact.Text, fmt.Sprintf("FACT-%d", i)) {
						factsSeen[fmt.Sprint(i)] = true
					}
				}
			}
			cited := []string{}
			for _, sid := range sources {
				if strings.Contains(wire, sid) {
					cited = append(cited, sid)
				}
			}
			text := "Cross-batch comparison REQUIREMENT "
			for _, sid := range cited {
				text += "[" + sid + "] "
			}
			result = jsonText(researchReportSection{Content: text + strings.Repeat("Measured comparison. ", 60), SourceIDs: cited})
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": result}, "finish_reason": "stop"}}})+"\n\ndata: [DONE]\n\n")
	}))
	defer endpoint.Close()
	snapshot := nativeTaskSnapshot{Connection: APIConnection{URL: endpoint.URL, Protocol: "openai"}, Model: "test", ContextWindow: 8192}
	session := ""
	for pass := 0; pass < 2; pass++ {
		factBytes = 0
		run := researchRunFixture(t, s, topic)
		if session != "" {
			run.SessionID = session
			_, err := s.Store.DB.Exec(`UPDATE research_runs SET session_id=?,body=? WHERE id=?`, session, jsonText(run), run.ID)
			if err != nil {
				t.Fatal(err)
			}
		} else {
			session = run.SessionID
		}
		tools, err := s.researchTools(t.Context(), run.ID)
		if err != nil {
			t.Fatal(err)
		}
		read := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": paper, "full": true})
		sources = nil
		for _, item := range read["items"].([]any) {
			sources = append(sources, item.(map[string]any)["sourceId"].(string))
		}
		if len(sources) < 2 {
			t.Fatal("fixture lacks separate evidence")
		}
		record := researchRunRecord{ResearchRun: run, Input: ResearchRunInput{Mode: "compare", Question: "REQUIREMENT compare earlier and later findings " + strings.Repeat("retain user preference ", 20)}, Attempt: 1, AttemptStarted: now(), AttemptBudget: ResearchBudget{MaxModelRequests: 2, MaxMinutes: 30}}
		if pass == 1 {
			record.AttemptBudget.MaxModelRequests = 6
		}
		scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		member, _ := scope.member(paper)
		card := ResearchPaperCard{PaperID: paper, DocumentID: member.DocumentID, Revision: member.CorpusRevision, Level: "fulltext", EvidenceIDs: sources, ReadCoverage: ResearchReadCoverage{ReadUnits: 2, TotalUnits: 2}}
		facts := researchFacts(&card)
		for i, f := range facts.fields() {
			f.Text = fmt.Sprintf("FACT-%d ", i) + strings.Repeat("measured conditions ", 300)
			f.EvidenceIDs = []string{sources[i%len(sources)]}
		}
		card.Problem, card.Method, card.Assumptions, card.DataAndEvaluation, card.Findings, card.Limitations = facts.Problem, facts.Method, facts.Assumptions, facts.DataAndEvaluation, facts.Findings, facts.Limitations
		err = s.commitResearchRead(t.Context(), scope, nil, true, func(tx *sql.Tx) error {
			if e := writeResearchRecord(t.Context(), tx, record); e != nil {
				return e
			}
			return writeResearchUnit(t.Context(), tx, ResearchUnit{RunID: run.ID, UnitKey: "paper:" + paper, Kind: "paper", Status: "complete", Result: []byte(jsonText(card))})
		})
		if err != nil {
			t.Fatal(err)
		}
		attempt := &researchAttempt{server: s, runID: run.ID, snapshot: snapshot}
		ctx := context.WithValue(t.Context(), researchAttemptKey{}, attempt)
		_, err = s.composeResearchReport(ctx, run.ID)
		if !errors.Is(err, errResearchBudget) {
			t.Fatalf("expected resumable budget after complete section, got %v", err)
		}
		var checkpoint string
		if err = s.Store.DB.QueryRow(`SELECT body FROM research_units WHERE run_id=? AND unit_key='section:0'`, run.ID).Scan(&checkpoint); err != nil {
			t.Fatal("missing complete checkpoint", err)
		}
		current, err := readResearchRecord(t.Context(), s.Store.DB, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		current.AttemptBudget.MaxModelRequests = 100
		_, err = s.Store.DB.Exec(`UPDATE research_runs SET body=? WHERE id=?`, jsonText(current), run.ID)
		if err != nil {
			t.Fatal(err)
		}
		result, err := s.composeResearchReport(ctx, run.ID)
		if err != nil {
			t.Fatal(err)
		}
		var restored string
		s.Store.DB.QueryRow(`SELECT body FROM research_units WHERE run_id=? AND unit_key='section:0'`, run.ID).Scan(&restored)
		if checkpoint != restored {
			t.Fatal("replayed successful checkpoint")
		}
		if !strings.Contains(result.Content, "["+sources[0]+"]") || !strings.Contains(result.Content, "["+sources[len(sources)-1]+"]") || !strings.Contains(result.Content, "Cross-batch comparison") {
			t.Fatal("missing earlier/later synthesis", result.Content)
		}
		if len(factsSeen) != 6 {
			t.Fatal("facts truncated", factsSeen)
		}
		expected := 0
		for _, f := range facts.fields() {
			expected += len(f.Text)
		}
		if factBytes != expected {
			t.Fatal("facts truncated or replayed", factBytes, expected)
		}
	}
	if compacts.Load() < 2 || sections.Load() < 4 || nearWindow < 2 {
		t.Fatal("window boundary not exercised", calls.Load(), compacts.Load(), sections.Load(), nearWindow)
	}
	t.Logf("model requests=%d compactions=%d sections=%d near-retained-window batches=%d", calls.Load(), compacts.Load(), sections.Load(), nearWindow)
}

func TestResearchCompositionRemoteCJKRetainedWindow(t *testing.T) {
	body := strings.Repeat("测量条件和实验结果。", 700)
	s, run, candidate, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, "<article><h2>Methods</h2><p>"+body+"</p><h2>Results</h2><p>"+body+"</p></article>")
	})
	evidence, err := s.readResearchRemote(t.Context(), run.ID, candidate.ID)
	if err != nil {
		t.Fatal(err)
	}
	expected := 0
	for _, ev := range evidence {
		expected += len(ev.Excerpt)
	}
	got, calls := 0, 0
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Messages []toolCompletionMessage `json:"messages"`
			Tools    []any                   `json:"tools"`
		}
		if e := json.NewDecoder(r.Body).Decode(&in); e != nil {
			t.Error(e)
			return
		}
		if len(in.Tools) != 0 {
			t.Error("composition advertised tools")
		}
		result := "Preserve the comparison and verified sources."
		if !strings.Contains(fmt.Sprint(in.Messages[0].Content), "整理对话检查点") {
			calls++
			last := fmt.Sprint(in.Messages[len(in.Messages)-1].Content)
			at := strings.Index(last, "RESEARCH_CARDS_JSON\n")
			if at < 0 {
				t.Error("missing cards")
				return
			}
			var items []researchCompositionItem
			if e := json.Unmarshal([]byte(last[at+len("RESEARCH_CARDS_JSON\n"):]), &items); e != nil {
				t.Error(e)
				return
			}
			ids := []string{}
			text := "Measured comparison "
			for _, item := range items {
				got += len(item.Fact.Text)
				for _, sid := range item.Fact.EvidenceIDs {
					ids = append(ids, sid)
					text += "[" + sid + "] "
				}
			}
			result = jsonText(researchReportSection{Content: text, SourceIDs: ids})
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": result}, "finish_reason": "stop"}}})+"\n\ndata: [DONE]\n\n")
	}))
	defer endpoint.Close()
	scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	record, err := readResearchRecord(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	record.Input.Mode = "compare"
	record.Input.Question = "Compare the full online evidence"
	record.AttemptBudget.MaxModelRequests = 100
	err = s.commitResearchRead(t.Context(), scope, nil, true, func(tx *sql.Tx) error {
		if e := writeResearchRecord(t.Context(), tx, record); e != nil {
			return e
		}
		for _, m := range scope.Snapshot.Members {
			card := ResearchPaperCard{PaperID: m.PaperID, DocumentID: m.DocumentID, Revision: m.CorpusRevision, Level: m.Coverage}
			if e := writeResearchUnit(t.Context(), tx, ResearchUnit{RunID: run.ID, UnitKey: "paper:" + m.PaperID, Kind: "paper", Status: "complete", Result: []byte(jsonText(card))}); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	attempt := &researchAttempt{server: s, runID: run.ID, snapshot: nativeTaskSnapshot{Connection: APIConnection{URL: endpoint.URL, Protocol: "openai"}, Model: "test", ContextWindow: 8192}}
	_, err = s.composeResearchReport(context.WithValue(t.Context(), researchAttemptKey{}, attempt), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got != expected || calls < 2 || hits.Load() != 1 {
		t.Fatal("truncated/repeated online evidence or unexpected network", got, expected, calls, hits.Load())
	}
	t.Logf("all %d online UTF-8 bytes delivered in %d sections with one authorized fetch", got, calls)
}
