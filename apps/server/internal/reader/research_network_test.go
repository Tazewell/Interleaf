package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reader.local/server/internal/scholar"
	"strings"
	"testing"
	"time"
)

type researchQueuedClock struct{ entered chan struct{} }

func (c researchQueuedClock) Now() time.Time { return time.Unix(1000, 0) }
func (c researchQueuedClock) Sleep(ctx context.Context, _ time.Duration) error {
	close(c.entered)
	<-ctx.Done()
	return ctx.Err()
}
func TestResearchNetworkRevocationJoinsLimiterQueue(t *testing.T) {
	s, run, _, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok","message-type":"work-list","message":{"items-per-page":5,"total-results":0,"items":[]}}`)
	})
	clock := researchQueuedClock{entered: make(chan struct{})}
	s.scholar.Public.Clock = clock
	s.scholar.Public.Limiter = scholar.NewSourceLimiter(clock)
	s.scholar.Crossref = "http://paper.example/works"
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tools.Call(t.Context(), "search_papers_online", []byte(`{"source":"crossref","query":"graph learning"}`)); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, e := tools.Call(t.Context(), "search_papers_online", []byte(`{"source":"crossref","query":"graph methods"}`))
		done <- e
	}()
	select {
	case <-clock.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("limiter wait not entered")
	}
	if err = s.setResearchNetwork(t.Context(), run.SessionID, false); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("revoked queue accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("queued request not joined")
	}
	if hits.Load() != 1 {
		t.Fatal("queue issued late HTTP", hits.Load())
	}
	var searches int
	s.Store.DB.QueryRow(`SELECT count(*) FROM research_searches WHERE run_id=? AND json_extract(body,'$.source')='crossref'`, run.ID).Scan(&searches)
	if searches != 1 {
		t.Fatal("late search committed")
	}
}

