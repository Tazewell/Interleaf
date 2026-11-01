package interleaf

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

var researchTables = []string{"research_topics", "research_sessions", "research_snapshots", "research_runs", "research_units", "research_cards", "research_evidence", "research_candidates", "research_searches", "research_reports", "research_conversations", "research_messages"}

// A missing table, or an early return after only creating topics, breaks this.
func TestResearchMigrationInitialAndRepeat(t *testing.T) {
	s := testServer(t)
	for _, table := range researchTables {
		var n int
		if err := s.Store.DB.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&n); err != nil || n != 1 {
			t.Fatalf("missing %s: %d %v", table, n, err)
		}
	}
	p := paperCreate(t, s, "Preserved")
	topic := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Reading","folder":"ML"}`, 201)["id"].(string)
	s.Close()
	root := s.Store.Root
	s.Store.DB.Close()
	reopened, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	var n int
	if err = reopened.DB.QueryRow(`SELECT count(*) FROM research_topics WHERE id=?`, topic).Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if _, err = reopened.PaperItem(p); err != nil {
		t.Fatal(err)
	}
}

func dropResearchSchema(t *testing.T, s *Store) {
	t.Helper()
	// Reverse FK dependency order, without disabling source data protection.
	for _, name := range []string{"research_messages", "research_conversations", "research_reports", "research_searches", "research_candidates", "research_evidence", "research_cards", "research_units", "research_runs", "research_snapshots", "research_sessions", "research_topics"} {
		if _, err := s.DB.Exec(`DROP TABLE IF EXISTS ` + name); err != nil {
			t.Fatal(err)
		}
	}
}

// A late DDL failure must roll back all twelve tables and preserve real interleaf data.
func TestResearchMigrationRollbackAndRecovery(t *testing.T) {
	s := testServer(t)
	dropResearchSchema(t, s.Store)
	if err := os.Remove(filepath.Join(s.Store.Root, "interleaf.pre-research.sqlite")); err != nil {
		t.Fatal(err)
	}
	paperSeed(t, s.Store, "migration-source")
	_, err := s.Store.DB.Exec(`UPDATE documents SET progress='{"type":"pdf","page":7}' WHERE id='migration-source'; INSERT INTO annotations VALUES('research-mark','migration-source','{"kind":"highlight","quote":"keep"}'); INSERT INTO document_notes VALUES('migration-source','keep note','2026'); INSERT INTO messages VALUES('research-chat','migration-source','{"content":"keep chat"}','2026'); CREATE VIEW research_messages AS SELECT id FROM documents`)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Store.Root, "papers", "migration-source.pdf")
	if err = os.WriteFile(path, []byte("original research bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = researchMigrate(t, s.Store); err == nil {
		t.Fatal("expected late schema conflict")
	}
	var n int
	if err = s.Store.DB.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'research_%'`).Scan(&n); err != nil || n != 0 {
		t.Fatal("partial schema", n, err)
	}
	snapshot := filepath.Join(s.Store.Root, "interleaf.pre-research.sqlite")
	if err = validatePaperSnapshot(snapshot); err != nil {
		t.Fatal(err)
	}
	assertResearchOldData(t, s.Store.DB, path)
	if _, err = s.Store.DB.Exec(`INSERT INTO document_notes VALUES('unused','bad','2026')`); err == nil {
		t.Fatal("source FK unexpectedly disabled")
	}
	if _, err = s.Store.DB.Exec(`UPDATE document_notes SET body='new retry note'; DROP VIEW research_messages`); err != nil {
		t.Fatal(err)
	}
	if err = researchMigrate(t, s.Store); err != nil {
		t.Fatal(err)
	}
	matches, err := filepath.Glob(filepath.Join(s.Store.Root, "interleaf.pre-research.*.sqlite"))
	if err != nil || len(matches) == 0 {
		t.Fatal("retry snapshot missing", matches, err)
	}
	old, err := sql.Open("sqlite", snapshot+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	var note string
	if err = old.QueryRow(`SELECT body FROM document_notes WHERE document_id='migration-source'`).Scan(&note); err != nil || note != "keep note" {
		t.Fatal("overwritten recovery point", note, err)
	}
}

func assertResearchOldData(t *testing.T, db *sql.DB, path string) {
	t.Helper()
	var progress, note, chat, mark string
	if err := db.QueryRow(`SELECT progress,(SELECT body FROM document_notes WHERE document_id=d.id),(SELECT body FROM messages WHERE document_id=d.id),(SELECT body FROM annotations WHERE document_id=d.id) FROM documents d WHERE id='migration-source'`).Scan(&progress, &note, &chat, &mark); err != nil {
		t.Fatal(err)
	}
	if progress != `{"type":"pdf","page":7}` || note != "keep note" || chat != `{"content":"keep chat"}` || mark != `{"kind":"highlight","quote":"keep"}` {
		t.Fatal(progress, note, chat, mark)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "original research bytes" {
		t.Fatal(string(data), err)
	}
}

func researchMigrate(t *testing.T, s *Store) error {
	t.Helper()
	return s.migrateResearch()
}

func TestResearchMigrationConstraints(t *testing.T) {
	s, topic, paper := researchFixture(t)
	snap := researchSnapshot(t, s, topic)
	seedResearchResult(t, s, topic, snap, paper, "doc", "constraint-run")
	// Duplicating an idempotency identity must fail even with a different row ID.
	cases := []string{
		`INSERT INTO research_runs SELECT 'different-run',topic_id,session_id,user_message_id,status,request_hash,body,created_at,updated_at FROM research_runs WHERE id='constraint-run'`,
		`INSERT INTO research_reports SELECT 'different-report',topic_id,session_id,run_id,NULL,revision,body,created_at,updated_at FROM research_reports WHERE id='report-constraint-run-model'`,
	}
	for _, query := range cases {
		if _, err := s.Store.DB.Exec(query); err == nil {
			t.Fatal("lost idempotency constraint", query)
		}
	}
	stamp := now()
	_, err := s.Store.DB.Exec(`INSERT INTO research_units VALUES('constraint-run','control:request','control','succeeded','{}',?,?)`, stamp, stamp)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.DB.Exec(`INSERT INTO research_candidates VALUES('candidate',?,'doi:stable','{}',?,?)`, topic, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.DB.Exec(`INSERT INTO research_units VALUES('constraint-run','control:request','control','succeeded','{}',?,?)`, stamp, stamp); err == nil {
		t.Fatal("duplicate control identity accepted")
	}
	if _, err = s.Store.DB.Exec(`INSERT INTO research_candidates VALUES('candidate-2',?,'doi:stable','{}',?,?)`, topic, stamp, stamp); err == nil {
		t.Fatal("duplicate topic candidate accepted")
	}
	if _, err = s.Store.DB.Exec(`UPDATE research_reports SET user_request_id='same-request'`); err == nil {
		t.Fatal("duplicate revision request accepted")
	}
	// A run/session pair from a different topic cannot be persisted together.
	second := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Other","folder":"Other"}`, 201)["id"].(string)
	if _, err = s.Store.DB.Exec(`UPDATE research_runs SET topic_id=? WHERE id='constraint-run'`, second); err == nil {
		t.Fatal("cross-topic session run accepted")
	}
}
