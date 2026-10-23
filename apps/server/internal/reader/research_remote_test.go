package reader

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"reader.local/server/internal/scholar"
)

func remoteFixture(t *testing.T, handler http.HandlerFunc) (*Server, ResearchRun, ResearchCandidate, *atomic.Int32) {
	t.Helper()
	s, topic, _ := researchFixture(t)
	run := researchRunFixture(t, s, topic)
	record := researchRunRecord{ResearchRun: run, Input: ResearchRunInput{Network: "allow-task"}, Attempt: 1, AttemptBudget: ResearchBudget{MaxRemoteReads: 8, MaxSearchRequests: 24, MaxMinutes: 30}, AttemptStarted: now()}
	if _, err := s.Store.DB.Exec(`UPDATE research_runs SET body=? WHERE id=?`, jsonText(record), run.ID); err != nil {
		t.Fatal(err)
	}
	hits := &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); handler(w, r) }))
	t.Cleanup(srv.Close)
	c := scholar.New(64 << 20)
	c.Public = &scholar.PublicConfig{LookupIP: func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("93.184.216.34")}, nil }, Proxy: func(*http.Request) (*url.URL, error) { return nil, nil }, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "93.184.216.34:80" {
			return nil, fmt.Errorf("unpinned %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}}
	s.scholar = c
	candidate := ResearchCandidate{ID: id(), TopicID: topic, IdentityKey: "doi:10.1234/remote", Title: "Remote", DOI: "10.1234/remote", LandingURL: "http://paper.example/page", Abstract: "Only an abstract."}
	remoteRegister(t, s, run, candidate)
	return s, run, candidate, hits
}
func remoteRegister(t *testing.T, s *Server, run ResearchRun, c ResearchCandidate) {
	t.Helper()
	_, err := s.Store.DB.Exec(`INSERT INTO research_candidates(id,topic_id,identity_key,body,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`, c.ID, c.TopicID, c.IdentityKey, jsonText(c), now(), now())
	if err != nil {
		t.Fatal(err)
	}
	search := ResearchSearch{ID: id(), RunID: run.ID, Status: "ok", CandidateIDs: []string{c.ID}, FetchedAt: now()}
	_, err = s.Store.DB.Exec(`INSERT INTO research_searches(id,topic_id,run_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?)`, search.ID, run.TopicID, run.ID, jsonText(search), now(), now())
	if err != nil {
		t.Fatal(err)
	}
}

func TestResearchRemoteRegisteredOwnerAndCache(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<p>First fact.</p><script>bad()</script><p>Second fact.</p>")
	})
	var before int
	s.Store.DB.QueryRow(`SELECT count(*) FROM paper_items`).Scan(&before)
	evidence, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil || len(evidence) != 2 {
		t.Fatal(evidence, err)
	}
	if evidence[0].Kind != "remote-html" || evidence[0].Excerpt != "First fact." || evidence[0].CandidateID != c.ID || evidence[0].PaperID != "" {
		t.Fatal(evidence)
	}
	for _, ev := range evidence {
		if _, err = s.resolveResearchSource(t.Context(), ev.ID); err != nil {
			t.Fatal(err)
		}
	}
	cached, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil || cached[0].ID != evidence[0].ID || hits.Load() != 1 {
		t.Fatal(cached, err, hits.Load())
	}
	var after int
	s.Store.DB.QueryRow(`SELECT count(*) FROM paper_items`).Scan(&after)
	if before != after {
		t.Fatal("remote read imported paper")
	}
	other := researchRunFixture(t, s, run.TopicID)
	if _, err = s.readResearchRemote(t.Context(), other.ID, c.ID); err == nil {
		t.Fatal("same-topic unregistered run accepted")
	}
	s.Store.DB.Exec(`UPDATE research_candidates SET body=json_set(body,'$.abstract','changed') WHERE id=?`, c.ID)
	if _, err = s.resolveResearchSource(t.Context(), evidence[0].ID); err == nil {
		t.Fatal("candidate revision not checked")
	}
}

