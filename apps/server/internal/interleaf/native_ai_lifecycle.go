package interleaf

import (
	"context"
	"sync"
)

// Register before model/catalog I/O, including work without a document. Close
// cancels every owner under the lifecycle lock and joins outside it.
func (s *Server) beginAIIO(parent context.Context) (context.Context, func(), error) {
	s.documentMu.Lock()
	defer s.documentMu.Unlock()
	if s.documentClosed {
		return nil, nil, generationError(ErrorCanceled, "应用正在关闭")
	}
	ctx, cancel := context.WithCancel(parent)
	task := &documentTask{cancel: cancel, done: make(chan struct{})}
	if s.aiTasks == nil {
		s.aiTasks = map[*documentTask]struct{}{}
	}
	s.aiTasks[task] = struct{}{}
	var once sync.Once
	return ctx, func() {
		once.Do(func() {
			cancel()
			s.documentMu.Lock()
			delete(s.aiTasks, task)
			close(task.done)
			s.documentMu.Unlock()
		})
	}, nil
}

// A research source may have no document attachment. Its I/O still belongs to
// the paper, so paper mutations can cancel and join it before opening a DB Tx.
// Finishing never acquires importMu, which the mutation caller already owns.
func (s *Server) beginResearchPaperTask(parent context.Context, paperID string) (context.Context, func(), error) {
	s.documentMu.Lock()
	if s.documentClosed || s.deletingPapers[paperID] {
		s.documentMu.Unlock()
		return nil, nil, generationError(ErrorCanceled, "文献正在移除，无法开始分析")
	}
	ctx, cancel := context.WithCancel(parent)
	task := &documentTask{cancel: cancel, done: make(chan struct{})}
	if s.paperTasks == nil {
		s.paperTasks = map[string]map[*documentTask]struct{}{}
	}
	if s.paperTasks[paperID] == nil {
		s.paperTasks[paperID] = map[*documentTask]struct{}{}
	}
	s.paperTasks[paperID][task] = struct{}{}
	s.documentMu.Unlock()
	var once sync.Once
	finish := func() {
		once.Do(func() {
			cancel()
			s.documentMu.Lock()
			delete(s.paperTasks[paperID], task)
			if len(s.paperTasks[paperID]) == 0 {
				delete(s.paperTasks, paperID)
			}
			close(task.done)
			s.documentMu.Unlock()
		})
	}
	p, err := s.Store.PaperItem(paperID)
	if err != nil || p.ID != paperID || p.DeletedAt != "" {
		finish()
		return nil, nil, generationError(ErrorCanceled, "文献已不可用")
	}
	if err = ctx.Err(); err != nil {
		finish()
		return nil, nil, err
	}
	return ctx, finish, nil
}

// The caller holds importMu but no DB transaction. Keep the gate until the
// entire mutation settles; on rollback, the preserved source can be read again.
func (s *Server) stopResearchPaperTasks(paperID string) func() {
	s.documentMu.Lock()
	if s.deletingPapers == nil {
		s.deletingPapers = map[string]bool{}
	}
	s.deletingPapers[paperID] = true
	tasks := []*documentTask{}
	for task := range s.paperTasks[paperID] {
		task.cancel()
		tasks = append(tasks, task)
	}
	s.documentMu.Unlock()
	for _, task := range tasks {
		<-task.done
	}
	return func() { s.documentMu.Lock(); delete(s.deletingPapers, paperID); s.documentMu.Unlock() }
}

func (s *Server) Close() {
	_ = s.stopResearch(context.Background())
	s.documentMu.Lock()
	s.documentClosed = true
	var tasks []*documentTask
	for _, group := range s.documentTasks {
		for task := range group {
			task.cancel()
			tasks = append(tasks, task)
		}
	}
	for task := range s.aiTasks {
		task.cancel()
		tasks = append(tasks, task)
	}
	for _, group := range s.paperTasks {
		for task := range group {
			task.cancel()
			tasks = append(tasks, task)
		}
	}
	s.documentMu.Unlock()
	for _, task := range tasks {
		<-task.done
	}
}
