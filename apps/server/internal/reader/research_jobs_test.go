package reader

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestResearchCreateRejectionIsKnownNotCreated(t *testing.T) {
	s, topic, _ := researchFixture(t)
	session := paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions", `{"title":"Rejection"}`, 201)["id"].(string)
	input := ResearchRunInput{UserMessageID: id(), Question: "https://example.org/paper", Mode: "question", Network: "inherit", URLs: []string{"https://example.org/paper"}}
	result := paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions/"+session+"/runs", jsonText(input), 400)
	if result["code"] != "research_create_rejected" {
		t.Fatalf("ambiguous rejection: %v", result)
	}
	var count int
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_runs WHERE session_id=?`, session).Scan(&count); err != nil || count != 0 {
		t.Fatalf("run persisted: %d %v", count, err)
	}
}

// Real completion HTTP plus SQLite: dropping a control response must never
// replay a paid run, and a successfully committed unit survives a new attempt.
func researchJobModel(t *testing.T, s *Server, calls *atomic.Int32, block chan struct{}, observe ...func(string, int32)) *httptest.Server {
	t.Helper()
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"test"}]}`)
			return
		}
		calls.Add(1)
		var in struct {
			Model    string                  `json:"model"`
			Messages []toolCompletionMessage `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		for _, fn := range observe {
			fn(in.Model, calls.Load())
		}
		if block != nil {
			select {
			case <-block:
			case <-r.Context().Done():
				return
			}
		}
		result := `{"content":"资料不足，未验证全文。","sourceIds":[]}`
		for _, msg := range in.Messages {
			text, ok := msg.Content.(string)
			if !ok {
				continue
			}
			marker := strings.Index(text, "RESEARCH_EVIDENCE_JSON\n")
			if marker >= 0 {
				var ev []struct {
					SourceID string `json:"sourceId"`
				}
				_ = json.Unmarshal([]byte(text[marker+len("RESEARCH_EVIDENCE_JSON\n"):]), &ev)
				if len(ev) > 0 {
					result = jsonText(researchCardFacts{Problem: ResearchFact{Text: "Observed fact", EvidenceIDs: []string{ev[0].SourceID}}})
				}
			}
			if marker := strings.Index(text, "RESEARCH_CARDS_JSON\n"); marker >= 0 {
				var items []researchCompositionItem
				if json.Unmarshal([]byte(text[marker+len("RESEARCH_CARDS_JSON\n"):]), &items) == nil {
					for _, item := range items {
						if len(item.Fact.EvidenceIDs) > 0 {
							source := item.Fact.EvidenceIDs[0]
							result = jsonText(researchReportSection{Content: "Measured result [" + source + "]", SourceIDs: []string{source}})
							break
						}
					}
				}
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": result}, "finish_reason": "stop"}}})+"\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(endpoint.Close)
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":null},"models":{"chat":"test"}}`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return endpoint
}
func researchCreateJob(t *testing.T, s *Server, topic string, budget int) (string, string, string) {
	t.Helper()
	session := paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions", `{"title":"Review"}`, 201)["id"].(string)
	body := fmt.Sprintf(`{"userMessageId":"%s","question":"Compare the evidence","mode":"compare","network":"deny","budget":{"maxModelRequests":%d,"maxSearchRequests":24,"maxRemoteReads":8,"maxMinutes":30}}`, id(), budget)
	path := "/api/research/topics/" + topic + "/sessions/" + session + "/runs"
	run := paperCall(t, s, "POST", path, body, 201)["id"].(string)
	return run, path, body
}
func researchWaitJob(t *testing.T, s *Server, run, status string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		r := paperCall(t, s, "GET", "/api/research/runs/"+run, "", 200)
		if r["status"] == status {
			return r
		}
		if r["status"] == "failed" {
			t.Fatalf("run failed: %+v", r)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("run did not become %s", status)
	return nil
}
func TestResearchRunIdempotencyAndLostResponse(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, path, body := researchCreateJob(t, s, topic, 200)
	if calls.Load() != 0 {
		t.Fatal("create performed inference")
	}
	if again := paperCall(t, s, "POST", path, body, 201)["id"]; again != run {
		t.Fatal("duplicate run", again)
	}
	paperCall(t, s, "POST", path, strings.Replace(body, "Compare the evidence", "Changed question", 1), 409)
	control := `{"requestId":"` + id() + `"}`
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", control, 202)
	r := researchWaitJob(t, s, run, "completed")
	before := calls.Load()
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", control, 200)
	if calls.Load() != before || r["latestReportId"] == nil {
		t.Fatal("lost response replayed or report missing")
	}
	report := paperCall(t, s, "GET", "/api/research/reports/"+r["latestReportId"].(string), "", 200)
	if report["origin"] != "model" {
		t.Fatal(report)
	}
}
func TestResearchResumeSuccessfulUnits(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, _, _ := researchCreateJob(t, s, topic, 1)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	researchWaitJob(t, s, run, "paused")
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
	resume := `{"requestId":"` + id() + `","budget":{"maxModelRequests":1,"maxSearchRequests":24,"maxRemoteReads":8,"maxMinutes":30}}`
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", resume, 202)
	researchWaitJob(t, s, run, "completed")
	if calls.Load() != 2 {
		t.Fatal("successful paper repeated", calls.Load())
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", resume, 200)
	if calls.Load() != 2 {
		t.Fatal("resume replay charged")
	}
}
func TestResearchUserReportRevision(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, _, _ := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	r := researchWaitJob(t, s, run, "completed")
	path := "/api/research/reports/" + r["latestReportId"].(string)
	before := paperCall(t, s, "GET", path, "", 200)
	count := calls.Load()
	body := `{"requestId":"` + id() + `","content":"User revision [ffffffffffffffffffffffffffffffff]"}`
	edited := paperCall(t, s, "POST", path+"/revisions", body, 201)
	if edited["origin"] != "user" || edited["id"] == before["id"] || len(edited["sourceIds"].([]any)) != len(before["sourceIds"].([]any)) {
		t.Fatal(edited)
	}
	if again := paperCall(t, s, "POST", path+"/revisions", body, 201); again["id"] != edited["id"] {
		t.Fatal("revision replay")
	}
	paperCall(t, s, "POST", path+"/revisions", strings.Replace(body, "User revision", "changed", 1), 409)
	if after := paperCall(t, s, "GET", path, "", 200); after["content"] != before["content"] || calls.Load() != count {
		t.Fatal("edited model version")
	}
}

func TestResearchRunInitialCoverageAndUsage(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, _, _ := researchCreateJob(t, s, topic, 1)
	r := paperCall(t, s, "GET", "/api/research/runs/"+run, "", 200)
	if r["coverage"].(map[string]any)["totalUnits"].(float64) != 2 {
		t.Fatal("native page totals missing before reading", r)
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	r = researchWaitJob(t, s, run, "paused")
	usage, ok := r["usage"].(map[string]any)
	if !ok || usage["modelRequests"] != float64(1) || usage["attemptRequests"] != float64(1) {
		t.Fatal("durable accounting not exposed", r)
	}
	call := usage["calls"].([]any)[0].(map[string]any)
	if call["models"].([]any)[0].(map[string]any)["tokens"] != nil {
		t.Fatal("unknown usage fabricated")
	}
}
func TestResearchRunSameMessageIDAcrossSessions(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	first, _, body := researchCreateJob(t, s, topic, 200)
	session := paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions", `{"title":"Other"}`, 201)["id"].(string)
	second := paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions/"+session+"/runs", body, 201)
	if second["id"] == first {
		t.Fatal("idempotency leaked across sessions")
	}
}
func TestResearchResumeQuickPauseNoBudgetReplay(t *testing.T) {
	s, topic, _ := researchFixture(t)
	for _, title := range []string{"extra one", "extra two"} {
		p := paperCreate(t, s, title)
		paperCall(t, s, "PATCH", "/api/papers/"+p, `{"folders":["ML"],"metadata":{"abstract":"Measured data"}}`, 200)
	}
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, _, _ := researchCreateJob(t, s, topic, 1)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	researchWaitJob(t, s, run, "paused")
	resume := `{"requestId":"` + id() + `"}`
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", resume, 202)
	researchWaitJob(t, s, run, "paused")
	if calls.Load() != 2 {
		t.Fatal("successful unit repeated", calls.Load())
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", resume, 200)
	time.Sleep(25 * time.Millisecond)
	if calls.Load() != 2 {
		t.Fatal("same accepted resume reopened budget", calls.Load())
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`","budget":{"maxModelRequests":200,"maxSearchRequests":24,"maxRemoteReads":8,"maxMinutes":30}}`, 202)
	researchWaitJob(t, s, run, "completed")
	if calls.Load() != 4 {
		t.Fatal("successful units recomputed", calls.Load())
	}
}
func TestResearchRunSlotsTopicAndDetachedEvents(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	release := make(chan struct{})
	researchJobModel(t, s, &calls, release)
	runs := []string{}
	for i := 0; i < 3; i++ {
		p := paperCreate(t, s, fmt.Sprintf("p%d", i))
		folder := fmt.Sprintf("group%d", i)
		paperCall(t, s, "PATCH", "/api/papers/"+p, `{"folders":["`+folder+`"],"metadata":{"abstract":"fact"}}`, 200)
		tp := paperCall(t, s, "POST", "/api/research/topics", `{"title":"group","folder":"`+folder+`"}`, 201)["id"].(string)
		run, _, _ := researchCreateJob(t, s, tp, 200)
		runs = append(runs, run)
		paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
		if i == 0 {
			other, _, _ := researchCreateJob(t, s, tp, 200)
			paperCall(t, s, "POST", "/api/research/runs/"+other+"/start", `{"requestId":"`+id()+`"}`, 409)
		}
	}
	_ = topic
	deadline := time.Now().Add(time.Second)
	for calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if calls.Load() != 2 {
		close(release)
		t.Fatal("global two slots violated", calls.Load())
	}
	host := httptest.NewServer(s.Handler())
	defer host.Close()
	ctx, cancel := context.WithCancel(t.Context())
	req, _ := http.NewRequestWithContext(ctx, "GET", host.URL+"/api/research/runs/"+runs[0]+"/events", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	_ = s.publishResearchEvent(runs[0], "activity", map[string]string{"phase": "reading"})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	cancel()
	resp.Body.Close()
	time.Sleep(25 * time.Millisecond)
	if calls.Load() != 2 {
		close(release)
		t.Fatal("disconnect altered scheduling")
	}
	close(release)
	for _, run := range runs {
		researchWaitJob(t, s, run, "completed")
	}
	if calls.Load() != 6 {
		t.Fatal("disconnected run lost or replayed", calls.Load())
	}
}
func TestResearchRunEventResetAndCommitAtomicity(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	old, path, body := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+old+"/start", `{"requestId":"`+id()+`"}`, 202)
	prior := researchWaitJob(t, s, old, "completed")
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_research_window BEFORE UPDATE ON research_conversations BEGIN SELECT RAISE(ABORT,'window save failed'); END`); err != nil {
		t.Fatal(err)
	}
	var input ResearchRunInput
	_ = json.Unmarshal([]byte(body), &input)
	input.UserMessageID = id()
	run := paperCall(t, s, "POST", path, jsonText(input), 201)["id"].(string)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, _ := s.getResearchRun(t.Context(), run)
		if r.Status == "failed" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	var n int
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_reports WHERE run_id=?`, run).Scan(&n); err != nil || n != 0 {
		t.Fatal("report escaped atomic save", n, err)
	}
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_messages WHERE run_id=? AND json_extract(body,'$.role')='assistant'`, run).Scan(&n); err != nil || n != 0 {
		t.Fatal("successful message escaped save", n, err)
	}
	paperCall(t, s, "GET", "/api/research/reports/"+prior["latestReportId"].(string), "", 200)
	before := calls.Load()
	if _, err := s.Store.DB.Exec(`DROP TRIGGER reject_research_window`); err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`"}`, 202)
	researchWaitJob(t, s, run, "completed")
	if calls.Load() != before {
		t.Fatal("successful section replayed after failed final transaction", calls.Load(), before)
	}
	for i := 0; i < 9; i++ {
		if err := s.publishResearchEvent(old, "draft", strings.Repeat("x", 1<<20)); err != nil {
			t.Fatal(err)
		}
	}
	w := request(t, s, "GET", "/api/research/runs/"+old+"/events?after=0", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "event: reset") {
		t.Fatal("missing replay reset", w.Code)
	}
	if strings.Contains(w.Body.String(), "event: done") {
		t.Fatal("dropped terminal event invented")
	}
}

func TestResearchRunModesAndDefaultBudget(t *testing.T) {
	for _, mode := range []string{"overview", "compare", "question"} {
		t.Run(mode, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			var calls atomic.Int32
			researchJobModel(t, s, &calls, nil)
			session := paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions", `{"title":"Modes"}`, 201)["id"].(string)
			r, err := s.createResearchRun(t.Context(), topic, session, ResearchRunInput{UserMessageID: id(), Question: "Explain evidence", Mode: mode, Network: "deny"})
			if err != nil {
				t.Fatal(err)
			}
			stored, err := readResearchRecord(t.Context(), s.Store.DB, r.ID)
			if err != nil || stored.Input.IdeaCount != 3 || stored.Input.Budget != (ResearchBudget{200, 24, 8, 30}) {
				t.Fatal("defaults", stored, err)
			}
			paperCall(t, s, "POST", "/api/research/runs/"+r.ID+"/start", `{"requestId":"`+id()+`"}`, 202)
			done := researchWaitJob(t, s, r.ID, "completed")
			report := paperCall(t, s, "GET", "/api/research/reports/"+done["latestReportId"].(string), "", 200)
			if report["kind"] != mode || calls.Load() != 2 {
				t.Fatal("mode failed", report, calls.Load())
			}
		})
	}
}
func TestResearchRunCreateGetRecoveryNeverResolveCatalog(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); http.Error(w, "unexpected", 500) }))
	defer endpoint.Close()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":"test-private-value"},"models":{"chat":"test"}}`))
	if err != nil {
		t.Fatal(err)
	}
	run, _, _ := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "GET", "/api/research/runs/"+run, "", 200)
	if err = s.recoverResearch(); err != nil {
		t.Fatal(err)
	}
	for _, b := range []ResearchBudget{{MaxModelRequests: 1001}, {MaxSearchRequests: 101}, {MaxRemoteReads: 51}, {MaxMinutes: 121}, {MaxMinutes: -1}} {
		if _, err := normalizeResearchBudget(b); err == nil {
			t.Fatal("budget over limit accepted", b)
		}
	}
	var raw string
	if err = s.Store.DB.QueryRow(`SELECT body FROM research_runs WHERE id=?`, run).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 || strings.Contains(raw, "test-private-value") {
		t.Fatal("preflight performed IO or serialized secret", calls.Load())
	}
}
func TestResearchUserReportMarkdownBoundary(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, _, _ := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	r := researchWaitJob(t, s, run, "completed")
	parent := r["latestReportId"].(string)
	if _, err := s.createResearchReportRevision(t.Context(), parent, id(), strings.Repeat("x", researchReportBytes+1)); err == nil {
		t.Fatal("oversized report accepted")
	}
	edited, err := s.createResearchReportRevision(t.Context(), parent, id(), `<script>bad()</script> ![remote](https://example.invalid/image) [unknown-source]`)
	if err != nil {
		t.Fatal(err)
	}
	response := request(t, s, "GET", "/api/research/reports/"+edited.ID+"/markdown", nil)
	text := response.Body.String()
	if response.Code != 200 || strings.Contains(text, "<script>") || strings.Contains(text, "](https://") || !strings.Contains(text, "来源：user") || calls.Load() != 2 {
		t.Fatal("export/revision boundary", response.Code, text, calls.Load())
	}
}
func TestResearchRunEventProtocol(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, _, _ := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	researchWaitJob(t, s, run, "completed")
	response := request(t, s, "GET", "/api/research/runs/"+run+"/events", nil)
	foundDone := false
	for _, frame := range strings.Split(response.Body.String(), "\n\n") {
		var event string
		var data map[string]any
		for _, line := range strings.Split(frame, "\n") {
			if strings.HasPrefix(line, "event: ") {
				event = strings.TrimPrefix(line, "event: ")
			}
			if strings.HasPrefix(line, "data: ") {
				_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &data)
			}
		}
		switch event {
		case "done":
			foundDone = true
			if data["ok"] != true {
				t.Fatal("done contract changed", data)
			}
		case "draft":
			if _, ok := data["reset"].(bool); !ok {
				t.Fatal("draft reset missing", data)
			}
		case "activity":
			if _, ok := data["message"].(string); !ok {
				t.Fatal("activity message missing", data)
			}
		}
	}
	if !foundDone {
		t.Fatal("completed report had no done event", response.Body.String())
	}
}
func TestResearchRunOwnerChecks(t *testing.T) {
	s, topic, paper := researchFixture(t)
	a := researchRunFixture(t, s, topic)
	other := paperCall(t, s, "POST", "/api/research/topics", `{"title":"other","folder":"ML"}`, 201)["id"].(string)
	b := researchRunFixture(t, s, other)
	tx, err := s.Store.DB.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	ev := ResearchEvidence{ID: id(), TopicID: b.TopicID, SnapshotID: b.SnapshotID, RunID: a.ID, PaperID: paper, DocumentID: "doc", Availability: "valid", Location: json.RawMessage(`{}`)}
	if writeResearchEvidence(t.Context(), tx, ev) == nil {
		t.Fatal("cross-owner evidence accepted")
	}
	ev.TopicID = a.TopicID
	ev.SnapshotID = a.SnapshotID
	ev.PaperID = ""
	ev.Kind = "local-page"
	if writeResearchEvidence(t.Context(), tx, ev) == nil {
		t.Fatal("local evidence without paper owner accepted")
	}
	report := ResearchReport{ID: id(), TopicID: b.TopicID, SessionID: b.SessionID, SourceRunID: a.ID, RunID: a.ID, SourceRevision: a.Revision, SourceIDs: []string{}}
	if writeResearchReport(t.Context(), tx, report, "") == nil {
		t.Fatal("cross-owner report accepted")
	}
	if writeResearchMessage(t.Context(), tx, ResearchMessage{ID: id(), SessionID: b.SessionID, RunID: a.ID}) == nil {
		t.Fatal("cross-owner message accepted")
	}
	if writeResearchUnit(t.Context(), tx, ResearchUnit{RunID: a.ID, UnitKey: "paper:foreign", Kind: "paper", Status: "complete", Result: json.RawMessage(jsonText(ResearchPaperCard{PaperID: "foreign"}))}) == nil {
		t.Fatal("cross-owner unit accepted")
	}
	if writeResearchConversation(t.Context(), tx, a.ID, ResearchConversation{SessionID: b.SessionID, Revision: a.Revision, ConnectionKey: "test"}) == nil {
		t.Fatal("cross-owner conversation accepted")
	}
	scope, e := readResearchRunScope(t.Context(), tx, a.ID)
	if e != nil {
		t.Fatal(e)
	}
	m, e := scope.member(paper)
	if e != nil {
		t.Fatal(e)
	}
	card := ResearchPaperCard{PaperID: paper, DocumentID: m.DocumentID, Revision: m.CorpusRevision, Level: m.Coverage, Problem: ResearchFact{Text: "unsupported", EvidenceIDs: []string{"foreign-source"}}}
	if writeResearchUnit(t.Context(), tx, ResearchUnit{RunID: a.ID, UnitKey: "paper:" + paper, Kind: "paper", Status: "complete", Result: json.RawMessage(jsonText(card))}) == nil {
		t.Fatal("unit accepted fact with unowned evidence")
	}
}

