package interleaf

import (
	"context"
	"sync"
)

// One sequential worker owns this history; closing it never affects another
// worker. Both model and credential are frozen before workers begin.
type nativeTranslationSession struct {
	*apiTranslationSession
	server *Server
	mu     sync.Mutex
	closed bool
	cancel context.CancelFunc
	done   chan struct{}
}

func (a *nativeTranslationSession) Stream(ctx context.Context, r GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	a.mu.Lock()
	if a.closed || a.done != nil {
		a.mu.Unlock()
		return GenerateResult{}, generationError(ErrorCanceled, "翻译会话已关闭或正在生成")
	}
	ctx, cancel := context.WithCancel(ctx)
	a.cancel = cancel
	a.done = make(chan struct{})
	done := a.done
	a.mu.Unlock()
	defer func() {
		cancel()
		a.mu.Lock()
		a.done = nil
		a.cancel = nil
		close(done)
		a.mu.Unlock()
	}()
	ctx, finish, err := a.server.beginAIIO(ctx)
	if err != nil {
		return GenerateResult{}, err
	}
	defer finish()
	return a.apiTranslationSession.Stream(ctx, r, emit)
}
func (s *Server) nativeTranslationService(snapshot nativeTaskSnapshot, prompt *string) (*GenerationService, *nativeTranslationSession) {
	choice := apiModelChoice{snapshot.Model, snapshot.Effort}
	a := &nativeTranslationSession{apiTranslationSession: &apiTranslationSession{apiAgentAdapter: apiAgentAdapter{conn: snapshot.Connection, text: choice, vision: choice, task: taskTranslation, catalog: func(context.Context) ([]AgentModel, error) {
		return []AgentModel{{ID: snapshot.Model, ContextWindow: snapshot.ContextWindow, SupportedEfforts: snapshot.SupportedEfforts}}, nil
	}}}, server: s}
	g := s.nativeSnapshotService(snapshot, prompt)
	g.connections["api"] = generationConnection{Adapter: a, VerifiedText: true, VerifiedVision: snapshot.Vision, Incremental: true}
	g.timeout = translationBatchTimeout
	return g, a
}

func (a *nativeTranslationSession) close() {
	a.mu.Lock()
	a.closed = true
	done := a.done
	if a.cancel != nil {
		a.cancel()
	}
	a.mu.Unlock()
	if done != nil {
		<-done
	}
	a.mu.Lock()
	a.apiTranslationSession.close()
	a.mu.Unlock()
}
