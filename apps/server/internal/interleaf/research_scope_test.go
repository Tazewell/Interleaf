package interleaf

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A hard-coded recursive default or permission escalation breaks these API assertions.
func TestResearchFolderTopicAndSessionContract(t *testing.T) {
	s := testServer(t)
	paperCall(t, s, "PUT", "/api/preferences/library", `{"papers":{"subcategoryItems":false}}`, 200)
	topic := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Review","folder":"ML"}`, 201)
	if topic["includeChildren"] != false || topic["networkAllowed"] != false || topic["scopeState"] != "active" {
		t.Fatal(topic)
	}
	tid := topic["id"].(string)
	paperCall(t, s, "PATCH", "/api/research/topics/"+tid, `{"includeChildren":true,"networkAllowed":true,"title":"Changed"}`, 200)
	session := paperCall(t, s, "POST", "/api/research/topics/"+tid+"/sessions", `{"title":"Question"}`, 201)
	if session["topicId"] != tid || session["networkAllowed"] != true {
		t.Fatal(session)
	}
	paperCall(t, s, "PATCH", "/api/research/topics/"+tid, `{"networkAllowed":false}`, 200)
	w := request(t, s, "GET", "/api/research/topics/"+tid+"/sessions", nil)
	var sessions []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &sessions); w.Code != 200 || err != nil || len(sessions) != 1 || sessions[0]["networkAllowed"] != true {
		t.Fatal(w.Code, w.Body.String(), err)
	}
	for _, body := range []string{`{"title":"","folder":"ML"}`, `{"title":"x","folder":"ML//bad"}`} {
		paperCall(t, s, "POST", "/api/research/topics", body, 400)
	}
	paperCall(t, s, "GET", "/api/research/topics/missing", "", 404)
	paperCall(t, s, "POST", "/api/research/topics/missing/sessions", `{"title":"x"}`, 404)
	list := request(t, s, "GET", "/api/research/topics", nil)
	if list.Code != 200 || !strings.Contains(list.Body.String(), tid) {
		t.Fatal(list.Code, list.Body.String())
	}
}

func researchSnapshot(t *testing.T, s *Server, topicID string) ResearchSnapshot {
	t.Helper()
	snap, err := s.snapshotResearchScope(context.Background(), topicID)
	if err != nil {
		t.Fatal(err)
	}
	return snap
}
func researchSetLayoutSource(t *testing.T, s *Server, documentID, source string) {
	t.Helper()
	d, err := s.Store.Document(documentID)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(s.Store.File(d), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.analysisDir(documentID), "manifest.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["inputSHA256"] = sourceKey(source)
	data, _ = json.Marshal(manifest)
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}
func researchFixture(t *testing.T) (*Server, string, string) {
	t.Helper()
	s := textFixture(t)
	researchSetLayoutSource(t, s, "doc", "source-A")
	d, err := s.Store.Document("doc")
	if err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "PATCH", "/api/papers/"+d.PaperID, `{"folders":["ML"],"citationKey":"Stable2026"}`, 200)
	topic := paperCall(t, s, "POST", "/api/research/topics", `{"title":"ML research","folder":"ml"}`, 201)["id"].(string)
	return s, topic, d.PaperID
}

