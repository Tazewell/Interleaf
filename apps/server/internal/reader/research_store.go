package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

type ResearchTopicInput struct {
	Title           string `json:"title"`
	Folder          string `json:"folder"`
	IncludeChildren *bool  `json:"includeChildren,omitempty"`
	NetworkAllowed  bool   `json:"networkAllowed"`
}
type ResearchTopicPatch struct {
	Title           *string `json:"title,omitempty"`
	Folder          *string `json:"folder,omitempty"`
	IncludeChildren *bool   `json:"includeChildren,omitempty"`
	NetworkAllowed  *bool   `json:"networkAllowed,omitempty"`
}
type ResearchSessionInput struct {
	Title string `json:"title"`
}

func readResearchTopic(q paperQuery, topicID string) (ResearchTopic, error) {
	var topic ResearchTopic
	var raw string
	if err := q.QueryRow(`SELECT body FROM research_topics WHERE id=?`, topicID).Scan(&raw); err != nil {
		return topic, err
	}
	return topic, json.Unmarshal([]byte(raw), &topic)
}
func writeResearchTopic(tx *sql.Tx, t ResearchTopic) error {
	raw, err := json.Marshal(t)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO research_topics(id,body,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at`, t.ID, string(raw), t.CreatedAt, t.UpdatedAt)
	return err
}
func researchTitle(value string) (string, error) {
	title, err := cleanText(value, 300, false)
	if err != nil || title == "" {
		return "", errors.New("标题须为 1–300 个字符")
	}
	return title, nil
}
func researchFolder(value string) (string, error) {
	folder := strings.TrimSpace(value)
	if !validImportFolder(folder) {
		return "", errors.New("研究分类无效")
	}
	return folder, nil
}
func (s *Store) CreateResearchTopic(ctx context.Context, in ResearchTopicInput) (ResearchTopic, error) {
	t := ResearchTopic{ID: id(), ScopeState: "active", IncludeChildren: true, NetworkAllowed: in.NetworkAllowed, CreatedAt: now()}
	t.UpdatedAt = t.CreatedAt
	var err error
	if t.Title, err = researchTitle(in.Title); err != nil {
		return t, err
	}
	if t.Folder, err = researchFolder(in.Folder); err != nil {
		return t, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return t, err
	}
	defer tx.Rollback()
	var raw string
	err = tx.QueryRow(`SELECT value FROM settings WHERE key='preferences:library'`).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return t, err
	}
	if err == nil {
		var prefs struct {
			Papers struct {
				SubcategoryItems *bool `json:"subcategoryItems"`
			} `json:"papers"`
		}
		if err = json.Unmarshal([]byte(raw), &prefs); err != nil {
			return t, err
		}
		if prefs.Papers.SubcategoryItems != nil {
			t.IncludeChildren = *prefs.Papers.SubcategoryItems
		}
	}
	if in.IncludeChildren != nil {
		t.IncludeChildren = *in.IncludeChildren
	}
	if err = writeResearchTopic(tx, t); err != nil {
		return t, err
	}
	return t, tx.Commit()
}
func (s *Store) ResearchTopic(ctx context.Context, topicID string) (ResearchTopic, error) {
	var t ResearchTopic
	var raw string
	if err := s.DB.QueryRowContext(ctx, `SELECT body FROM research_topics WHERE id=?`, topicID).Scan(&raw); err != nil {
		return t, err
	}
	return t, json.Unmarshal([]byte(raw), &t)
}
func (s *Store) ResearchTopics(ctx context.Context) ([]ResearchTopic, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT body FROM research_topics ORDER BY created_at,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ResearchTopic{}
	for rows.Next() {
		var raw string
		var t ResearchTopic
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
func (s *Store) UpdateResearchTopic(ctx context.Context, topicID string, in ResearchTopicPatch) (ResearchTopic, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return ResearchTopic{}, err
	}
	defer tx.Rollback()
	t, err := readResearchTopic(tx, topicID)
	if err != nil {
		return t, err
	}
	if in.Title != nil {
		if t.Title, err = researchTitle(*in.Title); err != nil {
			return t, err
		}
	}
	if in.Folder != nil {
		if t.Folder, err = researchFolder(*in.Folder); err != nil {
			return t, err
		}
		t.ScopeState = "active"
	}
	if in.IncludeChildren != nil {
		t.IncludeChildren = *in.IncludeChildren
	}
	if in.NetworkAllowed != nil {
		t.NetworkAllowed = *in.NetworkAllowed
	}
	t.UpdatedAt = now()
	if err = writeResearchTopic(tx, t); err != nil {
		return t, err
	}
	return t, tx.Commit()
}
func (s *Store) CreateResearchSession(ctx context.Context, topicID string, in ResearchSessionInput) (ResearchSession, error) {
	session := ResearchSession{ID: id(), TopicID: topicID, CreatedAt: now()}
	session.UpdatedAt = session.CreatedAt
	var err error
	session.Title, err = researchTitle(in.Title)
	if err != nil {
		return session, err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return session, err
	}
	defer tx.Rollback()
	topic, err := readResearchTopic(tx, topicID)
	if err != nil {
		return session, err
	}
	session.NetworkAllowed = topic.NetworkAllowed
	raw, err := json.Marshal(session)
	if err != nil {
		return session, err
	}
	_, err = tx.Exec(`INSERT INTO research_sessions(id,topic_id,body,created_at,updated_at) VALUES(?,?,?,?,?)`, session.ID, topicID, string(raw), session.CreatedAt, session.UpdatedAt)
	if err != nil {
		return session, err
	}
	return session, tx.Commit()
}
func (s *Store) ResearchSession(ctx context.Context, sessionID string) (ResearchSession, error) {
	var session ResearchSession
	var raw string
	if err := s.DB.QueryRowContext(ctx, `SELECT body FROM research_sessions WHERE id=?`, sessionID).Scan(&raw); err != nil {
		return session, err
	}
	return session, json.Unmarshal([]byte(raw), &session)
}
func (s *Store) ResearchSessions(ctx context.Context, topicID string) ([]ResearchSession, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = readResearchTopic(tx, topicID); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT body FROM research_sessions WHERE topic_id=? ORDER BY created_at,id`, topicID)
	if err != nil {
		return nil, err
	}
	out := []ResearchSession{}
	for rows.Next() {
		var raw string
		var session ResearchSession
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &session); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, session)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return out, tx.Commit()
}
func (s *Store) renameResearchFolders(tx *sql.Tx, from, to string) error {
	rows, err := tx.Query(`SELECT body FROM research_topics`)
	if err != nil {
		return err
	}
	topics := []ResearchTopic{}
	for rows.Next() {
		var raw string
		var t ResearchTopic
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		if err = json.Unmarshal([]byte(raw), &t); err != nil {
			rows.Close()
			return err
		}
		topics = append(topics, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, t := range topics {
		if t.ScopeState != "active" {
			continue
		}
		rest, hit := tagSuffix(t.Folder, from)
		if !hit {
			continue
		}
		if to == "" {
			t.ScopeState = "detached"
		} else {
			t.Folder = to + rest
			if !validImportFolder(t.Folder) {
				return errInvalidTag{errors.New("研究分类名称无效")}
			}
		}
		t.UpdatedAt = now()
		if err = writeResearchTopic(tx, t); err != nil {
			return err
		}
	}
	return nil
}

// Callers already mutating the library reuse their transaction: a nested
// transaction would wait forever for the sole DB connection.
func (s *Store) invalidateResearchDocument(ctx context.Context, documentID, reason string) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.invalidateResearchDocumentTx(ctx, tx, documentID, reason); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) invalidateResearchPaperTx(ctx context.Context, tx *sql.Tx, p PaperItem, reason string) error {
	// Metadata-only members have no evidence/document row to follow. Their
	// historical reports are located through the immutable scope membership.
	const runs = `SELECT r.id FROM research_runs r JOIN research_snapshots s ON s.id=json_extract(r.body,'$.snapshotId'),json_each(s.body,'$.members') m WHERE json_extract(m.value,'$.paperId')=?`
	_, err := tx.ExecContext(ctx, `UPDATE research_reports SET body=json_set(body,'$.stale',json('true')),updated_at=? WHERE run_id IN (`+runs+`) OR json_extract(body,'$.sourceRunId') IN (`+runs+`)`, now(), p.ID, p.ID)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM research_cards WHERE paper_id=?`, p.ID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE research_evidence SET availability='stale',body=json_set(body,'$.availability','stale'),updated_at=? WHERE paper_id=? AND availability!='removed'`, now(), p.ID); err != nil {
		return err
	}
	for _, a := range p.Attachments {
		if err = s.invalidateResearchDocumentTx(ctx, tx, a.DocumentID, reason); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) invalidateResearchDocumentTx(ctx context.Context, tx *sql.Tx, documentID, reason string) error {
	state := "stale"
	if reason == "removed" {
		state = "removed"
	}
	stamp := now()
	const runs = `SELECT r.id FROM research_runs r WHERE r.id IN (SELECT run_id FROM research_evidence WHERE document_id=?) OR EXISTS(SELECT 1 FROM research_snapshots s,json_each(s.body,'$.members') m WHERE s.id=json_extract(r.body,'$.snapshotId') AND json_extract(m.value,'$.documentId')=?)`
	if _, err := tx.ExecContext(ctx, `UPDATE research_reports SET body=json_set(body,'$.stale',json('true')),updated_at=? WHERE run_id IN (`+runs+`) OR id IN (SELECT r.id FROM research_reports r,json_each(r.body,'$.sourceIds') src JOIN research_evidence e ON e.id=src.value WHERE e.document_id=?) OR json_extract(body,'$.sourceRunId') IN (`+runs+`)`, stamp, documentID, documentID, documentID, documentID, documentID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM research_cards WHERE document_id=?`, documentID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM research_conversations WHERE session_id IN (SELECT session_id FROM research_runs WHERE id IN (`+runs+`))`, documentID, documentID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE research_units SET status='stale',body=json_set(json_remove(body,'$.result'),'$.status','stale','$.updatedAt',?),updated_at=? WHERE kind!='control' AND run_id IN (`+runs+`)`, stamp, stamp, documentID, documentID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE research_runs SET status='interrupted',body=json_set(body,'$.status','interrupted','$.error',?,'$.updatedAt',?),updated_at=? WHERE status IN ('preparing','queued','running') AND id IN (`+runs+`)`, reason, stamp, stamp, documentID, documentID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE research_evidence SET availability=CASE WHEN availability='removed' THEN 'removed' ELSE ? END,body=json_set(body,'$.availability',CASE WHEN availability='removed' THEN 'removed' ELSE ? END),updated_at=? WHERE document_id=?`, state, state, stamp, documentID); err != nil {
		return err
	}
	if state == "removed" {
		if _, err := tx.ExecContext(ctx, `UPDATE research_evidence SET body=json_set(body,'$.excerpt','','$.location',json('null')),updated_at=? WHERE document_id=?`, stamp, documentID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE research_candidates SET body=json_set(body,'$.availability','removed','$.abstract',''),updated_at=? WHERE json_extract(body,'$.documentId')=?`, stamp, documentID); err != nil {
			return err
		}
	}
	return nil
}
