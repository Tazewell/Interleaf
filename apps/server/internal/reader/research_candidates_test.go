package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http/httptest"

	"net/http"
	"os"

	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestResearchCandidatesImportHistoryAndDeleteClosure(t *testing.T) {
	var hits atomic.Int32
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			http.Error(w, "unavailable", 404)
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		w.Write(testPDF(2))
	})
	c.PDFURL = "http://paper.example/file.pdf"
	remoteRegister(t, s, run, c)
	ev, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	report := ResearchReport{ID: id(), TopicID: run.TopicID, SessionID: run.SessionID, RunID: run.ID, SourceRunID: run.ID, Origin: "model", Content: "Keep historical result", SourceIDs: []string{ev[0].ID}, Revision: "old", CreatedAt: now()}
	if _, err = s.Store.DB.Exec(`INSERT INTO research_reports(id,topic_id,session_id,run_id,revision,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, report.ID, report.TopicID, report.SessionID, report.RunID, report.Revision, jsonText(report), now(), now()); err != nil {
		t.Fatal(err)
	}
	imported, err := s.importResearchCandidate(t.Context(), run.TopicID, c.ID, id())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.resolveResearchSource(t.Context(), ev[0].ID); err != nil {
		t.Fatal("import invalidated public provenance", err)
	}
	current, err := readResearchReport(t.Context(), s.Store.DB, report.ID)
	if err != nil || current.Stale {
		t.Fatal("pure identity mapping made report stale", current, err)
	}
	if _, code, message := s.moveToTrash(t.Context(), imported.ID); message != "" {
		t.Fatal(code, message)
	}
	current, err = readResearchReport(t.Context(), s.Store.DB, report.ID)
	if err != nil || !current.Stale || current.Content != report.Content {
		t.Fatal("deletion lost history or stayed fresh", current, err)
	}
	if _, err = s.resolveResearchSource(t.Context(), ev[0].ID); err == nil {
		t.Fatal("deleted source stayed valid")
	}
	if _, err = s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil {
		t.Fatal("candidate cache resurrected deleted original")
	}
	if hits.Load() != 2 {
		t.Fatal("deleted original downloaded again")
	}
}

func TestResearchCandidatesMappingPreservesExistingVersion(t *testing.T) {
	c := ResearchCandidate{ID: "candidate", TopicID: "topic", IdentityKey: "doi:10.1234/old", Title: "Original", DOI: "10.1234/old", Aliases: []string{}}
	raw := jsonText(c)
	// Existing Task7 evidence used this exact hash, not a reordered map encoding.
	want := sourceKey(researchRemoteProtocol + "\n" + raw)
	if got := researchCandidateVersion(raw); got != want {
		t.Fatal("old evidence version changed before import")
	}
	c.PaperID = "local-paper"
	c.DocumentID = "local-original"
	if researchCandidateVersion(jsonText(c)) != want {
		t.Fatal("identity mapping invalidates original public evidence")
	}
	c.Abstract = "changed actual metadata"
	if researchCandidateVersion(jsonText(c)) == want {
		t.Fatal("metadata update did not version evidence")
	}
}

func TestResearchCandidatesCompletedImportAtomicRollbackAndIdentity(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		if r.URL.Path == "/two.pdf" {
			w.Write(testPDF(3))
		} else {
			w.Write(testPDF(2))
		}
	})
	c.PDFURL = "http://paper.example/one.pdf"
	remoteRegister(t, s, run, c)
	if _, err := s.Store.DB.Exec(`UPDATE research_runs SET status='completed',body=json_set(body,'$.status','completed') WHERE id=?`, run.ID); err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "PATCH", "/api/research/sessions/"+run.SessionID+"/network", `{"allowed":false}`, 204)
	var before int
	s.Store.DB.QueryRow(`SELECT count(*) FROM documents`).Scan(&before)
	// Real SQLite failure after the Document/file preparation must roll it all back.
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_research_import BEFORE INSERT ON research_units WHEN new.kind='candidate-import' BEGIN SELECT RAISE(ABORT,'test rollback'); END`); err != nil {
		t.Fatal(err)
	}
	requestID := id()
	if _, err := s.importResearchCandidate(t.Context(), run.TopicID, c.ID, requestID); err == nil {
		t.Fatal("failed transaction reported success")
	}
	var after int
	s.Store.DB.QueryRow(`SELECT count(*) FROM documents`).Scan(&after)
	if after != before {
		t.Fatal("Document survived rollback")
	}
	dID := sourceKey(string(testPDF(2)))[:32]
	if _, err := os.Stat(s.Store.File(Document{ID: dID, Type: "pdf"})); err == nil {
		t.Fatal("original survived rollback")
	}
	s.Store.DB.Exec(`DROP TRIGGER reject_research_import`)
	imported, err := s.importResearchCandidate(t.Context(), run.TopicID, c.ID, requestID)
	if err != nil {
		t.Fatal(err)
	}
	papers, err := s.Store.EnsureCitationKeys([]string{imported.PaperID})
	if err != nil {
		t.Fatal(err)
	}
	stable := papers[0]
	// A new explicit action deduplicates by DOI and retains original/citation key.
	again, err := s.importResearchCandidate(t.Context(), run.TopicID, c.ID, id())
	if err != nil || again.ID != imported.ID || again.CitationKey != stable.CitationKey {
		t.Fatal(again, err)
	}
	if hits.Load() != 2 {
		t.Fatal("dedup fetched again", hits.Load())
	}
	other := c
	other.ID = id()
	other.IdentityKey = "doi:10.1234/another"
	other.DOI = "10.1234/another"
	other.PDFURL = "http://paper.example/two.pdf"
	remoteRegister(t, s, run, other)
	different, err := s.importResearchCandidate(t.Context(), run.TopicID, other.ID, id())
	if err != nil || different.PaperID == imported.PaperID {
		t.Fatal("same title merged", different, err)
	}
	current, err := s.Store.PaperItem(imported.PaperID)
	if err != nil || current.PrimaryDocumentID != stable.PrimaryDocumentID || current.CitationKey != stable.CitationKey {
		t.Fatal("existing user identity changed", current, err)
	}
}