// Catches duplicate paper identities, translation-as-original, guessed original
// selection, stale cached text, and folder prefix/recursive membership mistakes.
func TestResearchScopeMembersAndRevisions(t *testing.T) {
	s, topic, paperID := researchFixture(t)
	meta := paperCreate(t, s, "Metadata only")
	paperCall(t, s, "PATCH", "/api/papers/"+meta, `{"folders":["ML/Sub"]}`, 200)
	abstract := paperCreate(t, s, "Abstract only")
	paperCall(t, s, "PATCH", "/api/papers/"+abstract, `{"folders":["ml"],"metadata":{"abstract":"Actual abstract"}}`, 200)
	trash := paperCreate(t, s, "Trashed")
	paperCall(t, s, "PATCH", "/api/papers/"+trash, `{"folders":["ML"]}`, 200)
	paperCall(t, s, "POST", "/api/papers/"+trash+"/trash", `{}`, 200)
	other := paperCreate(t, s, "Wrong prefix")
	paperCall(t, s, "PATCH", "/api/papers/"+other, `{"folders":["MLExtra"]}`, 200)
	a := researchSnapshot(t, s, topic)
	if len(a.Members) != 3 {
		t.Fatalf("scope: %+v", a.Members)
	}
	members := map[string]ResearchMember{}
	for _, m := range a.Members {
		members[m.PaperID] = m
	}
	if m := members[paperID]; m.DocumentID != "doc" || m.Coverage != "fulltext" || m.SourceHash != sourceKey("source-A") || m.CorpusRevision == "" || m.CitationKey != "Stable2026" {
		t.Fatal(m)
	}
	if members[meta].Coverage != "metadata" || members[abstract].Coverage != "abstract" {
		t.Fatal(members)
	}
	if b := researchSnapshot(t, s, topic); b.Revision != a.Revision || b.ID == a.ID {
		t.Fatal("unstable identical scope", a, b)
	}
	paperCall(t, s, "PATCH", "/api/research/topics/"+topic, `{"includeChildren":false}`, 200)
	b := researchSnapshot(t, s, topic)
	if len(b.Members) != 2 || b.Revision == a.Revision {
		t.Fatal(b)
	}
	paperCall(t, s, "PATCH", "/api/research/topics/"+topic, `{"includeChildren":true}`, 200)
	// A translated primary never becomes the research source. One unique other
	// readable original remains selectable, even if a missing original is present.
	paperSeed(t, s.Store, "translation")
	// Move the seeded attachment from its generated item into the existing paper.
	td, _ := s.Store.Document("translation")
	paperCall(t, s, "DELETE", "/api/papers/"+td.PaperID+"/attachments/translation", "", 200)
	paperCall(t, s, "PUT", "/api/papers/"+paperID+"/attachments/translation", `{"role":"translation","primary":true}`, 200)
	c := researchSnapshot(t, s, topic)
	for _, m := range c.Members {
		if m.PaperID == paperID && m.DocumentID != "doc" {
			t.Fatal(m)
		}
	}
	paperSeed(t, s.Store, "other-original")
	od, _ := s.Store.Document("other-original")
	paperCall(t, s, "DELETE", "/api/papers/"+od.PaperID+"/attachments/other-original", "", 200)
	// A readable second original requires an explicit primary original selection.
	if err := os.MkdirAll(s.analysisDir("other-original"), 0700); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(s.analysisDir("doc"), "manifest.json"))
	if err := os.WriteFile(filepath.Join(s.analysisDir("other-original"), "manifest.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	researchSetLayoutSource(t, s, "other-original", "source-B")
	paperCall(t, s, "PUT", "/api/papers/"+paperID+"/attachments/other-original", `{"role":"original"}`, 200)
	d := researchSnapshot(t, s, topic)
	for _, m := range d.Members {
		if m.PaperID == paperID && (m.Coverage != "unavailable" || m.DocumentID != "" || m.Reason == "") {
			t.Fatal("guessed ambiguous original", m)
		}
	}
	paperCall(t, s, "PATCH", "/api/papers/"+paperID, `{"primaryDocumentId":"other-original"}`, 200)
	e := researchSnapshot(t, s, topic)
	for _, m := range e.Members {
		if m.PaperID == paperID && m.DocumentID != "other-original" {
			t.Fatal(m)
		}
	}
	os.Remove(filepath.Join(s.Store.Root, "papers", "doc.pdf"))
	os.Remove(filepath.Join(s.Store.Root, "papers", "other-original.pdf"))
	f := researchSnapshot(t, s, topic)
	for _, m := range f.Members {
		if m.PaperID == paperID && (m.Coverage != "unavailable" || m.Reason == "") {
			t.Fatal(m)
		}
	}
}

// Same size and mtime must never bind a new source hash to old parsed passages.
func TestResearchScopeSourceReplacementSameSizeAndTime(t *testing.T) {
	s, topic, _ := researchFixture(t)
	a := researchSnapshot(t, s, topic)
	d, _ := s.Store.Document("doc")
	before, err := s.corpusFingerprintContext(t.Context(), d)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Store.Root, "papers", "doc.pdf")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("source-B"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	after, err := s.corpusFingerprintContext(t.Context(), d)
	if err != nil || after == before {
		t.Fatal("cache identity did not detect source byte replacement", err)
	}
	b := researchSnapshot(t, s, topic)
	if b.Revision == a.Revision || b.Members[0].Coverage != "unavailable" || b.Members[0].Reason == "" {
		t.Fatalf("new hash bound to old text: %+v", b)
	}
	// A source without parser provenance is explicitly unavailable, too.
	raw, _ := os.ReadFile(filepath.Join(s.analysisDir("doc"), "manifest.json"))
	var layout map[string]any
	json.Unmarshal(raw, &layout)
	delete(layout, "inputSHA256")
	raw, _ = json.Marshal(layout)
	os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), raw, 0600)
	if c := researchSnapshot(t, s, topic); c.Members[0].Coverage != "unavailable" {
		t.Fatal(c)
	}
}

