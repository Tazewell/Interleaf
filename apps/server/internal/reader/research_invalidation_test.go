package reader

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func seedResearchActiveState(t *testing.T, s *Server, run string) {
	t.Helper()
	stamp := now()
	var session string
	if err := s.Store.DB.QueryRow(`SELECT session_id FROM research_runs WHERE id=?`, run).Scan(&session); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`UPDATE research_runs SET status='running',body=json_set(body,'$.status','running') WHERE id=?`, run); err != nil {
		t.Fatal(err)
	}
	unit := ResearchUnit{RunID: run, UnitKey: "analysis", Kind: "card", Status: "succeeded", Result: json.RawMessage(`{"text":"private source checkpoint"}`), CreatedAt: stamp, UpdatedAt: stamp}
	raw, _ := json.Marshal(unit)
	if _, err := s.Store.DB.Exec(`INSERT INTO research_units VALUES(?,?,?,?,?,?,?)`, run, "analysis", "card", "succeeded", string(raw), stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`INSERT INTO research_units VALUES(?,?,'control','succeeded','{"result":"accepted user control"}',?,?)`, run, "control:request", stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`INSERT INTO research_conversations VALUES(?,'connection','revision','{"messages":["private source context"]}',?,?)`, session, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`INSERT INTO research_messages VALUES(?,?,?,'{"role":"user","content":"preserve question"}',?,?)`, "message-"+run, session, run, stamp, stamp); err != nil {
		t.Fatal(err)
	}
}

func assertResearchSourceState(t *testing.T, s *Server, run, want string) {
	t.Helper()
	var state, body string
	if err := s.Store.DB.QueryRow(`SELECT status,body FROM research_runs WHERE id=?`, run).Scan(&state, &body); err != nil {
		t.Fatal(err)
	}
	var r ResearchRun
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		t.Fatal(err)
	}
	expected := "interrupted"
	if want == "valid" {
		expected = "running"
	}
	if state != expected || r.Status != expected {
		t.Fatalf("run state index/json: %s/%s want %s", state, r.Status, expected)
	}
	if err := s.Store.DB.QueryRow(`SELECT status,body FROM research_units WHERE run_id=? AND unit_key='analysis'`, run).Scan(&state, &body); err != nil {
		t.Fatal(err)
	}
	var unit ResearchUnit
	json.Unmarshal([]byte(body), &unit)
	if want == "valid" {
		if state != "succeeded" || unit.Status != "succeeded" || !strings.Contains(body, "private source checkpoint") {
			t.Fatal(state, body)
		}
	} else if state != "stale" || unit.Status != "stale" || len(unit.Result) != 0 || strings.Contains(body, "private source checkpoint") {
		t.Fatal("unit payload/state", state, body)
	}
	if err := s.Store.DB.QueryRow(`SELECT availability,body FROM research_evidence WHERE id=?`, "e-"+run).Scan(&state, &body); err != nil {
		t.Fatal(err)
	}
	var evidence ResearchEvidence
	json.Unmarshal([]byte(body), &evidence)
	if state != want || evidence.Availability != want {
		t.Fatal("evidence state index/json", state, evidence.Availability, want)
	}
	if want == "removed" && (evidence.Excerpt != "" || string(evidence.Location) != "null") {
		t.Fatal("removed payload survives", body)
	}
	var n int
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_conversations WHERE session_id=(SELECT session_id FROM research_runs WHERE id=?)`, run).Scan(&n); err != nil {
		t.Fatal(err)
	}
	expectedCount := 0
	if want == "valid" {
		expectedCount = 1
	}
	if n != expectedCount {
		t.Fatal("continuation survives", n, want)
	}
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards WHERE cache_key=?`, run).Scan(&n); err != nil || n != expectedCount {
		t.Fatal("card cleanup", n, err)
	}
	if err := s.Store.DB.QueryRow(`SELECT body FROM research_units WHERE run_id=? AND unit_key='control:request'`, run).Scan(&body); err != nil || !strings.Contains(body, "accepted user control") {
		t.Fatal("control lost", body, err)
	}
	rows, err := s.Store.DB.Query(`SELECT body FROM research_reports WHERE id LIKE ?`, "report-"+run+"-%")
	if err != nil {
		t.Fatal(err)
	}
	reports := 0
	for rows.Next() {
		rows.Scan(&body)
		var report ResearchReport
		json.Unmarshal([]byte(body), &report)
		if report.Stale != (want != "valid") || !strings.HasPrefix(report.Content, "saved user research") {
			t.Fatal("report modified", report)
		}
		reports++
	}
	rows.Close()
	if reports != 2 {
		t.Fatal("reports lost", reports)
	}
	if err = s.Store.DB.QueryRow(`SELECT body FROM research_messages WHERE id=?`, "message-"+run).Scan(&body); err != nil || !strings.Contains(body, "preserve question") {
		t.Fatal("history lost", body, err)
	}
}

