package interleaf

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"interleaf.local/server/internal/scholar"
)

// A cancellable wait on the existing library mutation lock; no helper goroutine
// can acquire it after its caller has gone away.
func lockImportContext(ctx context.Context, mu *sync.Mutex) error {
	timer := time.NewTicker(10 * time.Millisecond)
	defer timer.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if mu.TryLock() {
			if err := ctx.Err(); err != nil {
				mu.Unlock()
				return err
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
}

type contextImportReader struct {
	ctx    context.Context
	interleaf io.Reader
}

func (r contextImportReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.interleaf.Read(p)
}

type researchImportResult struct {
	TopicID        string   `json:"topicId"`
	CandidateID    string   `json:"candidateId"`
	SessionID      string   `json:"sessionId"`
	RegistrationID string   `json:"registrationId"`
	Generation     uint64   `json:"generation"`
	Document       Document `json:"document"`
}

func (s *Server) researchCandidateRegistration(ctx context.Context, topicID, candidateID string) (researchScope, ResearchCandidate, string, string, error) {
	var empty researchScope
	var c ResearchCandidate
	var raw, topic, identity string
	err := s.Store.DB.QueryRowContext(ctx, `SELECT body,topic_id,identity_key FROM research_candidates WHERE id=?`, candidateID).Scan(&raw, &topic, &identity)
	if err != nil {
		return empty, c, "", "", err
	}
	if json.Unmarshal([]byte(raw), &c) != nil || c.ID != candidateID || c.TopicID != topic || c.IdentityKey != identity || topic != topicID {
		return empty, c, "", "", errResearchScopeChanged
	}
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT run_id,registration_id FROM (
 SELECT r.id AS run_id,s.id AS registration_id,s.created_at AS registered_at FROM research_searches s JOIN research_runs r ON r.id=s.run_id AND r.topic_id=s.topic_id
 WHERE s.topic_id=? AND json_extract(s.body,'$.id')=s.id AND json_extract(s.body,'$.runId')=r.id AND json_extract(s.body,'$.status')='ok' AND EXISTS(SELECT 1 FROM json_each(s.body,'$.candidateIds') v WHERE v.value=?)
 UNION ALL SELECT r.id AS run_id,r.id AS registration_id,r.created_at AS registered_at FROM research_runs r WHERE r.topic_id=? AND EXISTS(SELECT 1 FROM json_each(r.body,'$.input.urls') v WHERE v.value=? OR v.value=?)
 ) ORDER BY registered_at DESC,registration_id DESC`, topicID, candidateID, topicID, c.LandingURL, c.PDFURL)
	if err != nil {
		return empty, c, "", "", err
	}
	type registration struct{ run, id string }
	registrations := []registration{}
	for rows.Next() {
		var r registration
		if err = rows.Scan(&r.run, &r.id); err != nil {
			rows.Close()
			return empty, c, "", "", err
		}
		registrations = append(registrations, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return empty, c, "", "", err
	}
	for _, r := range registrations {
		scope, e := readResearchRunScope(ctx, s.Store.DB, r.run)
		if e != nil {
			return empty, c, "", "", e
		}
		candidate, version, e := readResearchRegisteredCandidate(ctx, s.Store.DB, scope, candidateID)
		if e == nil {
			return scope, candidate, version, r.id, nil
		}
	}
	return empty, c, "", "", errResearchScopeChanged
}

// An explicit user import is a new, single-operation grant, even when its
// originating run completed or its old task grant was revoked. It never changes
// session settings or the run's allowance and joins the same revoke lifecycle.
func (s *Server) beginResearchImport(parent context.Context, scope researchScope) (context.Context, func(), error) {
	ctx, finishAI, err := s.beginAIIO(parent)
	if err != nil {
		return nil, nil, err
	}
	s.researchNetworkMu.Lock()
	var raw, topic string
	err = s.Store.DB.QueryRowContext(ctx, `SELECT body,topic_id FROM research_sessions WHERE id=?`, scope.Run.SessionID).Scan(&raw, &topic)
	var session ResearchSession
	if err == nil && (json.Unmarshal([]byte(raw), &session) != nil || session.ID != scope.Run.SessionID || session.TopicID != topic || topic != scope.Run.TopicID) {
		err = errResearchScopeChanged
	}
	if err != nil {
		s.researchNetworkMu.Unlock()
		finishAI()
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	lease := &researchNetworkLease{sessionID: session.ID, generation: session.NetworkGeneration, cancel: cancel, done: make(chan struct{}), explicitImport: true}
	if s.researchNetworkOwners == nil {
		s.researchNetworkOwners = map[*researchNetworkLease]struct{}{}
	}
	s.researchNetworkOwners[lease] = struct{}{}
	s.researchNetworkMu.Unlock()
	var once sync.Once
	return context.WithValue(ctx, researchNetworkKey{}, lease), func() {
		once.Do(func() {
			cancel()
			s.researchNetworkMu.Lock()
			delete(s.researchNetworkOwners, lease)
			close(lease.done)
			s.researchNetworkMu.Unlock()
			finishAI()
		})
	}, nil
}

func (s *Server) readResearchImport(ctx context.Context, q researchRowQuery, topic, candidate, request string) (Document, error) {
	var raw, run, key string
	err := q.QueryRowContext(ctx, `SELECT body,run_id,unit_key FROM research_units WHERE kind='candidate-import' AND unit_key=?`, "import:"+request).Scan(&raw, &run, &key)
	if err != nil {
		return Document{}, err
	}
	var u ResearchUnit
	var result researchImportResult
	if json.Unmarshal([]byte(raw), &u) != nil || u.RunID != run || u.UnitKey != key || u.Kind != "candidate-import" || u.Status != "complete" || u.ContentHash != sourceKey(string(u.Result)) || json.Unmarshal(u.Result, &result) != nil {
		return Document{}, errResearchScopeChanged
	}
	if result.TopicID != topic || result.CandidateID != candidate {
		return Document{}, paperConflict("请求标识已用于其他候选")
	}
	scope, err := readResearchRunScope(ctx, q, run)
	if err != nil {
		return Document{}, err
	}
	if scope.Run.TopicID != topic || scope.Run.SessionID != result.SessionID {
		return Document{}, errResearchScopeChanged
	}
	var mapped string
	if err = q.QueryRowContext(ctx, `SELECT json_extract(body,'$.documentId') FROM research_candidates WHERE id=? AND topic_id=?`, candidate, topic).Scan(&mapped); err != nil || mapped != result.Document.ID {
		return Document{}, errResearchScopeChanged
	}
	d, err := scanDocument(q.QueryRowContext(ctx, `SELECT `+documentColumns+` FROM documents WHERE id=?`, result.Document.ID))
	if err != nil || d.DeletedAt != "" || d.PaperID != result.Document.PaperID {
		return Document{}, errResearchScopeChanged
	}
	if _, err = os.Stat(s.Store.File(d)); err != nil {
		return Document{}, errResearchScopeChanged
	}
	return result.Document, nil
}

func findResearchCandidatePaper(ctx context.Context, tx *sql.Tx, c ResearchCandidate) (PaperItem, error) {
	if c.PaperID != "" {
		p, e := readPaper(tx, c.PaperID)
		if e != nil || p.DeletedAt != "" || !candidatePaperIdentity(c, p) {
			return p, errResearchScopeChanged
		}
		return p, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,metadata FROM paper_items`)
	if err != nil {
		return PaperItem{}, err
	}
	match := ""
	for rows.Next() {
		var id, raw string
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return PaperItem{}, err
		}
		var m PaperMetadata
		if json.Unmarshal([]byte(raw), &m) != nil {
			continue
		}
		if c.DOI != "" && strings.EqualFold(strings.TrimSpace(c.DOI), strings.TrimSpace(m.DOI)) || scholar.SameArXiv(c.ArXiv, m.ArXiv) {
			if match != "" && match != id {
				rows.Close()
				return PaperItem{}, errResearchScopeChanged
			}
			match = id
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return PaperItem{}, err
	}
	if match == "" {
		return PaperItem{}, sql.ErrNoRows
	}
	p, err := readPaper(tx, match)
	if err == nil && p.DeletedAt != "" {
		err = errResearchScopeChanged
	}
	return p, err
}

func (s *Server) importResearchCandidate(parent context.Context, topicID, candidateID, requestID string) (Document, error) {
	if !researchRequestID.MatchString(requestID) {
		return Document{}, paperConflict("导入请求标识无效")
	}
	// Committed retries never acquire public-network permission or repeat I/O.
	if d, e := s.readResearchImport(parent, s.Store.DB, topicID, candidateID, requestID); e == nil {
		return d, nil
	} else if !errors.Is(e, sql.ErrNoRows) {
		return Document{}, e
	}
	scope, c, version, registration, err := s.researchCandidateRegistration(parent, topicID, candidateID)
	if err != nil {
		return Document{}, err
	}
	ctx, finish, err := s.beginResearchImport(parent, scope)
	if err != nil {
		return Document{}, err
	}
	defer finish()
	value, _ := s.researchImportLocks.LoadOrStore(requestID, &sync.Mutex{})
	lock := value.(*sync.Mutex)
	if err = lockImportContext(ctx, lock); err != nil {
		return Document{}, err
	}
	defer lock.Unlock()
	if d, e := s.readResearchImport(ctx, s.Store.DB, topicID, candidateID, requestID); e == nil {
		return d, nil
	} else if !errors.Is(e, sql.ErrNoRows) {
		return Document{}, e
	}
	var saved Document
	commit := func(tx *sql.Tx, d Document, created bool) error {
		if e := checkResearchNetworkLease(ctx, tx, scope.Run.ID); e != nil {
			return e
		}
		current, currentVersion, e := readResearchRegisteredCandidate(ctx, tx, scope, candidateID)
		if e != nil {
			return e
		}
		if currentVersion != version {
			return errResearchScopeChanged
		}
		existing, e := findResearchCandidatePaper(ctx, tx, current)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		doc, e := scanDocument(tx.QueryRowContext(ctx, `SELECT `+documentColumns+` FROM documents WHERE id=?`, d.ID))
		if e != nil {
			return e
		}
		if existing.ID != "" && existing.ID != doc.PaperID {
			if !created {
				return errResearchScopeChanged
			}
			oldPaper := doc.PaperID
			if _, e = tx.ExecContext(ctx, `UPDATE paper_attachments SET paper_id=? WHERE document_id=?`, existing.ID, doc.ID); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, `UPDATE paper_items SET primary_document_id=CASE WHEN primary_document_id='' THEN ? ELSE primary_document_id END WHERE id=?`, doc.ID, existing.ID); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, `DELETE FROM paper_items WHERE id=?`, oldPaper); e != nil {
				return e
			}
			if e = syncPaperAttachments(tx, existing.ID); e != nil {
				return e
			}
			doc.PaperID = existing.ID
		} else if created && existing.ID == "" {
			metadata := PaperMetadata{DOI: c.DOI, ArXiv: c.ArXiv, Abstract: c.Abstract, Date: c.PublishedAt}
			if _, e = tx.ExecContext(ctx, `UPDATE paper_items SET title=?,author=?,metadata=? WHERE id=?`, c.Title, c.Authors, jsonText(metadata), doc.PaperID); e != nil {
				return e
			}
		} else if !created {
			p, e := readPaper(tx, doc.PaperID)
			if e != nil || !candidatePaperIdentity(current, p) {
				return errResearchScopeChanged
			}
		}
		saved, e = scanDocument(tx.QueryRowContext(ctx, `SELECT `+documentColumns+` FROM documents WHERE id=?`, doc.ID))
		if e != nil {
			return e
		}
		current.PaperID = saved.PaperID
		current.DocumentID = saved.ID
		if _, e = tx.ExecContext(ctx, `UPDATE research_candidates SET body=?,updated_at=? WHERE id=? AND topic_id=?`, jsonText(current), now(), candidateID, topicID); e != nil {
			return e
		}
		lease := ctx.Value(researchNetworkKey{}).(*researchNetworkLease)
		result := json.RawMessage(jsonText(researchImportResult{TopicID: topicID, CandidateID: candidateID, SessionID: scope.Run.SessionID, RegistrationID: registration, Generation: lease.generation, Document: saved}))
		return writeResearchUnit(ctx, tx, ResearchUnit{RunID: scope.Run.ID, UnitKey: "import:" + requestID, Kind: "candidate-import", Status: "complete", ContentHash: sourceKey(string(result)), Result: result})
	}
	// Exact scholarly identity dedup preserves the user's original attachment and
	// citation key. Title similarity never merges two papers.
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return Document{}, err
	}
	paper, findErr := findResearchCandidatePaper(ctx, tx, c)
	tx.Rollback()
	if findErr != nil && !errors.Is(findErr, sql.ErrNoRows) {
		return Document{}, findErr
	}
	original := ""
	for _, a := range paper.Attachments {
		if a.Role == "original" && (original == "" || a.DocumentID == paper.PrimaryDocumentID) {
			original = a.DocumentID
		}
	}
	if c.DocumentID != "" && original == "" {
		return Document{}, errResearchScopeChanged
	}
	if original != "" {
		if err = lockImportContext(ctx, &s.importMu); err != nil {
			return Document{}, err
		}
		d, e := s.Store.Document(original)
		if e != nil || d.DeletedAt != "" {
			s.importMu.Unlock()
			return Document{}, errResearchScopeChanged
		}
		if _, e = os.Stat(s.Store.File(d)); e != nil {
			s.importMu.Unlock()
			return Document{}, errResearchScopeChanged
		}
		s.researchNetworkMu.Lock()
		tx, e = s.Store.DB.BeginTx(ctx, nil)
		if e == nil {
			e = commit(tx, d, false)
			if e == nil {
				e = ctx.Err()
			}
			if e == nil {
				e = tx.Commit()
			} else {
				tx.Rollback()
			}
		}
		s.researchNetworkMu.Unlock()
		s.importMu.Unlock()
		return saved, e
	}
	var previouslyLocal int
	if err = s.Store.DB.QueryRowContext(ctx, `SELECT count(*) FROM research_evidence WHERE candidate_id=? AND topic_id=? AND paper_id!=''`, c.ID, c.TopicID).Scan(&previouslyLocal); err != nil {
		return Document{}, err
	}
	if previouslyLocal > 0 {
		return Document{}, errResearchScopeChanged
	}
	release, err := reserveResearchRemoteWork("import:" + requestID)
	if err != nil {
		return Document{}, err
	}
	defer release()
	work, err := os.MkdirTemp(filepath.Join(s.Store.Root, "ai-work"), "research-import-")
	if err != nil {
		return Document{}, err
	}
	defer os.RemoveAll(work)
	raw := c.PDFURL
	if raw == "" {
		raw = c.LandingURL
	}
	if raw == "" {
		return Document{}, paperConflict("候选没有公开原文地址")
	}
	requestCtx := scholar.WithPublicReservation(ctx, func(cctx context.Context) error {
		s.researchNetworkMu.Lock()
		defer s.researchNetworkMu.Unlock()
		return checkResearchNetworkLease(cctx, s.Store.DB, scope.Run.ID)
	})
	resource, err := s.scholarClient().FetchPublic(requestCtx, raw, "pdf")
	if err != nil {
		return Document{}, err
	}
	if err = ctx.Err(); err != nil {
		return Document{}, err
	}
	path := filepath.Join(work, "source.pdf")
	if err = os.WriteFile(path, resource.Bytes, 0600); err != nil {
		return Document{}, err
	}
	// Import into the library root; choosing a candidate does not move existing
	// papers or silently assign the research folder/tags.
	_, _, err = s.importFileToCategoryWithCommit(ctx, path, "candidate.pdf", "papers", true, "", "", commit)
	return saved, err
}