func TestResearchRemoteRejectsRegistrationForgeryAndRemoved(t *testing.T) {
	for _, mutation := range []string{`UPDATE research_searches SET body=json_set(body,'$.runId','other')`, `UPDATE research_searches SET body=json_set(body,'$.status','failed')`, `UPDATE research_candidates SET body=json_set(body,'$.topicId','other')`, `UPDATE research_candidates SET body=json_set(body,'$.availability','removed')`} {
		t.Run(mutation, func(t *testing.T) {
			s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "fact") })
			if _, err := s.Store.DB.Exec(mutation); err != nil {
				t.Fatal(err)
			}
			if _, err := s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil || hits.Load() != 0 {
				t.Fatal("forged/removed candidate read", err, hits.Load())
			}
		})
	}
}

func TestResearchRemoteRechecksVersionAfterDownload(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { close(entered); <-release; fmt.Fprint(w, "<p>fact</p>") })
	done := make(chan error, 1)
	go func() { _, err := s.readResearchRemote(t.Context(), run.ID, c.ID); done <- err }()
	<-entered
	s.Store.DB.Exec(`UPDATE research_candidates SET body=json_set(body,'$.updatedAt','new-version') WHERE id=?`, c.ID)
	close(release)
	if err := <-done; err == nil {
		t.Fatal("candidate race published")
	}
	var count int
	s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=?`, run.ID).Scan(&count)
	if count != 0 {
		t.Fatal(count)
	}
}

func TestResearchRemotePrefersLocalAndRechecksSource(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("local paper should not download") })
	scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	member := scope.Snapshot.Members[0]
	s.Store.DB.Exec(`UPDATE paper_items SET metadata=json_set(metadata,'$.doi',?) WHERE id=?`, c.DOI, member.PaperID)
	c.PaperID = member.PaperID
	c.DocumentID = member.DocumentID
	remoteRegister(t, s, run, c)
	evidence, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil || len(evidence) == 0 || evidence[0].Kind != "local-passage" || evidence[0].CandidateID != c.ID || hits.Load() != 0 {
		t.Fatal(evidence, err, hits.Load())
	}
	researchSetLayoutSource(t, s, member.DocumentID, "changed")
	if _, err = s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil {
		t.Fatal("stale local source fell back to remote")
	}
}

func TestResearchRemoteMetadataOnlyLocalMatchCanFetch(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<p>Public original.</p>") })
	metadataID := id()
	_, err := s.Store.DB.Exec(`INSERT INTO paper_items(id,title,metadata,created_at) VALUES(?,?,?,?)`, metadataID, c.Title, jsonText(PaperMetadata{DOI: c.DOI}), now())
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil || len(evidence) == 0 || evidence[0].Kind != "remote-html" || hits.Load() != 1 {
		t.Fatal(evidence, err, hits.Load())
	}
}

func TestResearchRemoteOutsideSnapshotLocalProvenance(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("candidate local original downloaded") })
	scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	member := scope.Snapshot.Members[0]
	s.Store.DB.Exec(`UPDATE paper_items SET metadata=json_set(metadata,'$.doi',?) WHERE id=?`, c.DOI, member.PaperID)
	// A legitimate run whose folder does not contain this existing local paper.
	snapshot := scope.Snapshot
	snapshot.Members = []ResearchMember{}
	snapshot.Revision = "empty-revision"
	s.Store.DB.Exec(`UPDATE research_snapshots SET body=?,revision=? WHERE id=?`, jsonText(snapshot), snapshot.Revision, snapshot.ID)
	s.Store.DB.Exec(`UPDATE research_runs SET body=json_set(body,'$.revision',?) WHERE id=?`, snapshot.Revision, run.ID)
	evidence, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil || len(evidence) == 0 || hits.Load() != 0 {
		t.Fatal(evidence, err, hits.Load())
	}
	ev := evidence[0]
	if ev.Kind != "local-passage" || ev.PaperID != member.PaperID || ev.DocumentID != member.DocumentID || ev.CandidateID != c.ID || !strings.Contains(string(ev.Location), `"type":"pdf"`) {
		t.Fatal(ev)
	}
	if _, err = s.resolveResearchSource(t.Context(), ev.ID); err != nil {
		t.Fatal(err)
	}
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := tools.Call(t.Context(), "read_paper_passage", json.RawMessage(jsonText(map[string]any{"paperId": member.PaperID, "full": true})))
	if err == nil && !strings.Contains(string(result.Content), "error") {
		t.Fatal("local tool scope expanded", result)
	}
	researchSetLayoutSource(t, s, member.DocumentID, "new-version")
	if _, err = s.resolveResearchSource(t.Context(), ev.ID); err == nil {
		t.Fatal("candidate local evidence resurrected changed source")
	}
	s.Store.DB.Exec(`UPDATE paper_items SET deleted_at=? WHERE id=?`, now(), member.PaperID)
	if _, err = s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil || hits.Load() != 0 {
		t.Fatal("removed local source fell back to public cache", err, hits.Load())
	}
	deleted := request(t, s, "DELETE", "/api/papers/"+member.PaperID, nil)
	if deleted.Code != 204 {
		t.Fatal(deleted.Code, deleted.Body.String())
	}
	// Emulate an explicitly resumed attempt; the folder snapshot is empty so
	// only the durable candidate/local provenance can prevent resurrection.
	s.Store.DB.Exec(`UPDATE research_runs SET status='running',body=json_set(body,'$.status','running') WHERE id=?`, run.ID)
	if _, err = s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil || hits.Load() != 0 {
		t.Fatal("purged original resurrected by public fetch", err, hits.Load())
	}
}

func remotePDFBytes() []byte {
	objects := []string{"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"}
	stream := "BT /F1 12 Tf 40 200 Td (Verified remote PDF text.) Tj ET"
	objects[3] = fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream)
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	offsets := []int{0}
	for i, o := range objects {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, o := range offsets[1:] {
		fmt.Fprintf(&b, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	return b.Bytes()
}
func remoteRealProcessor(t *testing.T) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("real PDF worker requires node:", err)
	}
	worker, err := filepath.Abs("../../../processor/dist/corpus.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(worker); err != nil {
		t.Fatal("build processor before focused remote parser test:", err)
	}
	t.Setenv("READER_NODE", node)
	t.Setenv("READER_CORPUS_PROCESSOR", worker)
}
func TestResearchRemoteRealPDFAndAbstractFallback(t *testing.T) {
	remoteRealProcessor(t)
	for _, valid := range []bool{true, false} {
		t.Run(fmt.Sprint(valid), func(t *testing.T) {
			s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/pdf")
				if valid {
					w.Write(remotePDFBytes())
				} else {
					fmt.Fprint(w, "%PDF-1.7\nnot a PDF object tree")
				}
			})
			c.PDFURL = "http://paper.example/paper.pdf"
			remoteRegister(t, s, run, c)
			evidence, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
			if err != nil || len(evidence) != 1 {
				t.Fatal(evidence, err)
			}
			if valid {
				if evidence[0].Kind != "remote-page" || !strings.Contains(evidence[0].Excerpt, "Verified remote PDF text.") {
					t.Fatal(evidence)
				}
			} else {
				if evidence[0].Kind != "remote-abstract" || evidence[0].Excerpt != "Only an abstract." {
					t.Fatal(evidence)
				}
			}
			entries, err := os.ReadDir(filepath.Join(s.Store.Root, "ai-work"))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), "research-remote-") {
					t.Fatal("owned work leaked")
				}
			}
			if _, err = s.resolveResearchSource(t.Context(), evidence[0].ID); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestResearchRemoteCloseCancelsBody(t *testing.T) {
	entered := make(chan struct{})
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(entered)
		<-r.Context().Done()
	})
	done := make(chan error, 1)
	go func() { _, err := s.readResearchRemote(context.Background(), run.ID, c.ID); done <- err }()
	<-entered
	closed := make(chan struct{})
	go func() { s.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("Close failed to join HTTP")
	}
	if err := <-done; err == nil {
		t.Fatal("canceled read saved evidence")
	}
}

func TestResearchRemoteUserURLIsExactAndBudgeted(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<p>fact</p>") })
	s.Store.DB.Exec(`DELETE FROM research_searches`)
	s.Store.DB.Exec(`UPDATE research_runs SET body=json_set(body,'$.input.urls',json(?)) WHERE id=?`, jsonText([]string{c.LandingURL}), run.ID)
	if _, err := s.readResearchRemote(t.Context(), run.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	var record researchRunRecord
	var raw string
	s.Store.DB.QueryRow(`SELECT body FROM research_runs WHERE id=?`, run.ID).Scan(&raw)
	json.Unmarshal([]byte(raw), &record)
	if record.AttemptRemoteReads != 1 || record.RemoteReads != 1 || hits.Load() != 1 {
		t.Fatal(raw, hits.Load())
	}
	c.LandingURL += "?derived=1"
	s.Store.DB.Exec(`UPDATE research_candidates SET body=? WHERE id=?`, jsonText(c), c.ID)
	if _, err := s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil || hits.Load() != 1 {
		t.Fatal("derived URL gained user privilege", err, hits.Load())
	}
}

func TestResearchRemoteBudgetAndPermissionStopIO(t *testing.T) {
	for _, deny := range []bool{false, true} {
		t.Run(fmt.Sprint(deny), func(t *testing.T) {
			s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unbudgeted I/O") })
			if deny {
				s.Store.DB.Exec(`UPDATE research_runs SET body=json_set(body,'$.input.network','deny') WHERE id=?`, run.ID)
			} else {
				s.Store.DB.Exec(`UPDATE research_runs SET body=json_set(body,'$.attemptRemoteReads',8) WHERE id=?`, run.ID)
			}
			if _, err := s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil || hits.Load() != 0 {
				t.Fatal(err, hits.Load())
			}
		})
	}
}

func TestResearchRemoteConcurrentReadsRetainEvidence(t *testing.T) {
	arrived := make(chan struct{}, 2)
	release := make(chan struct{})
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		arrived <- struct{}{}
		<-release
		fmt.Fprint(w, "<p>fact</p>")
	})
	results := make(chan []ResearchEvidence, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { ev, err := s.readResearchRemote(t.Context(), run.ID, c.ID); results <- ev; errs <- err }()
	}
	<-arrived
	<-arrived
	close(release)
	a, b := <-results, <-results
	if ea, eb := <-errs, <-errs; ea != nil || eb != nil || len(a) == 0 || len(b) == 0 || hits.Load() != 2 {
		t.Fatal(a, b, ea, eb, hits.Load())
	}
	if a[0].ID != b[0].ID {
		t.Fatal("concurrent cache replacement invalidates issued evidence")
	}
	if _, err := s.resolveResearchSource(t.Context(), a[0].ID); err != nil {
		t.Fatal(err)
	}
}

func TestResearchRemoteParserCancellationAndOwnedQuota(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "entered")
	worker := filepath.Join(t.TempDir(), "blocked.mjs")
	script := `import fs from 'node:fs'; fs.writeFileSync(process.env.READER_REMOTE_MARKER,process.cwd()); setInterval(()=>{},1000);`
	if err = os.WriteFile(worker, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("READER_NODE", node)
	t.Setenv("READER_CORPUS_PROCESSOR", worker)
	t.Setenv("READER_REMOTE_MARKER", marker)
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		w.Write(remotePDFBytes())
	})
	c.PDFURL = "http://paper.example/file.pdf"
	remoteRegister(t, s, run, c)
	releases := []func(){}
	for i := 0; i < 5; i++ {
		release, e := reserveResearchRemoteWork(run.ID)
		if e != nil {
			t.Fatal(e)
		}
		releases = append(releases, release)
	}
	if _, err = s.readResearchRemote(t.Context(), run.ID, c.ID); err == nil || hits.Load() != 0 {
		t.Fatal("quota not enforced before download", err, hits.Load())
	}
	for _, release := range releases {
		release()
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { _, e := s.readResearchRemote(ctx, run.ID, c.ID); done <- e }()
	deadline := time.After(3 * time.Second)
	var dir []byte
	for len(dir) == 0 {
		select {
		case <-deadline:
			cancel()
			t.Fatal("worker not started")
		default:
			dir, _ = os.ReadFile(marker)
			if len(dir) == 0 {
				time.Sleep(5 * time.Millisecond)
			}
		}
	}
	if !strings.HasPrefix(string(dir), filepath.Join(s.Store.Root, "ai-work", "research-remote-")) {
		t.Fatal("parser not in owned work", string(dir))
	}
	cancel()
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("canceled parser accepted")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("parser not joined")
	}
	if _, err = os.Stat(string(dir)); !os.IsNotExist(err) {
		t.Fatal("owned work leaked", err)
	}
	var count int
	s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=?`, run.ID).Scan(&count)
	if count != 0 {
		t.Fatal("partial parser saved", count)
	}
}