func TestResearchNetworkRevocationJoinsParser(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "entered")
	worker := filepath.Join(t.TempDir(), "blocked.mjs")
	if err = os.WriteFile(worker, []byte(`import fs from 'node:fs';fs.writeFileSync(process.env.READER_REMOTE_MARKER,process.cwd());setInterval(()=>{},1000);`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("READER_NODE", node)
	t.Setenv("READER_CORPUS_PROCESSOR", worker)
	t.Setenv("READER_REMOTE_MARKER", marker)
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		w.Write(remotePDFBytes())
	})
	c.PDFURL = "http://paper.example/source.pdf"
	remoteRegister(t, s, run, c)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, e := s.readResearchRemote(ctx, run.ID, c.ID); done <- e }()
	var work []byte
	deadline := time.Now().Add(3 * time.Second)
	for len(work) == 0 && time.Now().Before(deadline) {
		work, _ = os.ReadFile(marker)
		if len(work) == 0 {
			time.Sleep(5 * time.Millisecond)
		}
	}
	if len(work) == 0 {
		t.Fatal("real parser process not entered")
	}
	if err = s.setResearchNetwork(t.Context(), run.SessionID, false); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("revoked parser published")
		}
	case <-time.After(time.Second):
		t.Fatal("parser not joined")
	}
	if _, err = os.Stat(string(work)); !os.IsNotExist(err) {
		t.Fatal("owned parser directory survived", err)
	}
	var n int
	s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=?`, run.ID).Scan(&n)
	if n != 0 {
		t.Fatal("late evidence")
	}
}

func TestResearchNetworkExplicitURLRegistration(t *testing.T) {
	s, seed, _, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<p>User supplied paper.</p>") })
	r, err := readResearchRecord(t.Context(), s.Store.DB, seed.ID)
	if err != nil {
		t.Fatal(err)
	}
	r.Input.URLs = []string{"http://paper.example/user?signature=private"}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = writeResearchRecord(t.Context(), tx, r); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = s.acquireResearchOnline(t.Context(), seed.ID); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Fatal("explicit URL did not read exactly once", hits.Load())
	}
	rows, err := s.Store.DB.Query(`SELECT body FROM research_evidence WHERE run_id=? AND candidate_id IS NOT NULL`, seed.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var raw string
		rows.Scan(&raw)
		if strings.Contains(raw, "private") {
			t.Fatal("signed URL leaked to source")
		}
		count++
	}
	if count != 1 {
		t.Fatal("registered URL evidence missing")
	}
}

func TestResearchNetworkCandidateWriterRejectsOwnerForgery(t *testing.T) {
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected HTTP") })
	scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	c.ID = id()
	c.IdentityKey = "doi:10.1000/forged"
	c.TopicID = "foreign"
	tx, err := s.Store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = writeResearchCandidate(t.Context(), tx, scope, c); err == nil {
		t.Fatal("foreign candidate accepted")
	}
}

func TestResearchRemoteEvidenceCrossSourceIdentity(t *testing.T) {
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected HTTP") })
	c.IdentityKey = "arxiv:2410.12345"
	c.ArXiv = "2410.12345v1"
	c.DOI = "10.1234/shared"
	s.Store.DB.Exec(`DELETE FROM research_candidates WHERE id=?`, c.ID)
	remoteRegister(t, s, run, c)
	scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	crossref := ResearchCandidate{ID: id(), TopicID: run.TopicID, IdentityKey: "doi:10.1234/shared", DOI: "10.1234/shared", Title: "Published title", Aliases: []string{"doi:10.1234/shared"}}
	var got ResearchCandidate
	err = s.commitResearchRead(t.Context(), scope, nil, true, func(tx *sql.Tx) error {
		var e error
		got, e = writeResearchCandidate(t.Context(), tx, scope, crossref)
		return e
	})
	if err != nil || got.ID != c.ID || got.ArXiv != c.ArXiv {
		t.Fatal("same scholarly identity split across sources", got, err)
	}
}

// Exercise the accepted create/start worker, model HTTP, scholarly HTTP and
// committed report. Tool registration without run integration fails here.
func TestResearchNetworkRunAcquiresAndReportsEvidence(t *testing.T) {
	for _, permission := range []string{"deny", "allow-task"} {
		t.Run(permission, func(t *testing.T) {
			s, seed, _, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/works" {
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, `{"status":"ok","message-type":"work-list","message":{"items-per-page":5,"total-results":1,"items":[{"DOI":"10.1000/run","title":["Public Graph"],"abstract":"Abstract evidence","URL":"http://paper.example/full?signature=secret"}]}}`)
				} else if r.URL.Path == "/arxiv" {
					http.Error(w, "no source", 404)
				} else {
					fmt.Fprint(w, "<p>Verified public result.</p>")
				}
			})
			s.scholar.Crossref = "http://paper.example/works"
			s.scholar.ArXivAPI = "http://paper.example/arxiv"
			// The seed run is fixture registration only; the task below must use its
			// own search registration and its own accepted model snapshot.
			s.Store.DB.Exec(`UPDATE research_runs SET status='canceled',body=json_set(body,'$.status','canceled') WHERE id=?`, seed.ID)
			model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					fmt.Fprint(w, `{"data":[{"id":"test"}]}`)
					return
				}
				var body struct {
					Messages []toolCompletionMessage `json:"messages"`
				}
				json.NewDecoder(r.Body).Decode(&body)
				result := `{"content":"不足","sourceIds":[]}`
				for _, m := range body.Messages {
					p, ok := m.Content.(string)
					if !ok {
						continue
					}
					if strings.Contains(p, "RESEARCH_NETWORK_QUERY") {
						if strings.Contains(p, "SECRET_PDF") {
							t.Error("planning received private source")
						}
						result = `{"query":"graph learning"}`
					}
					if i := strings.Index(p, "RESEARCH_NETWORK_CANDIDATES_JSON\n"); i >= 0 {
						var cs []ResearchCandidate
						json.Unmarshal([]byte(p[i+len("RESEARCH_NETWORK_CANDIDATES_JSON\n"):]), &cs)
						ids := []string{}
						for _, c := range cs {
							ids = append(ids, c.ID)
						}
						result = jsonText(map[string]any{"candidateIds": ids})
					}
					if i := strings.Index(p, "RESEARCH_EVIDENCE_JSON\n"); i >= 0 {
						var ev []struct {
							SourceID string `json:"sourceId"`
						}
						json.Unmarshal([]byte(p[i+len("RESEARCH_EVIDENCE_JSON\n"):]), &ev)
						if len(ev) > 0 {
							result = jsonText(researchCardFacts{Problem: ResearchFact{Text: "Local fact", EvidenceIDs: []string{ev[0].SourceID}}})
						}
					}
					if i := strings.Index(p, "RESEARCH_CARDS_JSON\n"); i >= 0 {
						var items []researchCompositionItem
						json.Unmarshal([]byte(p[i+len("RESEARCH_CARDS_JSON\n"):]), &items)
						part := researchReportSection{SourceIDs: []string{}}
						for _, item := range items {
							for _, id := range item.Fact.EvidenceIDs {
								part.SourceIDs = append(part.SourceIDs, id)
								part.Content += "Evidence [" + id + "]\n"
							}
						}
						result = jsonText(part)
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": result}, "finish_reason": "stop"}}})+"\n\ndata: [DONE]\n\n")
			}))
			t.Cleanup(model.Close)
			t.Cleanup(s.Close)
			if _, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+model.URL+`","key":"MODEL_PRIVATE_KEY"},"models":{"chat":"test"}}`)); err != nil {
				t.Fatal(err)
			}
			session := paperCall(t, s, "POST", "/api/research/topics/"+seed.TopicID+"/sessions", `{"title":"Online"}`, 201)["id"].(string)
			run := paperCall(t, s, "POST", "/api/research/topics/"+seed.TopicID+"/sessions/"+session+"/runs", `{"userMessageId":"`+id()+`","question":"graph learning","mode":"question","network":"`+permission+`","budget":{}}`, 201)["id"].(string)
			if hits.Load() != 0 {
				t.Fatal("creation fetched scholarly data")
			}
			paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
			done := researchWaitJob(t, s, run, "completed")
			report := paperCall(t, s, "GET", "/api/research/reports/"+done["latestReportId"].(string), "", 200)
			var remote int
			for _, v := range report["sourceIds"].([]any) {
				var kind string
				s.Store.DB.QueryRow(`SELECT json_extract(body,'$.kind') FROM research_evidence WHERE id=?`, v).Scan(&kind)
				if kind == "remote-html" {
					remote++
				}
			}
			if permission == "allow-task" {
				if remote == 0 || hits.Load() < 3 {
					t.Fatalf("run skipped online evidence: sources=%v hits=%d", report["sourceIds"], hits.Load())
				}
				if !strings.Contains(report["content"].(string), "arxiv") {
					t.Fatal("failed source missing from report")
				}
			} else if hits.Load() != 0 || remote != 0 {
				t.Fatal("local run accessed public services")
			}
		})
	}
}

