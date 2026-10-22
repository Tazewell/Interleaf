package reader

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

func (s *Server) Close() {
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
	s.documentMu.Unlock()
	s.codexChat.close()
	s.documentCodex.close()
	for _, task := range tasks {
		<-task.done
	}
}