func TestResearchRemoteRejectsCandidateLocalPageForgery(t *testing.T) {
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected I/O") })
	ev := ResearchEvidence{ID: id(), TopicID: run.TopicID, SnapshotID: run.SnapshotID, RunID: run.ID, PaperID: "not-a-member", DocumentID: "not-a-document", CandidateID: c.ID, Kind: "local-page", Availability: "valid", Location: json.RawMessage(`{"type":"pdf","page":1}`)}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = writeResearchEvidence(t.Context(), tx, ev); err == nil {
		t.Fatal("candidate bypassed local ownership")
	}
}

func TestResearchRemoteModelReportRejectsForgedPayload(t *testing.T) {
	s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<p>fact</p>") })
	ev, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	s.Store.DB.Exec(`UPDATE research_evidence SET body=json_set(body,'$.excerpt','forged') WHERE id=?`, ev[0].ID)
	report := ResearchReport{ID: id(), TopicID: run.TopicID, SessionID: run.SessionID, RunID: run.ID, SourceRunID: run.ID, SourceRevision: run.Revision, Origin: "model", Revision: "test", SourceIDs: []string{ev[0].ID}}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = writeResearchReport(t.Context(), tx, report, ""); err == nil {
		t.Fatal("model report accepted mismatched remote payload")
	}
}

