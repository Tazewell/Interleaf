package reader

import (
	"context"
	"sync"
)

type researchWorker struct {
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	scope    researchScope
	task     *documentTask
	once     sync.Once
	controls map[string]string // durable accepted hashes, protected by researchMu
}

// Entire run ownership includes queued work and synthesis, including metadata
// papers. No worker acquires importMu after registration: deletion owns it while
// joining. Registration and source deletion use the same lifecycle gate.
func (s *Server) registerResearchWorker(scope researchScope) (*researchWorker, error) {
	controls := map[string]string{}
	rows, err := s.Store.DB.Query(`SELECT unit_key,json_extract(body,'$.contentHash') FROM research_units WHERE run_id=? AND kind='control'`, scope.Run.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key, hash string
		if err = rows.Scan(&key, &hash); err != nil {
			rows.Close()
			return nil, err
		}
		controls[key] = hash
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	s.researchMu.Lock()
	defer s.researchMu.Unlock()
	if s.researchClosed {
		return nil, context.Canceled
	}
	for _, w := range s.researchWorkers {
		if w.scope.Run.TopicID == scope.Run.TopicID {
			return nil, paperConflict("该主题已有活动研究任务")
		}
	}
	s.documentMu.Lock()
	defer s.documentMu.Unlock()
	if s.documentClosed {
		return nil, context.Canceled
	}
	for _, m := range scope.Snapshot.Members {
		if s.deletingPapers[m.PaperID] || s.deletingDocuments[m.DocumentID] {
			return nil, context.Canceled
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	task := &documentTask{cancel: cancel, done: make(chan struct{})}
	w := &researchWorker{ctx: ctx, cancel: cancel, done: task.done, scope: scope, task: task, controls: controls}
	if s.researchWorkers == nil {
		s.researchWorkers = map[string]*researchWorker{}
		s.researchSlots = make(chan struct{}, 2)
	}
	s.researchWorkers[scope.Run.ID] = w
	if s.aiTasks == nil {
		s.aiTasks = map[*documentTask]struct{}{}
	}
	s.aiTasks[task] = struct{}{}
	if s.paperTasks == nil {
		s.paperTasks = map[string]map[*documentTask]struct{}{}
	}
	if s.documentTasks == nil {
		s.documentTasks = map[string]map[*documentTask]struct{}{}
	}
	for _, m := range scope.Snapshot.Members {
		if s.paperTasks[m.PaperID] == nil {
			s.paperTasks[m.PaperID] = map[*documentTask]struct{}{}
		}
		s.paperTasks[m.PaperID][task] = struct{}{}
		if m.DocumentID != "" {
			if s.documentTasks[m.DocumentID] == nil {
				s.documentTasks[m.DocumentID] = map[*documentTask]struct{}{}
			}
			s.documentTasks[m.DocumentID][task] = struct{}{}
		}
	}
	return w, nil
}

// A stop must not wait for the DB connection held by a committing worker.
// Accepted hashes are loaded before registration and updated after each commit,
// so replaying an older stop cannot cancel a newer attempt.
func (s *Server) cancelResearchControl(runID, key, hash string) error {
	s.researchMu.Lock()
	defer s.researchMu.Unlock()
	if w := s.researchWorkers[runID]; w != nil {
		if prior, ok := w.controls[key]; ok {
			if prior != hash {
				return paperConflict("控制请求标识内容冲突")
			}
			return nil
		}
		w.cancel()
	}
	return nil
}
func (s *Server) finishResearchWorker(runID string, w *researchWorker) {
	w.once.Do(func() {
		w.cancel()
		s.researchMu.Lock()
		defer s.researchMu.Unlock()
		s.documentMu.Lock()
		defer s.documentMu.Unlock()
		delete(s.researchWorkers, runID)
		delete(s.aiTasks, w.task)
		for _, m := range w.scope.Snapshot.Members {
			delete(s.paperTasks[m.PaperID], w.task)
			if len(s.paperTasks[m.PaperID]) == 0 {
				delete(s.paperTasks, m.PaperID)
			}
			delete(s.documentTasks[m.DocumentID], w.task)
			if len(s.documentTasks[m.DocumentID]) == 0 {
				delete(s.documentTasks, m.DocumentID)
			}
		}
		close(w.done)
	})
}
func (s *Server) stopResearch(ctx context.Context) error {
	s.researchMu.Lock()
	s.researchClosed = true
	tasks := []*researchWorker{}
	for _, w := range s.researchWorkers {
		w.cancel()
		tasks = append(tasks, w)
	}
	s.researchMu.Unlock()
	for _, w := range tasks {
		select {
		case <-w.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
func (s *Server) cancelResearchForDocument(ctx context.Context, documentID string) error {
	s.researchMu.Lock()
	tasks := []*researchWorker{}
	for _, w := range s.researchWorkers {
		for _, m := range w.scope.Snapshot.Members {
			if m.DocumentID == documentID {
				w.cancel()
				tasks = append(tasks, w)
				break
			}
		}
	}
	s.researchMu.Unlock()
	for _, w := range tasks {
		select {
		case <-w.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
func (s *Server) recoverResearch() error {
	// Recovery is SQL only. Never resolve a model/catalog or replay any request.
	_, err := s.Store.DB.Exec(`UPDATE research_runs SET status='interrupted',body=json_set(body,'$.status','interrupted','$.error','应用已重启，请显式继续','$.updatedAt',?),updated_at=? WHERE status IN ('preparing','queued','running')`, now(), now())
	return err
}