func TestResearchResumeOldPauseCannotCancelNewAttempt(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	researchJobModel(t, s, &calls, nil, func(_ string, n int32) {
		if n == 2 {
			close(entered)
			<-release
		}
	})
	run, _, _ := researchCreateJob(t, s, topic, 1)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	researchWaitJob(t, s, run, "paused")
	pause := `{"requestId":"` + id() + `"}`
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/pause", pause, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`"}`, 202)
	<-entered
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/pause", pause, 202)
	s.researchMu.Lock()
	w := s.researchWorkers[run]
	canceled := w == nil || w.ctx.Err() != nil
	s.researchMu.Unlock()
	if canceled {
		t.Fatal("old accepted pause canceled later attempt")
	}
}

func TestResearchRunExpiredAttemptCannotReadOrPublish(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, _, _ := researchCreateJob(t, s, topic, 200)
	r, e := readResearchRecord(t.Context(), s.Store.DB, run)
	if e != nil {
		t.Fatal(e)
	}
	r.Status = "queued"
	r.AttemptStarted = time.Now().Add(-2 * time.Minute).UTC().Format(time.RFC3339Nano)
	r.AttemptBudget = ResearchBudget{MaxModelRequests: 200, MaxMinutes: 1}
	tx, e := s.Store.DB.BeginTx(t.Context(), nil)
	if e != nil {
		t.Fatal(e)
	}
	if e = writeResearchRecord(t.Context(), tx, r); e != nil {
		tx.Rollback()
		t.Fatal(e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	scope, e := readResearchRunScope(t.Context(), s.Store.DB, run)
	if e != nil {
		t.Fatal(e)
	}
	w, e := s.registerResearchWorker(scope)
	if e != nil {
		t.Fatal(e)
	}
	s.executeResearch(w, &researchAttempt{server: s, runID: run, snapshot: nativeTaskSnapshot{Model: "test", ContextWindow: 8192}})
	current, e := s.getResearchRun(t.Context(), run)
	if e != nil || current.Status != "paused" || calls.Load() != 0 {
		t.Fatal("expired attempt continued", current, e)
	}
	var n int
	if e = s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=?`, run).Scan(&n); e != nil || n != 0 {
		t.Fatal("expired attempt read and saved sources", n, e)
	}
}