func seedResearchResult(t *testing.T, s *Server, topic string, snap ResearchSnapshot, paper, doc, run string) {
	t.Helper()
	session, err := s.Store.CreateResearchSession(context.Background(), topic, ResearchSessionInput{Title: "Saved session"})
	if err != nil {
		t.Fatal(err)
	}
	stamp := now()
	body, _ := json.Marshal(ResearchRun{ID: run, TopicID: topic, SessionID: session.ID, SnapshotID: snap.ID, Status: "completed"})
	_, err = s.Store.DB.Exec(`INSERT INTO research_runs(id,topic_id,session_id,user_message_id,status,request_hash,body,created_at,updated_at) VALUES(?,?,?,?,'completed','request',?,?,?)`, run, topic, session.ID, run, string(body), stamp, stamp)
	if err != nil {
		t.Fatal(err)
	}
	evidence := ResearchEvidence{ID: "e-" + run, TopicID: topic, SnapshotID: snap.ID, RunID: run, PaperID: paper, DocumentID: doc, Kind: "local-passage", Revision: snap.Revision, Excerpt: "readable original payload", ContentHash: "content", Location: json.RawMessage(`{"type":"pdf","page":1}`), Availability: "valid"}
	body, _ = json.Marshal(evidence)
	_, err = s.Store.DB.Exec(`INSERT INTO research_evidence(id,topic_id,snapshot_id,run_id,paper_id,document_id,availability,body,created_at,updated_at) VALUES(?,?,?,?,?,?,'valid',?,?,?)`, evidence.ID, topic, snap.ID, run, paper, doc, string(body), stamp, stamp)
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"model", "user"} {
		report := ResearchReport{ID: "report-" + run + "-" + suffix, TopicID: topic, SessionID: session.ID, SourceRunID: run, Origin: suffix, Content: "saved user research " + suffix, SourceIDs: []string{evidence.ID}, Revision: suffix}
		body, _ = json.Marshal(report)
		var runID any
		if suffix == "model" {
			runID = run
		}
		_, err = s.Store.DB.Exec(`INSERT INTO research_reports(id,topic_id,session_id,run_id,revision,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, report.ID, topic, session.ID, runID, suffix, string(body), stamp, stamp)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = s.Store.DB.Exec(`INSERT INTO research_cards(cache_key,paper_id,document_id,revision,body,created_at,updated_at) VALUES(?,?,?,'revision','{"problem":"cached original payload"}',?,?)`, run, paper, doc, stamp, stamp)
	if err != nil {
		t.Fatal(err)
	}
}

func TestResearchFolderRenameDeleteAndPaperMerge(t *testing.T) {
	s, topic, paper := researchFixture(t)
	child := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Child","folder":"ML/Sub"}`, 201)["id"].(string)
	unrelated := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Other","folder":"MLExtra"}`, 201)["id"].(string)
	a := researchSnapshot(t, s, topic)
	seedResearchResult(t, s, topic, a, paper, "doc", "run-folder")
	paperCall(t, s, "POST", "/api/libraries/papers/folders", `{"from":"mL","to":"Renamed"}`, 200)
	got := paperCall(t, s, "GET", "/api/research/topics/"+topic, "", 200)
	if got["id"] != topic || got["folder"] != "Renamed" {
		t.Fatal(got)
	}
	if c := paperCall(t, s, "GET", "/api/research/topics/"+child, "", 200); c["folder"] != "Renamed/Sub" {
		t.Fatal(c)
	}
	if c := paperCall(t, s, "GET", "/api/research/topics/"+unrelated, "", 200); c["folder"] != "MLExtra" {
		t.Fatal(c)
	}
	if b := researchSnapshot(t, s, topic); b.Revision != a.Revision {
		t.Fatal("folder label leaked into revision", a.Revision, b.Revision)
	}
	source := paperCreate(t, s, "Merge source")
	paperCall(t, s, "PATCH", "/api/papers/"+source, `{"folders":["Renamed"]}`, 200)
	pre := researchSnapshot(t, s, topic)
	if len(pre.Members) != 2 {
		t.Fatal(pre)
	}
	seedResearchResult(t, s, topic, pre, source, "", "run-merge-metadata")
	paperCall(t, s, "POST", "/api/papers/"+paper+"/merge", `{"ids":["`+source+`"]}`, 200)
	var historicPaper, availability string
	if err := s.Store.DB.QueryRow(`SELECT paper_id,availability FROM research_evidence WHERE id='e-run-merge-metadata'`).Scan(&historicPaper, &availability); err != nil || historicPaper != source || availability != "stale" {
		t.Fatal("merge rewrote or lost historical source", historicPaper, availability, err)
	}
	post := researchSnapshot(t, s, topic)
	if len(post.Members) != 1 || post.Members[0].PaperID != paper || post.Members[0].CitationKey != "Stable2026" {
		t.Fatal(post)
	}
	alias := paperCall(t, s, "GET", "/api/papers/"+source, "", 200)
	if alias["id"] != paper || alias["citationKey"] != "Stable2026" {
		t.Fatal(alias)
	}
	paperCall(t, s, "POST", "/api/libraries/papers/folders", `{"from":"RENAMED"}`, 200)
	got = paperCall(t, s, "GET", "/api/research/topics/"+topic, "", 200)
	if got["scopeState"] != "detached" || got["id"] != topic {
		t.Fatal(got)
	}
	if c := paperCall(t, s, "GET", "/api/research/topics/"+child, "", 200); c["scopeState"] != "detached" {
		t.Fatal(c)
	}
	var n int
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_reports WHERE topic_id=?`, topic).Scan(&n); err != nil || n != 4 {
		t.Fatal("lost reports", n, err)
	}
	if _, err := s.snapshotResearchScope(context.Background(), topic); err == nil {
		t.Fatal("detached topic silently rebound")
	}
}

func TestResearchScopeMergePreservesOriginalAndReaderData(t *testing.T) {
	s, topic, source := researchFixture(t)
	snap := researchSnapshot(t, s, topic)
	seedResearchResult(t, s, topic, snap, source, "doc", "run-original-merge")
	if _, err := s.Store.DB.Exec(`INSERT INTO document_notes VALUES('doc','interleaf note','2026'); INSERT INTO annotations VALUES('merge-mark','doc','{"kind":"highlight","quote":"interleaf mark"}'); INSERT INTO messages VALUES('merge-message','doc','{"content":"interleaf history"}','2026'); UPDATE documents SET progress='{"type":"pdf","page":2}' WHERE id='doc'`); err != nil {
		t.Fatal(err)
	}
	target := paperCreate(t, s, "Canonical target")
	paperCall(t, s, "POST", "/api/papers/"+target+"/merge", `{"ids":["`+source+`"]}`, 200)
	after := researchSnapshot(t, s, topic)
	if len(after.Members) != 1 || after.Members[0].PaperID != target || after.Members[0].CitationKey != "Stable2026" || after.Members[0].DocumentID != "doc" {
		t.Fatal(after)
	}
	d, err := s.Store.Document("doc")
	if err != nil || d.PaperID != target || d.HighlightCount != 1 || !strings.Contains(string(d.Progress), `"page":2`) {
		t.Fatal(d, err)
	}
	var notes, history, translation string
	if err = s.Store.DB.QueryRow(`SELECT (SELECT body FROM document_notes WHERE document_id='doc'),(SELECT body FROM messages WHERE id='merge-message'),(SELECT body FROM translations WHERE document_id='doc')`).Scan(&notes, &history, &translation); err != nil || notes != "interleaf note" || !strings.Contains(history, "interleaf history") || !strings.Contains(translation, "长事务") {
		t.Fatal(notes, history, translation, err)
	}
	data, err := os.ReadFile(s.Store.File(d))
	if err != nil || string(data) != "source-A" {
		t.Fatal("original changed", string(data), err)
	}
	var historicPaper, state string
	if err = s.Store.DB.QueryRow(`SELECT paper_id,availability FROM research_evidence WHERE id='e-run-original-merge'`).Scan(&historicPaper, &state); err != nil || historicPaper != source || state != "stale" {
		t.Fatal(historicPaper, state, err)
	}
}

func TestResearchScopePurgePayloadAndAtomicRollback(t *testing.T) {
	s, topic, paper := researchFixture(t)
	snap := researchSnapshot(t, s, topic)
	seedResearchResult(t, s, topic, snap, paper, "doc", "run-delete")
	other := paperCreate(t, s, "Unrelated saved research")
	seedResearchResult(t, s, topic, snap, other, "other", "run-other")
	// Any source FK cascade or eager cleanup before the source transaction commits
	// would destroy the payload even though deletion failed.
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER reject_research_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT,'test deletion failure'); END`); err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "DELETE", "/api/documents/doc", "", 500)
	var availability, raw string
	if err := s.Store.DB.QueryRow(`SELECT availability,body FROM research_evidence WHERE id='e-run-delete'`).Scan(&availability, &raw); err != nil || availability != "valid" || !strings.Contains(raw, "readable original payload") {
		t.Fatal(availability, raw, err)
	}
	if _, err := s.Store.DB.Exec(`DROP TRIGGER reject_research_delete`); err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "DELETE", "/api/documents/doc", "", 204)
	if err := s.Store.DB.QueryRow(`SELECT availability,body FROM research_evidence WHERE id='e-run-delete'`).Scan(&availability, &raw); err != nil || availability != "removed" || strings.Contains(raw, "readable original payload") {
		t.Fatal(availability, raw, err)
	}
	var n int
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards WHERE document_id='doc'`).Scan(&n); err != nil || n != 0 {
		t.Fatal(n, err)
	}
	if err := s.Store.DB.QueryRow(`SELECT availability FROM research_evidence WHERE id='e-run-other'`).Scan(&availability); err != nil || availability != "valid" {
		t.Fatal("unrelated source changed", availability, err)
	}
	rows, err := s.Store.DB.Query(`SELECT body FROM research_reports WHERE id LIKE 'report-run-delete-%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n = 0
	for rows.Next() {
		var raw string
		rows.Scan(&raw)
		var r ResearchReport
		if err = json.Unmarshal([]byte(raw), &r); err != nil || !r.Stale || !strings.HasPrefix(r.Content, "saved user research") {
			t.Fatal(r, err)
		}
		n++
	}
	if n != 2 {
		t.Fatal(n)
	}
}

