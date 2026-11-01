package interleaf

import (
	"fmt"
	"os"
	"path/filepath"
)

func (s *Store) migrateResearch() error {
	var n int
	if err := s.DB.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('research_topics','research_sessions','research_snapshots','research_runs','research_units','research_cards','research_evidence','research_candidates','research_searches','research_reports','research_conversations','research_messages')`).Scan(&n); err != nil {
		return err
	}
	if n == 12 {
		return nil
	}
	if n != 0 {
		return fmt.Errorf("研究数据表不完整，请从迁移快照恢复")
	}
	path := filepath.Join(s.Root, "interleaf.pre-research.sqlite")
	if _, err := os.Lstat(path); err == nil {
		if err = validatePaperSnapshot(path); err != nil {
			return err
		}
		path = filepath.Join(s.Root, "interleaf.pre-research."+id()+".sqlite")
	} else if !os.IsNotExist(err) {
		return err
	}
	if _, err := s.DB.Exec(`VACUUM INTO ?`, path); err != nil {
		return fmt.Errorf("研究迁移快照: %w", err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		return err
	}
	if err := validatePaperSnapshot(path); err != nil {
		return err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`
 CREATE TABLE research_topics(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE research_sessions(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES research_topics(id),body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(id,topic_id));
 CREATE INDEX research_sessions_topic ON research_sessions(topic_id);
 CREATE TABLE research_snapshots(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES research_topics(id),revision TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(id,topic_id));
 CREATE INDEX research_snapshots_topic_revision ON research_snapshots(topic_id,revision);
 CREATE TABLE research_runs(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES research_topics(id),session_id TEXT NOT NULL,user_message_id TEXT NOT NULL,status TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(session_id,user_message_id),FOREIGN KEY(session_id,topic_id) REFERENCES research_sessions(id,topic_id));
 CREATE INDEX research_runs_topic_status ON research_runs(topic_id,status);
 CREATE TABLE research_units(run_id TEXT NOT NULL REFERENCES research_runs(id),unit_key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,unit_key));
 CREATE TABLE research_cards(cache_key TEXT PRIMARY KEY,paper_id TEXT NOT NULL,document_id TEXT,revision TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX research_cards_document ON research_cards(document_id);
 CREATE INDEX research_cards_paper_revision ON research_cards(paper_id,revision);
 CREATE TABLE research_evidence(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES research_topics(id),snapshot_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES research_runs(id),paper_id TEXT,document_id TEXT,candidate_id TEXT,availability TEXT NOT NULL CHECK(availability IN ('valid','stale','removed')),body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(snapshot_id,topic_id) REFERENCES research_snapshots(id,topic_id));
 CREATE INDEX research_evidence_document ON research_evidence(document_id);
 CREATE INDEX research_evidence_paper ON research_evidence(paper_id);
 CREATE INDEX research_evidence_run ON research_evidence(run_id);
 CREATE INDEX research_evidence_candidate ON research_evidence(candidate_id);
 CREATE TABLE research_candidates(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES research_topics(id),identity_key TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(topic_id,identity_key));
 CREATE TABLE research_searches(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES research_topics(id),run_id TEXT NOT NULL REFERENCES research_runs(id),body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX research_searches_topic_run ON research_searches(topic_id,run_id);
 CREATE TABLE research_reports(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES research_topics(id),session_id TEXT NOT NULL,run_id TEXT UNIQUE REFERENCES research_runs(id),user_request_id TEXT UNIQUE,revision TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(session_id,topic_id) REFERENCES research_sessions(id,topic_id));
 CREATE INDEX research_reports_topic ON research_reports(topic_id,created_at);
 CREATE TABLE research_conversations(session_id TEXT PRIMARY KEY REFERENCES research_sessions(id),connection_key TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE research_messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES research_sessions(id),run_id TEXT REFERENCES research_runs(id),body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX research_messages_session ON research_messages(session_id,created_at);
 CREATE INDEX research_messages_run ON research_messages(run_id);
 `)
	if err != nil {
		return err
	}
	return tx.Commit()
}
