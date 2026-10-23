package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

var researchRequestID = regexp.MustCompile(`^[0-9a-f]{32}$`)
var errResearchBudget = errors.New("本次研究预算已耗尽，可显式继续")

// Only safe immutable identities are persisted. The private native snapshot,
// including the API key, belongs exclusively to the in-memory attempt.
type researchRunRecord struct {
	ResearchRun
	Input           ResearchRunInput `json:"input"`
	ConfigHash      string           `json:"configHash"`
	ModelIdentity   string           `json:"modelIdentity,omitempty"`
	Attempt         int              `json:"attempt"`
	AttemptBudget   ResearchBudget   `json:"attemptBudget"`
	AttemptRequests int              `json:"attemptRequests"`
	ModelRequests   int              `json:"modelRequests"`
	AttemptStarted  string           `json:"attemptStarted,omitempty"`
	EventSequence   int64            `json:"eventSequence"`
}
type researchAttemptKey struct{}
type researchAttempt struct {
	snapshot nativeTaskSnapshot
	runID    string
	server   *Server
}

func normalizeResearchBudget(b ResearchBudget) (ResearchBudget, error) {
	values := []*int{&b.MaxModelRequests, &b.MaxSearchRequests, &b.MaxRemoteReads, &b.MaxMinutes}
	defaults := []int{200, 24, 8, 30}
	max := []int{1000, 100, 50, 120}
	for i, p := range values {
		if *p == 0 {
			*p = defaults[i]
		}
		if *p < 1 || *p > max[i] {
			return b, fmt.Errorf("研究预算超出允许范围")
		}
	}
	return b, nil
}
func (s *Server) researchConfigIdentity() (nativeAIStored, string, error) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	stored, err := s.readNativeAIConfig()
	return stored, sourceKey(jsonText([]any{stored.Config, nativeConfigPrint(stored.Connection, "research"), stored.Capabilities})), err
}
func readResearchRecord(ctx context.Context, q researchRowQuery, runID string) (researchRunRecord, error) {
	var record researchRunRecord
	var raw, topic, session, message, status, snapshotID, revision string
	err := q.QueryRowContext(ctx, `SELECT r.body,r.topic_id,r.session_id,r.user_message_id,r.status,n.id,n.revision FROM research_runs r JOIN research_sessions s ON s.id=r.session_id AND s.topic_id=r.topic_id JOIN research_snapshots n ON n.id=json_extract(r.body,'$.snapshotId') AND n.topic_id=r.topic_id WHERE r.id=? AND json_extract(n.body,'$.id')=n.id AND json_extract(n.body,'$.topicId')=n.topic_id AND json_extract(n.body,'$.revision')=n.revision`, runID).Scan(&raw, &topic, &session, &message, &status, &snapshotID, &revision)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &record)
	}
	if err == nil && (record.ID != runID || record.TopicID != topic || record.SessionID != session || record.UserMessageID != message || record.Status != status || record.SnapshotID != snapshotID || record.Revision != revision) {
		err = errResearchScopeChanged
	}
	return record, err
}
func writeResearchRecord(ctx context.Context, tx *sql.Tx, r researchRunRecord) error {
	scope, err := readResearchRunScope(ctx, tx, r.ID)
	if err != nil {
		return err
	}
	if scope.Run.TopicID != r.TopicID || scope.Run.SessionID != r.SessionID || scope.Run.SnapshotID != r.SnapshotID || scope.Run.UserMessageID != r.UserMessageID || scope.Run.Revision != r.Revision {
		return errResearchScopeChanged
	}
	r.UpdatedAt = now()
	_, err = tx.ExecContext(ctx, `UPDATE research_runs SET status=?,body=?,updated_at=? WHERE id=?`, r.Status, jsonText(r), r.UpdatedAt, r.ID)
	return err
}
func writeResearchUnit(ctx context.Context, tx *sql.Tx, u ResearchUnit) error {
	scope, err := readResearchRunScope(ctx, tx, u.RunID)
	if err != nil {
		return err
	}
	if u.Kind == "paper" && u.Status == "complete" {
		var card ResearchPaperCard
		if json.Unmarshal(u.Result, &card) != nil {
			return errResearchScopeChanged
		}
		m, e := scope.member(card.PaperID)
		revision := m.CorpusRevision
		if revision == "" {
			revision = m.SourceHash
		}
		if e != nil || card.DocumentID != m.DocumentID || card.Revision != revision || card.Level != m.Coverage || u.UnitKey != "paper:"+m.PaperID {
			return errResearchScopeChanged
		}
		allowed := map[string]bool{}
		for _, source := range card.EvidenceIDs {
			ev, e := readResearchEvidence(ctx, tx, source)
			if e != nil || ev.RunID != u.RunID || ev.SnapshotID != scope.Snapshot.ID || ev.PaperID != m.PaperID || ev.DocumentID != m.DocumentID || ev.Availability != "valid" {
				return errResearchScopeChanged
			}
			allowed[source] = true
		}
		if err = validateResearchFacts(researchFacts(&card), allowed); err != nil {
			return err
		}
	}
	if u.CreatedAt == "" {
		u.CreatedAt = now()
	}
	u.UpdatedAt = now()
	_, err = tx.ExecContext(ctx, `INSERT INTO research_units(run_id,unit_key,kind,status,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,unit_key) DO UPDATE SET kind=excluded.kind,status=excluded.status,body=excluded.body,updated_at=excluded.updated_at`, u.RunID, u.UnitKey, u.Kind, u.Status, jsonText(u), u.CreatedAt, u.UpdatedAt)
	return err
}
func readResearchUnit(ctx context.Context, q researchRowQuery, runID, key string) (ResearchUnit, error) {
	var u ResearchUnit
	var raw, kind, status string
	err := q.QueryRowContext(ctx, `SELECT body,kind,status FROM research_units WHERE run_id=? AND unit_key=?`, runID, key).Scan(&raw, &kind, &status)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &u)
	}
	if err == nil && (u.RunID != runID || u.UnitKey != key || u.Kind != kind || u.Status != status) {
		err = errResearchScopeChanged
	}
	return u, err
}
func writeResearchMessage(ctx context.Context, tx *sql.Tx, m ResearchMessage) error {
	scope, err := readResearchRunScope(ctx, tx, m.RunID)
	if err != nil {
		return err
	}
	if scope.Run.SessionID != m.SessionID {
		return errResearchScopeChanged
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO research_messages(id,session_id,run_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?)`, m.ID, m.SessionID, m.RunID, jsonText(m), m.CreatedAt, m.CreatedAt)
	return err
}
func (s *Server) createResearchRun(ctx context.Context, topicID, sessionID string, in ResearchRunInput) (ResearchRun, error) {
	if !researchRequestID.MatchString(in.UserMessageID) || strings.TrimSpace(in.Question) == "" || len(in.Question) > 64<<10 {
		return ResearchRun{}, fmt.Errorf("研究问题或请求标识无效")
	}
	if in.Mode != "overview" && in.Mode != "compare" && in.Mode != "question" && in.Mode != "ideas" && in.Mode != "novelty" {
		return ResearchRun{}, fmt.Errorf("研究模式无效")
	}
	if in.Network != "inherit" && in.Network != "allow-task" && in.Network != "deny" {
		return ResearchRun{}, fmt.Errorf("联网设置无效")
	}
	if in.Mode == "novelty" && in.IdeaID == "" {
		return ResearchRun{}, fmt.Errorf("查新须指定 ideaId")
	}
	if in.IdeaCount < 0 || in.IdeaCount > 3 || len(in.URLs) > 8 {
		return ResearchRun{}, fmt.Errorf("研究输入超出限制")
	}
	for _, u := range in.URLs {
		if len(u) > 4096 {
			return ResearchRun{}, fmt.Errorf("链接过长")
		}
	}
	// Hash the supplied body, before normalizing defaults, so changed input is a conflict.
	hash := sourceKey(jsonText(in))
	var existing, oldHash string
	err := s.Store.DB.QueryRowContext(ctx, `SELECT id,request_hash FROM research_runs WHERE session_id=? AND user_message_id=?`, sessionID, in.UserMessageID).Scan(&existing, &oldHash)
	if err == nil {
		r, e := s.getResearchRun(ctx, existing)
		if oldHash != hash || r.TopicID != topicID {
			return r, paperConflict("请求标识已用于其他内容")
		}
		return r, e
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ResearchRun{}, err
	}
	budget, err := normalizeResearchBudget(in.Budget)
	if err != nil {
		return ResearchRun{}, err
	}
	in.Budget = budget
	if in.IdeaCount == 0 {
		in.IdeaCount = 3
	}
	session, err := s.Store.ResearchSession(ctx, sessionID)
	if err != nil {
		return ResearchRun{}, err
	}
	if session.TopicID != topicID {
		return ResearchRun{}, paperConflict("会话不属于该主题")
	}
	if len(in.URLs) > 0 && (in.Network == "deny" || in.Network == "inherit" && !session.NetworkAllowed) {
		return ResearchRun{}, fmt.Errorf("请先允许本次任务联网")
	}
	_, configHash, err := s.researchConfigIdentity()
	if err != nil {
		return ResearchRun{}, err
	}
	snap, err := s.snapshotResearchScope(ctx, topicID)
	if err != nil {
		return ResearchRun{}, err
	}
	r := researchRunRecord{ResearchRun: ResearchRun{ID: id(), TopicID: topicID, SessionID: sessionID, UserMessageID: in.UserMessageID, Status: "preparing", Phase: "snapshot", SnapshotID: snap.ID, Revision: snap.Revision, Total: len(snap.Members), UpdatedAt: now(), Coverage: ResearchCoverage{TotalPapers: len(snap.Members), PendingPapers: len(snap.Members), ReadCoverage: map[string]ResearchReadCoverage{}}}, Input: in, ConfigHash: configHash, AttemptBudget: budget}
	for _, m := range snap.Members {
		if m.Coverage == "unavailable" {
			r.Coverage.UnavailablePapers++
			r.Coverage.PendingPapers--
			continue
		}
		if m.Coverage == "abstract" {
			r.Coverage.AbstractOnlyPapers++
		}
		st, e := s.prepareResearchRead(ctx, m)
		if e != nil {
			return r.ResearchRun, e
		}
		coverage := researchCoverageFor(st, nil)
		st.Finish()
		r.Coverage.ReadCoverage[m.PaperID] = coverage
		r.Coverage.TotalUnits += coverage.TotalUnits
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return r.ResearchRun, err
	}
	defer tx.Rollback()
	err = tx.QueryRowContext(ctx, `SELECT id,request_hash FROM research_runs WHERE session_id=? AND user_message_id=?`, sessionID, in.UserMessageID).Scan(&existing, &oldHash)
	if err == nil {
		prior, e := readResearchRecord(ctx, tx, existing)
		if oldHash != hash || prior.TopicID != topicID {
			return r.ResearchRun, paperConflict("请求标识已用于其他内容")
		}
		return prior.ResearchRun, e
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return r.ResearchRun, err
	}
	var owner string
	if err = tx.QueryRowContext(ctx, `SELECT topic_id FROM research_sessions WHERE id=?`, sessionID).Scan(&owner); err != nil || owner != topicID {
		return r.ResearchRun, errResearchScopeChanged
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO research_runs(id,topic_id,session_id,user_message_id,status,request_hash,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, r.ID, topicID, sessionID, in.UserMessageID, r.Status, hash, jsonText(r), r.UpdatedAt, r.UpdatedAt)
	if err == nil {
		err = writeResearchMessage(ctx, tx, ResearchMessage{ID: id(), SessionID: sessionID, RunID: r.ID, Role: "user", Content: in.Question, CreatedAt: r.UpdatedAt})
	}
	if err != nil {
		return r.ResearchRun, err
	}
	return r.ResearchRun, tx.Commit()
}
func (s *Server) getResearchRun(ctx context.Context, runID string) (ResearchRun, error) {
	r, err := readResearchRecord(ctx, s.Store.DB, runID)
	if err != nil {
		return r.ResearchRun, err
	}
	u := &ResearchUsage{Attempt: r.Attempt, AttemptBudget: r.AttemptBudget, AttemptRequests: r.AttemptRequests, ModelRequests: r.ModelRequests, Calls: []UsageCall{}}
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT json_extract(body,'$.result') FROM research_units WHERE run_id=? AND kind='usage' ORDER BY created_at,unit_key`, runID)
	if err != nil {
		return r.ResearchRun, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		var call UsageCall
		if err = rows.Scan(&raw); err != nil {
			return r.ResearchRun, err
		}
		if err = json.Unmarshal([]byte(raw), &call); err != nil {
			return r.ResearchRun, err
		}
		u.Calls = append(u.Calls, call)
	}
	r.Usage = u
	return r.ResearchRun, rows.Err()
}

