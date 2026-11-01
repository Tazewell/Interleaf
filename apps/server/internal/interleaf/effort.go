package interleaf

import (
	"context"
	"time"
)

type modelCatalogEntry struct {
	models     []AgentModel
	expires    time.Time
	generation uint64
}

func (s *Server) cachedCatalog(ctx context.Context, key string, discover func(context.Context) ([]AgentModel, error), refresh ...bool) ([]AgentModel, error) {
	ctx, finishIO, ioErr := s.beginAIIO(ctx)
	if ioErr != nil {
		return nil, ioErr
	}
	defer finishIO()

	s.modelMu.Lock()
	if s.modelCache == nil {
		s.modelCache = map[string]modelCatalogEntry{}
	}
	entry, ok := s.modelCache[key]
	if len(refresh) > 0 && refresh[0] {
		// Keep the generation after failure too: an older discovery must never
		// restore the invalidated catalog while a refresh is in flight.
		entry = modelCatalogEntry{generation: entry.generation + 1}
		s.modelCache[key] = entry
		ok = false
	}
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
	if s.modelCache[key].generation == entry.generation {
		s.modelCache[key] = modelCatalogEntry{models: models, expires: time.Now().Add(5 * time.Minute), generation: entry.generation}
	}
	s.modelMu.Unlock()
	return models, nil
}