func TestResearchRemoteArxivIdentityBoundaries(t *testing.T) {
	for _, tc := range []struct {
		candidate, local string
		match            bool
	}{
		{"solv-int/9701002", "solv-int/9701001", false},
		{"solv-int/9701001", "solv-int/9701001v1", true},
		{"1706.03762v10", "1706.03762v1", true},
		{"1706.03762vbad", "1706.03762v1", false},
		{"solv-int/9701001vbad", "solv-int/9701001vbad", false},
	} {
		t.Run(tc.candidate+"_"+tc.local, func(t *testing.T) {
			s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<p>Remote paper.</p>") })
			scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			member := scope.Snapshot.Members[0]
			if _, err = s.Store.DB.Exec(`UPDATE paper_items SET metadata=json_set(metadata,'$.arxiv',?) WHERE id=?`, tc.local, member.PaperID); err != nil {
				t.Fatal(err)
			}
			c.DOI, c.ArXiv = "", tc.candidate
			remoteRegister(t, s, run, c)
			ev, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
			if err != nil || len(ev) == 0 {
				t.Fatal(ev, err)
			}
			if (ev[0].Kind == "local-passage") != tc.match || (hits.Load() == 0) != tc.match {
				t.Fatalf("wrong scholarly identity: match=%v hits=%d evidence=%+v", tc.match, hits.Load(), ev[0])
			}
			if _, err = s.resolveResearchSource(t.Context(), ev[0].ID); err != nil {
				t.Fatal(err)
			}
			if tc.match {
				s.Store.DB.Exec(`UPDATE paper_items SET metadata=json_set(metadata,'$.arxiv','solv-int/9701999') WHERE id=?`, member.PaperID)
				if _, err = s.resolveResearchSource(t.Context(), ev[0].ID); err == nil {
					t.Fatal("source accepted changed arxiv identity")
				}
			}
		})
	}
}