func (s *Server) controlResearchRun(ctx context.Context, runID, action string, in ResearchControl) (ResearchRun, error) {
	if !researchRequestID.MatchString(in.RequestID) {
		return ResearchRun{}, fmt.Errorf("控制请求标识无效")
	}
	if action != "start" && action != "resume" && action != "pause" && action != "cancel" {
		return ResearchRun{}, fmt.Errorf("控制动作无效")
	}
	hash := sourceKey(jsonText([]any{action, in}))
	key := "control:" + in.RequestID
	value, _ := s.researchControlLocks.LoadOrStore(runID, &sync.Mutex{})
	controlLock := value.(*sync.Mutex)
	// Stop controls must cancel catalog preparation even while the start
	// operation owns the control lock. Check the durable request before doing so
	// to ensure replaying an old pause cannot cancel a newer attempt.
	for !controlLock.TryLock() {
		if action == "pause" || action == "cancel" {
			if err := s.cancelResearchControl(runID, key, hash); err != nil {
				return ResearchRun{}, err
			}
		}
		select {
		case <-ctx.Done():
			return ResearchRun{}, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	defer controlLock.Unlock()
	if action == "pause" || action == "cancel" {
		if err := s.cancelResearchControl(runID, key, hash); err != nil {
			return ResearchRun{}, err
		}
	}
	prior, err := readResearchUnit(ctx, s.Store.DB, runID, key)
	if err == nil {
		if prior.ContentHash != hash {
			return ResearchRun{}, paperConflict("控制请求标识内容冲突")
		}
		return s.getResearchRun(ctx, runID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ResearchRun{}, err
	}
	r, err := readResearchRecord(ctx, s.Store.DB, runID)
	if err != nil {
		return r.ResearchRun, err
	}
	if action == "pause" || action == "cancel" {
		s.researchMu.Lock()
		worker := s.researchWorkers[runID]
		if worker != nil {
			worker.cancel()
		}
		s.researchMu.Unlock()
		if worker != nil {
			select {
			case <-worker.done:
			case <-ctx.Done():
				return r.ResearchRun, ctx.Err()
			}
		}
		r, err = readResearchRecord(ctx, s.Store.DB, runID)
		if err != nil {
			return r.ResearchRun, err
		}
		if r.Status != "completed" {
			r.Status = "paused"
			if action == "cancel" {
				r.Status = "canceled"
			}
			r.Error = ""
			r.LimitReason = ""
		}
		return s.acceptResearchControl(ctx, r, key, hash, action)
	}
	if r.Status == "completed" || r.Status == "running" || r.Status == "queued" {
		return s.acceptResearchControl(ctx, r, key, hash, action)
	}
	if action == "start" && r.Attempt != 0 {
		return r.ResearchRun, paperConflict("任务已经开始，请显式继续")
	}
	stored, configHash, err := s.researchConfigIdentity()
	if err != nil {
		return r.ResearchRun, err
	}
	if configHash != r.ConfigHash {
		return r.ResearchRun, paperConflict("模型配置已变更，请创建新任务")
	}
	current, err := s.snapshotResearchScope(ctx, r.TopicID)
	if err != nil {
		return r.ResearchRun, err
	}
	if current.Revision != r.Revision {
		return r.ResearchRun, paperConflict("研究范围或原文已变更，请创建新任务")
	}
	budget := r.Input.Budget
	if in.Budget != nil {
		budget = *in.Budget
	}
	budget, err = normalizeResearchBudget(budget)
	if err != nil {
		return r.ResearchRun, err
	}
	scope, err := readResearchRunScope(ctx, s.Store.DB, runID)
	if err != nil {
		return r.ResearchRun, err
	}
	worker, err := s.registerResearchWorker(scope)
	if err != nil {
		return r.ResearchRun, err
	}
	s.researchMu.Lock()
	worker.controls[key] = hash
	s.researchMu.Unlock()
	// Registration precedes catalog I/O. A lost HTTP response does not cancel this
	// explicit background operation; lifecycle cancellation still joins it.
	snapshot, err := s.resolveNativeStoredTask(worker.ctx, stored, taskResearch)
	if err != nil {
		s.finishResearchWorker(runID, worker)
		return r.ResearchRun, err
	}
	identity := sourceKey(jsonText([]any{snapshot.Fingerprint, snapshot.Model, snapshot.Effort, snapshot.ContextWindow, snapshot.MaxOutputTokens, snapshot.Tools, snapshot.Vision}))
	if r.ModelIdentity != "" && r.ModelIdentity != identity {
		s.finishResearchWorker(runID, worker)
		return r.ResearchRun, paperConflict("模型能力或窗口已变更，请创建新任务")
	}
	r.ModelIdentity = identity
	r.Attempt++
	r.AttemptRequests = 0
	r.AttemptBudget = budget
	r.AttemptStarted = now()
	r.Status = "queued"
	r.Error = ""
	r.LimitReason = ""
	accepted, err := s.acceptResearchControl(worker.ctx, r, key, hash, action)
	if err != nil {
		s.finishResearchWorker(runID, worker)
		return accepted, err
	}
	go s.executeResearch(worker, &researchAttempt{snapshot: snapshot, runID: runID, server: s})
	return accepted, nil
}
func (s *Server) acceptResearchControl(ctx context.Context, r researchRunRecord, key, hash, action string) (ResearchRun, error) {
	s.researchMu.Lock()
	worker := s.researchWorkers[r.ID]
	if worker != nil {
		worker.controls[key] = hash
	}
	s.researchMu.Unlock()
	committed := false
	defer func() {
		if !committed && worker != nil {
			s.researchMu.Lock()
			delete(worker.controls, key)
			s.researchMu.Unlock()
		}
	}()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return r.ResearchRun, err
	}
	defer tx.Rollback()
	current, err := readResearchRecord(ctx, tx, r.ID)
	if err != nil {
		return r.ResearchRun, err
	}
	if current.Status == "completed" || (action == "start" || action == "resume") && r.Attempt == current.Attempt {
		r = current
	}
	if err = writeResearchRecord(ctx, tx, r); err == nil {
		err = writeResearchUnit(ctx, tx, ResearchUnit{RunID: r.ID, UnitKey: key, Kind: "control", Status: "accepted", ContentHash: hash, Result: json.RawMessage(jsonText(map[string]any{"action": action, "attempt": r.Attempt, "run": r.ResearchRun}))})
	}
	if err != nil {
		return r.ResearchRun, err
	}
	err = tx.Commit()
	committed = err == nil
	return r.ResearchRun, err
}
func (a *researchAttempt) reserve(ctx context.Context) error {
	tx, err := a.server.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	r, err := readResearchRecord(ctx, tx, a.runID)
	if err != nil {
		return err
	}
	if r.Status != "running" {
		return context.Canceled
	}
	started, err := time.Parse(time.RFC3339Nano, r.AttemptStarted)
	if err != nil {
		return err
	}
	if r.AttemptRequests >= r.AttemptBudget.MaxModelRequests || time.Since(started) >= time.Duration(r.AttemptBudget.MaxMinutes)*time.Minute {
		return errResearchBudget
	}
	r.AttemptRequests++
	r.ModelRequests++
	if err = writeResearchRecord(ctx, tx, r); err != nil {
		return err
	}
	return tx.Commit()
}
func (a *researchAttempt) usage(call UsageCall) error {
	// Usage can arrive after cancellation. Preserve real unknown metrics and
	// failed calls using a short independent transaction, joined by the worker.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := a.server.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = writeResearchUnit(ctx, tx, ResearchUnit{RunID: a.runID, UnitKey: "usage:" + call.ID, Kind: "usage", Status: call.Status, Result: json.RawMessage(jsonText(call))}); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Server) executeResearch(w *researchWorker, a *researchAttempt) {
	defer s.finishResearchWorker(a.runID, w)
	r, err := readResearchRecord(w.ctx, s.Store.DB, a.runID)
	ctx := w.ctx
	if err == nil {
		var started time.Time
		started, err = time.Parse(time.RFC3339Nano, r.AttemptStarted)
		if err == nil {
			var cancel context.CancelFunc
			ctx, cancel = context.WithDeadline(ctx, started.Add(time.Duration(r.AttemptBudget.MaxMinutes)*time.Minute))
			defer cancel()
		}
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		select {
		case s.researchSlots <- struct{}{}:
			defer func() { <-s.researchSlots }()
		case <-ctx.Done():
			err = ctx.Err()
		}
	}
	if err == nil {
		err = s.setResearchRunState(ctx, a.runID, "running", "reading", nil)
	}
	ctx = context.WithValue(ctx, researchAttemptKey{}, a)
	ctx = context.WithValue(ctx, researchModelReservationKey{}, a.reserve)
	if err == nil {
		var r researchRunRecord
		r, err = readResearchRecord(ctx, s.Store.DB, a.runID)
		if err == nil {
			if r.Input.Mode == "ideas" || r.Input.Mode == "novelty" || len(r.Input.URLs) > 0 {
				err = fmt.Errorf("该研究阶段尚未启用")
			}
			var scope researchScope
			if err == nil {
				scope, err = readResearchRunScope(ctx, s.Store.DB, a.runID)
			}
			for _, m := range scope.Snapshot.Members {
				if err != nil {
					break
				}
				if m.Coverage == "unavailable" {
					continue
				}
				u, e := readResearchUnit(ctx, s.Store.DB, a.runID, "paper:"+m.PaperID)
				if e == nil && u.Status == "complete" {
					continue
				}
				if e != nil && !errors.Is(e, sql.ErrNoRows) {
					err = e
					break
				}
				_, err = s.analyzeResearchPaper(ctx, a.runID, m.PaperID)
				if err == nil {
					err = s.refreshResearchProgress(ctx, a.runID)
				}
			}
			if err == nil {
				_, err = s.composeResearchReport(ctx, a.runID)
			}
		}
	}
	if err != nil {
		status := "failed"
		if errors.Is(err, errResearchBudget) || errors.Is(err, context.DeadlineExceeded) {
			status = "paused"
		}
		if w.ctx.Err() != nil || errors.Is(err, errResearchScopeChanged) {
			status = "interrupted"
		}
		_ = s.setResearchRunState(context.Background(), a.runID, status, "", err)
		_ = s.publishResearchEvent(a.runID, "error", map[string]any{"error": err.Error(), "status": status})
	}
}
func (s *Server) setResearchRunState(ctx context.Context, runID, status, phase string, cause error) error {
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	r, err := readResearchRecord(ctx, tx, runID)
	if err != nil {
		return err
	}
	if r.Status == "completed" {
		return nil
	}
	if status == "running" && r.Status != "queued" && r.Status != "running" {
		return errResearchScopeChanged
	}
	r.Status = status
	if phase != "" {
		r.Phase = phase
	}
	if cause != nil {
		r.Error = cause.Error()
		if status == "paused" {
			r.LimitReason = cause.Error()
		}
	}
	if err = writeResearchRecord(ctx, tx, r); err != nil {
		return err
	}
	return tx.Commit()
}