func TestResearchCandidatesRevokeAndCloseJoinDownloads(t *testing.T) {
	for _, action := range []string{"revoke", "close"} {
		t.Run(action, func(t *testing.T) {
			entered := make(chan struct{})
			abort := make(chan struct{})
			s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				select {
				case <-r.Context().Done():
				case <-abort:
				}
			})
			t.Cleanup(func() { close(abort) })
			c.PDFURL = "http://paper.example/one.pdf"
			remoteRegister(t, s, run, c)
			done := make(chan error, 1)
			go func() {
				_, err := s.importResearchCandidate(context.Background(), run.TopicID, c.ID, id())
				done <- err
			}()
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("download not entered")
			}
			if action == "revoke" {
				if err := s.setResearchNetwork(t.Context(), run.SessionID, false); err != nil {
					t.Fatal(err)
				}
			} else {
				s.Close()
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("late import")
				}
			case <-time.After(time.Second):
				t.Fatal("lifecycle did not join")
			}
			var n int
			s.Store.DB.QueryRow(`SELECT count(*) FROM research_units WHERE kind='candidate-import'`).Scan(&n)
			if n != 0 {
				t.Fatal("late result")
			}
		})
	}
}

func TestResearchCandidatesStableRegistrationAndOwner(t *testing.T) {
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		w.Write(testPDF(2))
	})
	c.PDFURL = "http://paper.example/one.pdf"
	remoteRegister(t, s, run, c)
	other := researchRunFixture(t, s, run.TopicID)
	remoteRegister(t, s, other, c)
	s.Store.DB.Exec(`UPDATE research_searches SET created_at='2026-01-01T00:00:00Z' WHERE run_id=?`, run.ID)
	s.Store.DB.Exec(`UPDATE research_searches SET created_at='2026-02-01T00:00:00Z' WHERE run_id=?`, other.ID)
	request := id()
	if _, err := s.importResearchCandidate(t.Context(), run.TopicID, c.ID, request); err != nil {
		t.Fatal(err)
	}
	u, err := readResearchUnit(t.Context(), s.Store.DB, other.ID, "import:"+request)
	if err != nil {
		t.Fatal("latest registration not selected", err)
	}
	var result researchImportResult
	if json.Unmarshal(u.Result, &result) != nil || result.SessionID != other.SessionID {
		t.Fatal(result)
	}
	if _, err := readResearchUnit(t.Context(), s.Store.DB, run.ID, "import:"+request); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("import stored on older owner", err)
	}
}