func TestResearchResumePauseCancelRestartAndChangedScope(t *testing.T) {
	for _, action := range []string{"pause", "cancel", "restart"} {
		t.Run(action, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			var calls atomic.Int32
			researchJobModel(t, s, &calls, nil)
			run, _, _ := researchCreateJob(t, s, topic, 1)
			paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
			researchWaitJob(t, s, run, "paused")
			var successful string
			if err := s.Store.DB.QueryRow(`SELECT body FROM research_units WHERE run_id=? AND kind='paper'`, run).Scan(&successful); err != nil {
				t.Fatal(err)
			}
			if action == "restart" {
				s.Close()
				if _, err := s.Store.DB.Exec(`UPDATE research_runs SET status='running',body=json_set(body,'$.status','running') WHERE id=?`, run); err != nil {
					t.Fatal(err)
				}
				root := s.Store.Root
				s.Store.DB.Close()
				store, err := OpenStore(root)
				if err != nil {
					t.Fatal(err)
				}
				defer store.DB.Close()
				s = NewServer(store, "test-secret", "")
				defer s.Close()
				r := paperCall(t, s, "GET", "/api/research/runs/"+run, "", 200)
				if r["status"] != "interrupted" || calls.Load() != 1 {
					t.Fatal("restart replayed work", r, calls.Load())
				}
			} else {
				paperCall(t, s, "POST", "/api/research/runs/"+run+"/"+action, `{"requestId":"`+id()+`"}`, 200)
			}
			paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`","budget":{"maxModelRequests":200,"maxSearchRequests":24,"maxRemoteReads":8,"maxMinutes":30}}`, 202)
			researchWaitJob(t, s, run, "completed")
			var preserved string
			_ = s.Store.DB.QueryRow(`SELECT body FROM research_units WHERE run_id=? AND kind='paper'`, run).Scan(&preserved)
			if successful != preserved || calls.Load() != 2 {
				t.Fatal("successful unit changed or replayed", calls.Load())
			}
		})
	}
	for _, change := range []string{"new-paper", "model", "snapshot"} {
		t.Run(change, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			var calls atomic.Int32
			endpoint := researchJobModel(t, s, &calls, nil)
			run, _, _ := researchCreateJob(t, s, topic, 1)
			paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
			researchWaitJob(t, s, run, "paused")
			switch change {
			case "new-paper":
				p := paperCreate(t, s, "New member")
				paperCall(t, s, "PATCH", "/api/papers/"+p, `{"folders":["ML"]}`, 200)
			case "model":
				_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`"},"models":{"chat":"changed"}}`))
				if err != nil {
					t.Fatal(err)
				}
			case "snapshot":
				paperCall(t, s, "PATCH", "/api/research/topics/"+topic, `{"folder":"other"}`, 200)
			}
			paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`"}`, 409)
			if calls.Load() != 1 {
				t.Fatal("conflict charged")
			}
		})
	}
}
func TestResearchRunWholeAttemptModelFrozen(t *testing.T) {
	s, topic, _ := researchFixture(t)
	p := paperCreate(t, s, "Other abstract")
	paperCall(t, s, "PATCH", "/api/papers/"+p, `{"folders":["ML"],"metadata":{"abstract":"fact"}}`, 200)
	var calls atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	endpoint := researchJobModel(t, s, &calls, release, func(model string, n int32) {
		if model != "test" {
			t.Errorf("attempt switched model: %s", model)
		}
		if n == 1 {
			close(entered)
		}
	})
	run, _, _ := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	<-entered
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`"},"models":{"chat":"changed"}}`))
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	researchWaitJob(t, s, run, "completed")
	if calls.Load() != 3 {
		t.Fatal(calls.Load())
	}
}
func TestResearchRunInvalidationPreservesActualUsage(t *testing.T) {
	s, topic, paper := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, _, _ := researchCreateJob(t, s, topic, 1)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	researchWaitJob(t, s, run, "paused")
	paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"title":"changed source"}`, 200)
	r := paperCall(t, s, "GET", "/api/research/runs/"+run, "", 200)
	usage := r["usage"].(map[string]any)
	if usage["modelRequests"] != float64(1) || len(usage["calls"].([]any)) != 1 {
		t.Fatal("invalidation erased billed history", r)
	}
}
func TestResearchRunControlCannotOverwriteWorkerCommit(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	release := make(chan struct{})
	researchJobModel(t, s, &calls, release)
	run, _, _ := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	deadline := time.Now().Add(time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	stale, err := readResearchRecord(t.Context(), s.Store.DB, run)
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	before := researchWaitJob(t, s, run, "completed")
	after, err := s.acceptResearchControl(t.Context(), stale, "control:"+id(), "hash", "start")
	if err != nil || after.Status != "completed" || after.LatestReportID != before["latestReportId"] {
		t.Fatal("in-flight no-op control overwrote worker commit", after, err)
	}
	current, err := s.getResearchRun(t.Context(), run)
	if err != nil || current.Usage.ModelRequests != 2 {
		t.Fatal("control rolled back accounting", current, err)
	}
}
func TestResearchRunPauseCancelsCatalog(t *testing.T) {
	s, topic, _ := researchFixture(t)
	entered := make(chan struct{})
	released := make(chan struct{})
	defer close(released)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			close(entered)
			select {
			case <-r.Context().Done():
			case <-released:
			}
			return
		}
		t.Error("inference happened before canceled catalog")
	}))
	defer endpoint.Close()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":null},"models":{"chat":"test"}}`))
	if err != nil {
		t.Fatal(err)
	}
	run, _, _ := researchCreateJob(t, s, topic, 200)
	started := make(chan error, 1)
	go func() {
		_, e := s.controlResearchRun(t.Context(), run, "start", ResearchControl{RequestID: id()})
		started <- e
	}()
	<-entered
	paused := make(chan error, 1)
	go func() {
		_, e := s.controlResearchRun(t.Context(), run, "pause", ResearchControl{RequestID: id()})
		paused <- e
	}()
	select {
	case err := <-paused:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		s.Close()
		<-started
		t.Fatal("pause blocked behind catalog resolution")
	}
	<-started
	r := paperCall(t, s, "GET", "/api/research/runs/"+run, "", 200)
	if r["status"] != "paused" {
		t.Fatal(r)
	}
}
func TestResearchRunFailedCompactionBudgetAndUnknownUsage(t *testing.T) {
	s, topic, _ := researchFixture(t)
	run := researchRunFixture(t, s, topic)
	var calls atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, nativeFixtureFrame("openai", "partial"))
	}))
	defer endpoint.Close()
	r, err := readResearchRecord(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	r.Attempt = 1
	r.AttemptStarted = now()
	r.AttemptBudget = ResearchBudget{MaxModelRequests: 1, MaxMinutes: 30}
	tx, err := s.Store.DB.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = writeResearchRecord(t.Context(), tx, r); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	attempt := &researchAttempt{server: s, runID: run.ID, snapshot: nativeTaskSnapshot{Connection: APIConnection{URL: endpoint.URL, Protocol: "openai"}, Model: "test", ContextWindow: 8192}}
	messages := []toolCompletionMessage{{Role: "system", Content: "instructions"}, {Role: "user", Content: "old question"}, {Role: "assistant", Content: strings.Repeat("old evidence ", 4000)}, {Role: "user", Content: "latest question"}}
	result, err := runNativeLoop(t.Context(), nativeLoopRequest{Snapshot: attempt.snapshot, Input: AIInput{UsageProvider: "api", UsageSink: attempt.usage}, Window: nativeConversation{Messages: messages}, Budget: nativeLoopBudget{ReserveCall: attempt.reserve}}, nil)
	if err == nil || result.Result.Text != "" || calls.Load() != 1 {
		t.Fatal("partial compaction produced answer", result, err, calls.Load())
	}
	if err = attempt.reserve(t.Context()); !errors.Is(err, errResearchBudget) {
		t.Fatal("failed request did not spend budget", err)
	}
	current, err := s.getResearchRun(t.Context(), run.ID)
	if err != nil || current.Usage.ModelRequests != 1 || len(current.Usage.Calls) != 1 || current.Usage.Calls[0].Models[0].Tokens != nil {
		t.Fatal("failed/unknown compaction accounting lost", current, err)
	}
}
func TestResearchRunConversationRetainsSuccessfulHistory(t *testing.T) {
	s, topic, _ := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, path, body := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	r := researchWaitJob(t, s, run, "completed")
	var input ResearchRunInput
	_ = json.Unmarshal([]byte(body), &input)
	input.UserMessageID = id()
	input.Question = "Follow up on the prior distinction"
	second := paperCall(t, s, "POST", path, jsonText(input), 201)["id"].(string)
	paperCall(t, s, "POST", "/api/research/runs/"+second+"/start", `{"requestId":"`+id()+`"}`, 202)
	researchWaitJob(t, s, second, "completed")
	var raw string
	if err := s.Store.DB.QueryRow(`SELECT body FROM research_conversations WHERE session_id=?`, r["sessionId"]).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "Compare the evidence") || !strings.Contains(raw, "Follow up on the prior distinction") {
		t.Fatal("persistent conversation discarded prior complete turn", raw)
	}
	response := request(t, s, "GET", "/api/research/sessions/"+r["sessionId"].(string)+"/messages", nil)
	var history []ResearchMessage
	if json.Unmarshal(response.Body.Bytes(), &history) != nil || len(history) != 4 {
		t.Fatal("visible history incomplete", response.Body.String())
	}
}