func TestResearchRemoteEvidenceSearchReadAndSafeDisplay(t *testing.T) {
	s, run, _, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("model credential reached scholarly request")
		}
		if r.URL.Path == "/works" {
			if r.URL.Query().Get("query") != "graph learning" {
				t.Errorf("nonminimal query: %s", r.URL.RawQuery)
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"ok","message-type":"work-list","message":{"items-per-page":5,"total-results":1,"next-cursor":"next","items":[{"DOI":"10.1000/graph","title":["Graph"],"abstract":"<p>Summary</p>","URL":"http://paper.example/graph?signature=private#secret"}]}}`)
		} else {
			fmt.Fprint(w, "<p>Verified graph evidence.</p>")
		}
	})
	s.scholar.Crossref = "http://paper.example/works"
	var before string
	if err := s.Store.DB.QueryRow(`SELECT (SELECT count(*) FROM documents)||':'||(SELECT count(*) FROM paper_items)||':'||(SELECT count(*) FROM paper_citation_keys)`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	tool, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := tool.Call(t.Context(), "search_papers_online", []byte(`{"source":"crossref","query":"graph learning","limit":5}`))
	if err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Items []ResearchCandidate `json:"items"`
	}
	if json.Unmarshal(result.Content, &reply) != nil || len(reply.Items) != 1 {
		t.Fatalf("no candidates: %s", result.Content)
	}
	if strings.Contains(string(result.Content), "private") || strings.Contains(string(result.Content), "secret") {
		t.Fatal("signed URL leaked")
	}
	result, err = tool.Call(t.Context(), "read_online_paper", []byte(`{"candidateId":"`+reply.Items[0].ID+`"}`))
	if err != nil || !strings.Contains(string(result.Content), "Verified graph evidence.") {
		t.Fatal(string(result.Content), err)
	}
	if hits.Load() != 2 {
		t.Fatal(hits.Load())
	}
	var searches int
	s.Store.DB.QueryRow(`SELECT count(*) FROM research_searches WHERE run_id=? AND json_extract(body,'$.source')='crossref' AND json_extract(body,'$.status')='ok'`, run.ID).Scan(&searches)
	if searches != 1 {
		t.Fatal("search audit missing")
	}
	var after string
	if err := s.Store.DB.QueryRow(`SELECT (SELECT count(*) FROM documents)||':'||(SELECT count(*) FROM paper_items)||':'||(SELECT count(*) FROM paper_citation_keys)`).Scan(&after); err != nil || after != before {
		t.Fatal("search/read mutated library", before, after, err)
	}
}

func TestResearchRemoteEvidenceLevels(t *testing.T) {
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "unavailable", 404) })
	ev, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil || len(ev) != 1 || ev[0].Kind != "remote-abstract" {
		t.Fatal(ev, err)
	}
	var location map[string]any
	json.Unmarshal(ev[0].Location, &location)
	if location["type"] != "abstract" || location["abstractOnly"] != true {
		t.Fatal(location)
	}
	other := c
	other.ID = id()
	other.IdentityKey = "doi:10.1000/second"
	other.DOI = "10.1000/second"
	remoteRegister(t, s, run, other)
	second, err := s.readResearchRemote(t.Context(), run.ID, other.ID)
	if err != nil || second[0].ID == ev[0].ID || second[0].CandidateID == ev[0].CandidateID {
		t.Fatal("cross-paper source collision", second, err)
	}
}

func TestResearchRemoteEvidenceLimitedSearchAudit(t *testing.T) {
	s, run, _, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "rate", 429) })
	s.scholar.Crossref = "http://paper.example/works"
	tool, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := tool.Call(t.Context(), "search_papers_online", []byte(`{"source":"crossref","query":"graph learning","limit":5}`))
	if err != nil || !strings.Contains(string(result.Content), `"status":"limited"`) {
		t.Fatal(string(result.Content), err)
	}
	record, err := readResearchRecord(t.Context(), s.Store.DB, run.ID)
	if err != nil || record.SearchRequests != 3 || hits.Load() != 3 {
		t.Fatal("retry not charged", record.SearchRequests, hits.Load(), err)
	}
}

func TestResearchRemoteEvidenceSearchReplyCursor(t *testing.T) {
	s, run, _, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		items := []any{}
		for i := 0; i < 5; i++ {
			items = append(items, map[string]any{"DOI": fmt.Sprintf("10.1000/long%d", i), "title": []string{"Long result"}, "abstract": strings.Repeat("Measured result. ", 1800)})
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, jsonText(map[string]any{"status": "ok", "message-type": "work-list", "message": map[string]any{"items-per-page": 5, "total-results": 5, "items": items}}))
	})
	s.scholar.Crossref = "http://paper.example/works"
	tool, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	cursor := ""
	seen := map[string]bool{}
	for step := 0; step < 8; step++ {
		result, e := tool.Call(t.Context(), "search_papers_online", json.RawMessage(jsonText(researchOnlineQuery{Source: "crossref", Query: "graph learning", Limit: 5, Cursor: cursor})))
		if e != nil {
			t.Fatal(e)
		}
		if len(result.Content) > 64<<10 {
			t.Fatal("oversized reply")
		}
		var reply struct {
			Items []ResearchCandidate `json:"items"`
			Next  string              `json:"nextCursor"`
		}
		if json.Unmarshal(result.Content, &reply) != nil {
			t.Fatal("bad reply")
		}
		for _, c := range reply.Items {
			if seen[c.ID] {
				t.Fatal("cursor duplicated candidate")
			}
			seen[c.ID] = true
		}
		cursor = reply.Next
		if cursor == "" {
			break
		}
	}
	if len(seen) != 5 || cursor != "" || hits.Load() != 1 {
		t.Fatal("cursor silently truncated/repeated search", len(seen), cursor, hits.Load())
	}
}

func TestResearchRemoteEvidenceUpdatedCandidateInvalidatesHistory(t *testing.T) {
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<p>Original evidence.</p>") })
	ev, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	report := ResearchReport{ID: id(), TopicID: run.TopicID, SessionID: run.SessionID, RunID: run.ID, SourceRunID: run.ID, Origin: "model", Content: "Preserved history", SourceIDs: []string{ev[0].ID}, Revision: "old", CreatedAt: now()}
	if _, err = s.Store.DB.Exec(`INSERT INTO research_reports(id,topic_id,session_id,run_id,revision,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, report.ID, report.TopicID, report.SessionID, report.RunID, report.Revision, jsonText(report), now(), now()); err != nil {
		t.Fatal(err)
	}
	scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	c.Abstract = "New actual abstract"
	c.UpdatedAt = "2026-10-24"
	err = s.commitResearchRead(t.Context(), scope, nil, true, func(tx *sql.Tx) error { _, e := writeResearchCandidate(t.Context(), tx, scope, c); return e })
	if err != nil {
		t.Fatal(err)
	}
	got, err := readResearchReport(t.Context(), s.Store.DB, report.ID)
	if err != nil || !got.Stale || got.Content != report.Content {
		t.Fatal("updated candidate lost history or stayed fresh", got, err)
	}
	if _, err = s.resolveResearchSource(t.Context(), ev[0].ID); err == nil {
		t.Fatal("old source stayed valid")
	}
}