func TestResearchScopeDoesNotQueuePaidOverview(t *testing.T) {
	s, topic, _ := researchFixture(t)
	if _, err := s.Store.DB.Exec(`INSERT INTO settings VALUES('interleaf','{"autoGenerateOverview":true}'); INSERT INTO document_overviews VALUES('doc','{"content":{"summary":"retain old overview"}}')`); err != nil {
		t.Fatal(err)
	}
	researchSnapshot(t, s, topic)
	var n int
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM document_overview_jobs`).Scan(&n); err != nil || n != 0 {
		t.Fatal("scope queued paid overview", n, err)
	}
	// Ordinary reading still performs its established automatic refresh.
	s.Store.DB.Exec(`DELETE FROM document_corpora`)
	if _, err := s.documentCorpus(context.Background(), "doc", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.DB.QueryRow(`SELECT count(*) FROM document_overview_jobs`).Scan(&n); err != nil || n != 1 {
		t.Fatal("ordinary overview behavior changed", n, err)
	}
}

func TestResearchScopeRelocationAndEPUBOriginal(t *testing.T) {
	s, topic, paper := researchFixture(t)
	// EPUB enters via the supported books -> original paper attachment path.
	w := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var epub Document
	if err := json.Unmarshal(w.Body.Bytes(), &epub); err != nil {
		t.Fatal(err)
	}
	ep := paperCreate(t, s, "EPUB paper")
	paperCall(t, s, "PATCH", "/api/papers/"+ep, `{"folders":["ML"]}`, 200)
	paperCall(t, s, "PUT", "/api/papers/"+ep+"/attachments/"+epub.ID, `{"role":"original","primary":true}`, 200)
	a := researchSnapshot(t, s, topic)
	if len(a.Members) != 2 {
		t.Fatal(a)
	}
	for _, m := range a.Members {
		if m.PaperID == ep && (m.DocumentID != epub.ID || m.Coverage != "fulltext" || m.CorpusRevision == "") {
			t.Fatal(m)
		}
	}
	oldRoot := s.Store.Root
	newRoot := t.TempDir()
	for _, name := range []string{"papers", "books", "cache", "ai-work"} {
		if err := os.CopyFS(filepath.Join(newRoot, name), os.DirFS(filepath.Join(oldRoot, name))); err != nil {
			t.Fatal(err)
		}
	}
	s.Store.Root = newRoot
	defer func() { s.Store.Root = oldRoot }()
	b := researchSnapshot(t, s, topic)
	if a.Revision != b.Revision {
		t.Fatal("absolute path leaked into research revision", a.Revision, b.Revision)
	}
	// Replacing verified parser output changes the actual text and revision.
	path := filepath.Join(s.analysisDir("doc"), "manifest.json")
	raw, _ := os.ReadFile(path)
	raw = []byte(strings.ReplaceAll(string(raw), "Long-running transactions block short ones.", "Replacement source states a different result."))
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	researchSetLayoutSource(t, s, "doc", "source-C")
	c := researchSnapshot(t, s, topic)
	if c.Revision == b.Revision {
		t.Fatal("content/parser revision unchanged")
	}
	corpus, err := s.documentCorpus(context.Background(), "doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(corpus.Passages[1].Text, "Replacement source") {
		t.Fatal("stale text", corpus.Passages)
	}
	paperItem, err := s.Store.PaperItem(paper)
	if err != nil || paperItem.CitationKey != "Stable2026" {
		t.Fatal(paperItem, err)
	}
}