func TestResearchCandidatesDoNotImportUntilChosen(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		w.Write(testPDF(2))
	})
	c.PDFURL = "http://paper.example/file.pdf?sig=private"
	remoteRegister(t, s, run, c)
	var papers, documents, keys int
	s.Store.DB.QueryRow(`SELECT count(*) FROM paper_items`).Scan(&papers)
	s.Store.DB.QueryRow(`SELECT count(*) FROM documents`).Scan(&documents)
	s.Store.DB.QueryRow(`SELECT count(*) FROM paper_citation_keys`).Scan(&keys)
	// Listing candidates must neither import nor expose operational URL secrets.
	w := request(t, s, "GET", "/api/research/topics/"+run.TopicID+"/candidates", nil)
	if w.Code != 200 {
		t.Fatalf("candidate list: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private") {
		t.Fatal("signed candidate URL leaked")
	}
	path := "/api/research/topics/" + run.TopicID + "/candidates/" + c.ID + "/import"
	body := `{"requestId":"` + id() + `"}`
	imported := paperCall(t, s, "POST", path, body, 200)
	replay := paperCall(t, s, "POST", path, body, 200)
	if imported["id"] != replay["id"] || hits.Load() != 1 {
		t.Fatal("import replay downloaded or duplicated", imported, replay, hits.Load())
	}
	var np, nd, nk int
	s.Store.DB.QueryRow(`SELECT count(*) FROM paper_items`).Scan(&np)
	s.Store.DB.QueryRow(`SELECT count(*) FROM documents`).Scan(&nd)
	s.Store.DB.QueryRow(`SELECT count(*) FROM paper_citation_keys`).Scan(&nk)
	if np != papers+1 || nd != documents+1 || nk != keys {
		t.Fatal("unexpected library writes", np, nd, nk)
	}
	other := c
	other.ID = id()
	other.IdentityKey = "doi:10.1000/different"
	other.DOI = "10.1000/different"
	remoteRegister(t, s, run, other)
	paperCall(t, s, "POST", "/api/research/topics/"+run.TopicID+"/candidates/"+other.ID+"/import", body, 409)
	foreign := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Other","folder":"ML","includeChildren":false,"networkAllowed":false}`, 201)["id"].(string)
	paperCall(t, s, "POST", "/api/research/topics/"+foreign+"/candidates/"+c.ID+"/import", `{"requestId":"`+id()+`"}`, 409)
	d, err := s.Store.Document(imported["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(s.Store.File(d)); err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "POST", path, body, 409)
	if _, err = s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil {
		t.Fatal("imported deleted original revived from candidate")
	}
	if hits.Load() != 1 {
		t.Fatal("deleted original redownloaded")
	}
}

func TestResearchCandidatesImportCanceledWhileLockQueued(t *testing.T) {
	downloaded := make(chan struct{})
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		w.Write(testPDF(2))
		close(downloaded)
	})
	c.PDFURL = "http://paper.example/file.pdf"
	remoteRegister(t, s, run, c)
	s.importMu.Lock()
	locked := true
	defer func() {
		if locked {
			s.importMu.Unlock()
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() {
		r, _ := http.NewRequestWithContext(ctx, "POST", "http://127.0.0.1:17840/api/research/topics/"+run.TopicID+"/candidates/"+c.ID+"/import", strings.NewReader(`{"requestId":"`+id()+`"}`))
		r.Header.Set("Authorization", "Bearer "+s.Token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		done <- w.Code
	}()
	select {
	case <-downloaded:
	case code := <-done:
		t.Fatalf("import did not download: %d", code)
	case <-time.After(3 * time.Second):
		t.Fatal("no download")
	}
	cancel()
	select {
	case code := <-done:
		if code == 200 {
			t.Fatal("canceled import succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled import remained blocked on importMu")
	}
	s.importMu.Unlock()
	locked = false
	var count int
	s.Store.DB.QueryRow(`SELECT count(*) FROM research_units WHERE kind='candidate-import'`).Scan(&count)
	if count != 0 {
		t.Fatal("late import record")
	}
}