func (s *Server) researchCandidatesHTTP(w http.ResponseWriter, r *http.Request) {
	topic := r.PathValue("topic")
	if _, err := s.Store.ResearchTopic(r.Context(), topic); err != nil {
		researchError(w, err)
		return
	}
	rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT body,id,identity_key FROM research_candidates WHERE topic_id=? ORDER BY created_at,id`, topic)
	if err != nil {
		researchError(w, err)
		return
	}
	defer rows.Close()
	out := []ResearchCandidate{}
	for rows.Next() {
		var raw, id, identity string
		var c ResearchCandidate
		if rows.Scan(&raw, &id, &identity) != nil || json.Unmarshal([]byte(raw), &c) != nil || c.ID != id || c.IdentityKey != identity || c.TopicID != topic {
			researchError(w, errResearchScopeChanged)
			return
		}
		out = append(out, publicResearchCandidate(c))
	}
	if err = rows.Err(); err != nil {
		researchError(w, err)
		return
	}
	respond(w, 200, out)
}
func (s *Server) researchSearchesHTTP(w http.ResponseWriter, r *http.Request) {
	topic := r.PathValue("topic")
	if _, err := s.Store.ResearchTopic(r.Context(), topic); err != nil {
		researchError(w, err)
		return
	}
	rows, err := s.Store.DB.QueryContext(r.Context(), `SELECT body,id,run_id FROM research_searches WHERE topic_id=? ORDER BY created_at,id`, topic)
	if err != nil {
		researchError(w, err)
		return
	}
	defer rows.Close()
	out := []ResearchSearch{}
	for rows.Next() {
		var raw, id, run string
		var q ResearchSearch
		if rows.Scan(&raw, &id, &run) != nil || json.Unmarshal([]byte(raw), &q) != nil || q.ID != id || q.RunID != run {
			researchError(w, errResearchScopeChanged)
			return
		}
		out = append(out, q)
	}
	if err = rows.Err(); err != nil {
		researchError(w, err)
		return
	}
	respond(w, 200, out)
}
func (s *Server) researchCandidateImportHTTP(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RequestID string `json:"requestId"`
	}
	if !decode(w, r, &in) {
		return
	}
	d, err := s.importResearchCandidate(r.Context(), r.PathValue("topic"), r.PathValue("candidate"), in.RequestID)
	if err != nil {
		researchError(w, err)
		return
	}
	respond(w, 200, d)
}