// Removing the generation guard must fail even when the remote cache is warm.
func TestResearchNetworkPermissionAndRevocation(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<p>Public evidence.</p>") })
	ev, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil || len(ev) != 1 {
		t.Fatal(ev, err)
	}
	paperCall(t, s, "PATCH", "/api/research/sessions/"+run.SessionID+"/network", `{"allowed":false}`, 204)
	if _, err = s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil {
		t.Fatal("revoked allow-task reused cache")
	}
	if hits.Load() != 1 {
		t.Fatal("revoked request performed HTTP")
	}
	if _, err = s.resolveResearchSource(t.Context(), ev[0].ID); err != nil {
		t.Fatal("revocation erased historical evidence", err)
	}
	paperCall(t, s, "PATCH", "/api/research/sessions/"+run.SessionID+"/network", `{"allowed":true}`, 204)
	if _, err = s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil {
		t.Fatal("reenabling revived an old task grant")
	}
}

func TestResearchNetworkRevocationJoinsDownload(t *testing.T) {
	entered, exited := make(chan struct{}), make(chan struct{})
	abort := make(chan struct{})
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-r.Context().Done():
		case <-abort:
		}
		close(exited)
	})
	t.Cleanup(func() { close(abort) })
	done := make(chan error, 1)
	go func() { _, err := s.readResearchRemote(context.Background(), run.ID, c.ID); done <- err }()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("download not started")
	}
	paperCall(t, s, "PATCH", "/api/research/sessions/"+run.SessionID+"/network", `{"allowed":false}`, 204)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("late evidence returned")
		}
	default:
		t.Fatal("revoke returned before reader joined")
	}
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("HTTP not canceled")
	}
	var count int
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=?`, run.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
}

func TestResearchNetworkDeniedCacheAndModelGrant(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<p>Fact.</p>") })
	if _, err := s.Store.DB.Exec(`UPDATE research_runs SET body=json_set(body,'$.input.network','deny') WHERE id=?`, run.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil {
		t.Fatal("deny allowed evidence")
	}
	tool, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := tool.Call(t.Context(), "read_online_paper", []byte(`{"candidateId":"`+c.ID+`","network":"allow-task"}`))
	if err == nil && string(result.Content) == "" {
		t.Fatal("model grant was accepted")
	}
	if hits.Load() != 0 {
		t.Fatal("denied request performed HTTP")
	}
}
