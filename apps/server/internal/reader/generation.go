package reader

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"
)

type ErrorKind string

const (
	ErrorPermission     ErrorKind = "permission"
	ErrorModel          ErrorKind = "model"
	ErrorBilling        ErrorKind = "billing"
	ErrorContext        ErrorKind = "context_limit"
	ErrorContent        ErrorKind = "content_policy"
	ErrorConfiguration  ErrorKind = "configuration"
	ErrorAuthentication ErrorKind = "authentication"
	ErrorCapability     ErrorKind = "capability"
	ErrorProtocol       ErrorKind = "protocol"
	ErrorUpstream       ErrorKind = "upstream"
	ErrorLimit          ErrorKind = "limit"
	ErrorNetwork        ErrorKind = "network"
	ErrorTimeout        ErrorKind = "timeout"
	ErrorCanceled       ErrorKind = "canceled"
	ErrorSave           ErrorKind = "save"
)

type GenerationError struct {
	Kind    ErrorKind
	Message string
}

func (e *GenerationError) Error() string                   { return e.Message }
func generationError(kind ErrorKind, message string) error { return &GenerationError{kind, message} }
func errorKind(err error) ErrorKind {
	if errors.Is(err, context.Canceled) {
		return ErrorCanceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrorTimeout
	}
	var e *GenerationError
	if errors.As(err, &e) {
		return e.Kind
	}
	return ErrorUpstream
}

type ProviderEvent struct {
	Reasoning  string
	Draft      string
	ResetDraft bool
	Text       string
	Fallback   string
	Metrics    []ModelTokens

	// OutputObserved signals nonempty withheld content without carrying its text.
	OutputObserved bool
}
type GenerateRequest struct{ Input AIInput }
type GenerateResult struct {
	Reasoning    string
	Text         string
	FinishReason string
}
type Adapter interface {
	Stream(context.Context, GenerateRequest, func(ProviderEvent) error) (GenerateResult, error)
}

// Connections and secrets are request-local snapshots, never wire objects.
type generationConnection struct {
	Adapter                      Adapter
	VerifiedText, VerifiedVision bool
	Incremental                  bool
}
type GenerationService struct {
	initialError            error
	translationInstructions string
	timeout                 time.Duration // Zero keeps the normal three-minute request limit.
	primary                 string
	connections             map[string]generationConnection
	usageSink               func(UsageCall) error
}

func legacyEmitter(delta, fallback func(string)) func(ProviderEvent) error {
	if delta == nil && fallback == nil {
		return nil
	}
	return func(e ProviderEvent) error {
		if e.Text != "" && delta != nil {
			delta(e.Text)
		}
		if e.Fallback != "" && fallback != nil {
			fallback(e.Fallback)
		}
		return nil
	}
}

// Each attempt owns its accumulator. An emit error closes the gate immediately;
// late callbacks cannot escape even if a faulty adapter ignores cancellation.
func runAttempt(ctx context.Context, adapter Adapter, in AIInput, emit func(ProviderEvent) error) (GenerateResult, error) {
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	var mu sync.Mutex
	var text strings.Builder
	var reasoning strings.Builder
	var emitErr error
	closed := false
	result, err := adapter.Stream(child, GenerateRequest{in}, func(e ProviderEvent) error {
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return generationError(ErrorProtocol, "生成已结束")
		}
		if emitErr != nil {
			return emitErr
		}
		if child.Err() != nil {
			return child.Err()
		}
		if e.Fallback != "" {
			emitErr = generationError(ErrorProtocol, "适配器事件无效")
		} else if text.Len()+len(e.Text) > 1<<20 {
			emitErr = generationError(ErrorLimit, "回答超过 1 MiB 限制")
		} else if reasoning.Len()+len(e.Reasoning) > 1<<20 {
			emitErr = generationError(ErrorLimit, "思考内容超过 1 MiB 限制")
		} else if e.Text != "" || e.Draft != "" || e.Reasoning != "" || e.ResetDraft || len(e.Metrics) > 0 {
			text.WriteString(e.Text)
			reasoning.WriteString(e.Reasoning)
			if emit != nil {
				emitErr = emit(e)
			}
		}
		if emitErr != nil {
			cancel()
		}
		return emitErr
	})
	mu.Lock()
	defer mu.Unlock()
	closed = true
	if emitErr != nil {
		return GenerateResult{}, emitErr
	}
	if ctx.Err() != nil {
		return GenerateResult{}, ctx.Err()
	}
	if err != nil {
		return GenerateResult{}, err
	}
	if result.FinishReason != "stop" || text.Len() == 0 || result.Text != text.String() {
		return GenerateResult{}, generationError(ErrorProtocol, "完整回答与流式片段或成功终态不一致")
	}
	result.Reasoning = reasoning.String()
	return result, nil
}
func (g *GenerationService) Generate(ctx context.Context, in AIInput, interactive bool, emit func(ProviderEvent) error) (AIResult, error) {
	return g.generate(ctx, in, interactive, emit != nil, emit)
}
func (g *GenerationService) attempt(ctx context.Context, provider string, in AIInput, emit func(ProviderEvent) error) (result GenerateResult, err error) {
	started := time.Now()
	attemptID := id()
	ctx = context.WithValue(ctx, apiAttemptKey{}, attemptID)
	slog.Info("generation.start", "attemptId", attemptID, "requestId", requestID(ctx), "provider", provider, "vision", len(in.images()) > 0)
	defer func() {
		level := slog.LevelInfo
		kind := ErrorKind("")
		if err != nil {
			level = slog.LevelError
			kind = errorKind(err)
		}
		slog.Log(ctx, level, "generation.finish", "attemptId", attemptID, "requestId", requestID(ctx), "provider", provider, "durationMs", time.Since(started).Milliseconds(), "errorCode", kind)
	}()
	sink := g.usageSink
	structuredUsage := in.Chat != nil && provider == "api"
	if structuredUsage {
		in.UsageSink = g.usageSink
		in.UsageProvider = provider
		sink = nil
	}
	result, err = trackModelUsage(UsageCall{ID: attemptID, Provider: provider}, sink, emit, func(send func(ProviderEvent) error) (GenerateResult, error) {
		return runAttempt(ctx, g.connections[provider].Adapter, in, send)
	})

	return result, err
}
func (g *GenerationService) generate(ctx context.Context, in AIInput, interactive, exposeText bool, emit func(ProviderEvent) error) (AIResult, error) {
	if err := g.ValidateInput(in, interactive); err != nil {
		return AIResult{}, err
	}
	timeout := g.timeout
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	if in.Chat != nil {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, err := g.attempt(ctx, "api", in, emit)
	if ctx.Err() != nil {
		return AIResult{}, ctx.Err()
	}
	return AIResult{Text: result.Text, Reasoning: result.Reasoning, Provider: "api"}, err
}
func (g *GenerationService) ValidateInput(in AIInput, interactive bool) error {
	if g.initialError != nil {
		return g.initialError
	}
	if g.primary != "api" || g.connections["api"].Adapter == nil {
		return generationError(ErrorConfiguration, "请配置 API 连接和模型")
	}
	if len(in.images()) > 0 && in.Chat == nil && !g.connections["api"].VerifiedVision {
		return generationError(ErrorCapability, "图片模型未通过检测，当前为纯文字模式")
	}
	return nil
}