// Paper-only sources must invalidate the same persisted execution state as
// document sources; permanent deletion also removes readable evidence payload.
func TestResearchPaperOnlyMutationInvalidation(t *testing.T) {
	for _, action := range []string{"update", "merge", "trash", "purge"} {
		t.Run(action, func(t *testing.T) {
			s := testServer(t)
			paper := paperCreate(t, s, "Abstract source")
			paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"],"metadata":{"abstract":"source abstract"}}`, 200)
			topic := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Review","folder":"ML"}`, 201)["id"].(string)
			snap := researchSnapshot(t, s, topic)
			seedResearchResult(t, s, topic, snap, paper, "", "paper-only")
			seedResearchActiveState(t, s, "paper-only")
			switch action {
			case "update":
				paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"metadata":{"abstract":"changed abstract"}}`, 200)
			case "merge":
				target := paperCreate(t, s, "Target")
				paperCall(t, s, "POST", "/api/papers/"+target+"/merge", `{"ids":["`+paper+`"]}`, 200)
			case "trash":
				paperCall(t, s, "POST", "/api/papers/"+paper+"/trash", `{}`, 200)
			case "purge":
				if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_paper_purge BEFORE DELETE ON paper_items BEGIN SELECT RAISE(ABORT,'retain source'); END`); err != nil {
					t.Fatal(err)
				}
				paperCall(t, s, "DELETE", "/api/papers/"+paper, "", 400)
				assertResearchSourceState(t, s, "paper-only", "valid")
				s.Store.DB.Exec(`DROP TRIGGER reject_paper_purge`)
				paperCall(t, s, "DELETE", "/api/papers/"+paper, "", 204)
			}
			want := "stale"
			if action == "purge" {
				want = "removed"
			}
			assertResearchSourceState(t, s, "paper-only", want)
			// Later metadata invalidation cannot resurrect a removed source.
			if want == "removed" {
				tx, err := s.Store.DB.Begin()
				if err != nil {
					t.Fatal(err)
				}
				p := PaperItem{ID: paper}
				if err = s.Store.invalidateResearchPaperTx(context.Background(), tx, p, "later refresh"); err != nil {
					t.Fatal(err)
				}
				if err = tx.Commit(); err != nil {
					t.Fatal(err)
				}
				assertResearchSourceState(t, s, "paper-only", "removed")
			}
		})
	}
}

func TestResearchCandidateOnlyPurgeAndRollback(t *testing.T) {
	s, topic, paper := researchFixture(t)
	snap := researchSnapshot(t, s, topic)
	for _, run := range []string{"candidate-linked", "candidate-unrelated"} {
		seedResearchResult(t, s, topic, snap, paper, "", run)
		seedResearchActiveState(t, s, run)
		// Use no snapshot document selector: only candidate identity connects this
		// run to the local original that is about to be purged.
		if _, err := s.Store.DB.Exec(`UPDATE research_runs SET body=json_set(body,'$.snapshotId','') WHERE id=?`, run); err != nil {
			t.Fatal(err)
		}
		doc := "unrelated-document"
		if run == "candidate-linked" {
			doc = "doc"
		}
		body, _ := json.Marshal(map[string]string{"id": run, "documentId": doc, "abstract": "candidate payload"})
		if _, err := s.Store.DB.Exec(`INSERT INTO research_candidates VALUES(?,?,?, ?,?,?)`, run, topic, run, string(body), now(), now()); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.DB.Exec(`UPDATE research_evidence SET paper_id=NULL,document_id=NULL,candidate_id=?,body=json_remove(json_set(body,'$.candidateId',?),'$.paperId','$.documentId') WHERE id=?`, run, run, "e-"+run); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.DB.Exec(`UPDATE research_cards SET paper_id=?,document_id=NULL WHERE cache_key=?`, run, run); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.DB.Exec(`UPDATE research_cards SET body=json_set(body,'$.evidenceIds',json(?)) WHERE cache_key=?`, `["e-`+run+`"]`, run); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_candidate_purge BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT,'retain'); END`); err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "DELETE", "/api/documents/doc", "", 500)
	assertResearchSourceState(t, s, "candidate-linked", "valid")
	assertResearchSourceState(t, s, "candidate-unrelated", "valid")
	s.Store.DB.Exec(`DROP TRIGGER reject_candidate_purge`)
	paperCall(t, s, "DELETE", "/api/documents/doc", "", 204)
	assertResearchSourceState(t, s, "candidate-linked", "removed")
	assertResearchSourceState(t, s, "candidate-unrelated", "valid")
	var raw string
	if err := s.Store.DB.QueryRow(`SELECT body FROM research_candidates WHERE id='candidate-linked'`).Scan(&raw); err != nil || strings.Contains(raw, "candidate payload") || !strings.Contains(raw, `"removed"`) {
		t.Fatal(raw, err)
	}
}