func TestResearchRemoteMIMEClassification(t *testing.T) {
	remoteRealProcessor(t)
	for _, tc := range []struct {
		name, mime string
		body       []byte
		kind       string
	}{
		{"json", "application/json", []byte(`{"error":"unavailable"}`), "remote-abstract"},
		{"image", "image/png", []byte("image data"), "remote-abstract"},
		{"binary", "application/octet-stream", []byte{0, 1, 2}, "remote-abstract"},
		{"html", "text/html", []byte("<p>Article.</p>"), "remote-html"},
		{"xhtml", "application/xhtml+xml", []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><p>Article.</p></html>`), "remote-html"},
		{"missing-html", "", []byte("<!doctype html><p>Article.</p>"), "remote-html"},
		{"missing-pdf", "", remotePDFBytes(), "remote-page"},
		{"generic-pdf", "application/octet-stream", remotePDFBytes(), "remote-page"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, run, c, _ := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header()["Content-Type"] = nil
				if tc.mime != "" {
					w.Header().Set("Content-Type", tc.mime)
				}
				w.Write(tc.body)
			})
			ev, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
			if err != nil || len(ev) != 1 || ev[0].Kind != tc.kind {
				t.Fatalf("wrong evidence class: want=%s got=%+v err=%v", tc.kind, ev, err)
			}
			if _, err = s.resolveResearchSource(t.Context(), ev[0].ID); err != nil {
				t.Fatal(err)
			}
		})
	}
}
