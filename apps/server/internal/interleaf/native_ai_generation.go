package interleaf

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Native generation owns one immutable endpoint/model choice for the attempt.
// Creating another worker never re-reads configuration or switches providers.
type nativeGenerationAdapter struct {
	server   *Server
	snapshot nativeTaskSnapshot
}

func (a nativeGenerationAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	ctx, finish, err := a.server.beginAIIO(ctx)
	if err != nil {
		return GenerateResult{}, err
	}
	defer finish()
	if req.Input.Chat != nil {
		if req.Input.Chat.Agent != nil {
			return streamAPIDocumentChat(ctx, a.snapshot.Connection, a.snapshot.completion(), req.Input, emit)
		}
		return streamNativeChat(ctx, a.snapshot, req.Input, emit)
	}
	return streamCompletion(ctx, a.snapshot.Connection, a.snapshot.completion(), req.Input, emit)
}
func (s nativeTaskSnapshot) completion() completionRequest {
	return completionRequest{Model: s.Model, Effort: s.Effort, SupportedEfforts: s.SupportedEfforts, ContextWindow: s.ContextWindow, MaxOutputTokens: s.MaxOutputTokens, Tools: s.Tools, Vision: s.Vision}
}
func (s *Server) nativeGenerationService(config NativeAIConfig, task modelTask) (*GenerationService, error) {
	return s.nativeGenerationServiceContext(context.Background(), config, task)
}
func (s *Server) nativeGenerationServiceContext(parent context.Context, config NativeAIConfig, task modelTask) (*GenerationService, error) {
	ctx, finish, err := s.beginAIIO(parent)
	if err != nil {
		return nil, err
	}
	defer finish()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	snapshot, err := s.resolveNativeTask(ctx, config, task)
	if err != nil {
		return nil, err
	}
	if task != taskTranslation {
		config.TranslationPrompt = nil
	}
	return s.nativeSnapshotService(snapshot, config.TranslationPrompt), nil
}
func (s *Server) nativeSnapshotService(snapshot nativeTaskSnapshot, prompt *string) *GenerationService {
	g := &GenerationService{primary: "api", connections: map[string]generationConnection{"api": {Adapter: nativeGenerationAdapter{s, snapshot}, VerifiedText: true, VerifiedVision: snapshot.Vision, Incremental: true}}}
	if prompt != nil {
		g.translationInstructions = *prompt
	}
	return g
}

// Background entry points retain configuration errors until they can report them
// through their own job state. A missing setting never creates a backup route.
func (s *Server) currentGenerationService(task modelTask) *GenerationService {
	return s.currentGenerationServiceContext(context.Background(), task)
}
func (s *Server) currentGenerationServiceContext(ctx context.Context, task modelTask) *GenerationService {
	config, err := s.nativeAIConfig()
	if err == nil {
		var g *GenerationService
		g, err = s.nativeGenerationServiceContext(ctx, config, task)
		if err == nil {
			return g
		}
	}
	return &GenerationService{initialError: err}
}

func nativeConfigPrint(c APIConnection, model string) string {
	b, _ := json.Marshal([]string{"api", c.URL, c.Key, c.Protocol, apiRulesVersion, model})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func nativeCapable(s nativeAIStored, model string, vision bool) bool {
	cap := s.Capabilities[apiCapabilityKey(model)]
	return cap.Fingerprint == nativeConfigPrint(s.Connection, model) && cap.Text && (!vision || cap.Vision)
}
func (s *Server) probeNativeConnection(parent context.Context, conn APIConnection, req completionRequest, in AIInput, timeout time.Duration) (string, *int64, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	if models, err := s.apiCatalog(conn)(ctx); err == nil {
		for _, m := range models {
			if m.ID == req.Model {
				req.SupportedEfforts = m.SupportedEfforts
				break
			}
		}
	}
	started := time.Now()
	var first *int64
	result, err := streamCompletion(ctx, conn, req, in, func(e ProviderEvent) error {
		if first == nil && (e.OutputObserved || strings.TrimSpace(e.Text+e.Reasoning) != "") {
			ms := time.Since(started).Milliseconds()
			first = &ms
		}
		return nil
	})
	if errors.Is(err, context.DeadlineExceeded) {
		err = generationError(ErrorTimeout, "API 检测超时")
	}
	return result.Text, first, err
}
