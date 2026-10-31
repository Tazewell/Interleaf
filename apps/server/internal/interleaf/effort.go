package interleaf

import (
	"context"
	"time"
)

type modelCatalogEntry struct {
	models  []AgentModel
	expires time.Time
}

func (s *Server) cachedCatalog(ctx context.Context, key string, discover func(context.Context) ([]AgentModel, error)) ([]AgentModel, error) {
	ctx, finishIO, ioErr := s.beginAIIO(ctx)
	if ioErr != nil {
		return nil, ioErr
	}
	defer finishIO()

	s.modelMu.Lock()
	entry, ok := s.modelCache[key]
	s.modelMu.Unlock()
	if ok && time.Now().Before(entry.expires) {
		return entry.models, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	models, err := discover(ctx)
	if err != nil {
		return nil, err
	}
	s.modelMu.Lock()
	if s.modelCache == nil {
		s.modelCache = map[string]modelCatalogEntry{}
	}
	s.modelCache[key] = modelCatalogEntry{models: models, expires: time.Now().Add(5 * time.Minute)}
	s.modelMu.Unlock()
	return models, nil
}
