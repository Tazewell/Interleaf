package interleaf

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// The "api" agent calls a protocol-aware endpoint with a
// user-supplied key. Its models come from /models plus IDs the user adds, and
// text models may be entered directly; vision and tools require an explicit
// successful check. Unknown relays without metadata use low/medium/high.
type apiAgentAdapter struct {
	conn         APIConnection
	text, vision apiModelChoice
	task         modelTask
	// catalog lists the endpoint's models with this snapshot's check results.
	catalog func(context.Context) ([]AgentModel, error)
}

// An empty model picks the recommended model among those that passed.
type apiModelChoice struct{ model, level string }

func apiCapabilityKey(model string) string { return "api:" + model }

// resolve fixes the model and requested effort for one request. Wire mapping
// is applied by the endpoint/model profile, even when the catalog is unavailable.
func (a apiAgentAdapter) resolve(ctx context.Context, vision bool) (completionRequest, error) {
	if e := validateAgentAPI(a.conn); e != nil {
		return completionRequest{}, generationError(ErrorConfiguration, e.Error())
	}
	if a.conn.URL == "" {
		return completionRequest{}, generationError(ErrorConfiguration, "请在设置中填写 API 地址")
	}
	choice, task := a.text, a.task
	if vision {
		choice, task = a.vision, taskVision
	}
	req := completionRequest{Model: choice.model, Effort: choice.level}
	models, err := a.catalog(ctx)
	if err != nil {
		if req.Model == "" {
			return req, err
		}
		return req, nil
	}
	for _, m := range models {
		if req.Model == "" && slices.Contains(m.RecommendedFor, string(task)) {
			req.Model = m.ID
		}
	}
	if req.Model == "" {
		if vision {
			return req, generationError(ErrorCapability, "没有通过图片理解检测的 API 模型")
		}
		return req, generationError(ErrorCapability, "没有通过文本推理检测的 API 模型")
	}
	for _, m := range models {
		if m.ID == req.Model {
			req.ContextWindow = m.ContextWindow
			req.SupportedEfforts = m.SupportedEfforts
		}
	}
	return req, nil
}

// API catalogs do not have to publish reasoning capabilities. Use the standard
// tiers in that case, including for manually added IDs and catalog failures.
// Equal-distance choices prefer the stronger tier.
func apiEffort(level string, supported []string) string {
	// Capability probes intentionally have no effort; configured task choices
	// already supply medium when the user has not selected a level.
	if level == "" {
		return ""
	}
	tiers := []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}
	target := slices.Index(tiers, level)
	if target < 0 {
		target = slices.Index(tiers, "medium")
	}
	if len(supported) == 0 {
		supported = []string{"low", "medium", "high"}
	}
	best, distance := "", len(tiers)+1
	for i, tier := range tiers {
		if !slices.Contains(supported, tier) {
			continue
		}
		delta := i - target
		if delta < 0 {
			delta = -delta
		}
		if delta <= distance {
			best, distance = tier, delta
		}
	}
	return best
}

func (a apiAgentAdapter) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	if a.task == taskChat && req.Input.Chat != nil {
		chat := req.Input.Chat
		server := chat.server
		if server == nil && chat.Agent != nil {
			server = chat.Agent.server
		}
		var snapshot nativeTaskSnapshot
		if server != nil {
			config, e := server.nativeAIConfig()
			if e != nil {
				return GenerateResult{}, e
			}
			snapshot, e = server.resolveNativeTask(ctx, config, taskChat)
			if e != nil {
				return GenerateResult{}, e
			}
		} else {
			completion, e := a.resolve(ctx, false)
			if e != nil {
				return GenerateResult{}, e
			}
			snapshot = nativeSnapshot(a.conn, completion)
		}
		completion := completionRequest{Model: snapshot.Model, Effort: snapshot.Effort, ContextWindow: snapshot.ContextWindow, MaxOutputTokens: snapshot.MaxOutputTokens, Tools: snapshot.Tools, Vision: snapshot.Vision}
		if chat.Agent != nil {
			return streamAPIDocumentChat(ctx, snapshot.Connection, completion, req.Input, emit)
		}
		return streamNativeChat(ctx, snapshot, req.Input, emit)
	}
	completion, err := a.resolve(ctx, len(req.Input.images()) > 0)
	if err != nil {
		return GenerateResult{}, err
	}
	return streamCompletion(ctx, a.conn, completion, req.Input, emit)
}

// History beyond this size is trimmed from the oldest turns, down to half of
// it, so most batches reuse the provider's cached prompt prefix. One batch
// round trip is roughly 40–60 KB, so the budget keeps several recent batches
// and fits a 128K-token context window.
const apiTranslationHistoryBytes = 256 << 10

// apiTranslationSession keeps one conversation across the batches of a
// translation worker. A failed turn is not
// recorded and the earlier history is kept for the next batch.
type apiTranslationSession struct {
	apiAgentAdapter
	history []completionMessage
	size    int
}

func (s *apiTranslationSession) Stream(ctx context.Context, req GenerateRequest, emit func(ProviderEvent) error) (GenerateResult, error) {
	completion, err := s.resolve(ctx, len(req.Input.images()) > 0)
	if err != nil {
		return GenerateResult{}, err
	}
	completion.History = s.history
	var reasoning strings.Builder
	if reasoningRule(resolveAPIEndpoint(s.conn), completion.Model, completion.SupportedEfforts).Preserve {
		completion.ReasoningSink = func(part string) { reasoning.WriteString(part) }
	}
	result, err := streamCompletion(ctx, s.conn, completion, req.Input, emit)
	if err != nil {
		return result, err
	}
	s.record(req.Input.Prompt, result.Text)
	s.history[len(s.history)-1].Reasoning = reasoning.String()
	s.size += reasoning.Len()
	s.trim()
	return result, nil
}

func (s *apiTranslationSession) record(prompt, answer string) {
	s.history = append(s.history, completionMessage{Role: "user", Content: prompt}, completionMessage{Role: "assistant", Content: answer})
	s.size += len(prompt) + len(answer)
	s.trim()
}
func (s *apiTranslationSession) trim() {
	if s.size <= apiTranslationHistoryBytes {
		return
	}
	// Keep at least the latest turn, even when it alone exceeds the budget.
	for len(s.history) > 2 && s.size > apiTranslationHistoryBytes/2 {
		s.size -= len(s.history[0].Content.(string)) + len(s.history[1].Content.(string)) + len(s.history[1].Reasoning)
		s.history = s.history[2:]
	}
}

func (s *apiTranslationSession) close() {
	s.history, s.size = nil, 0
}

// apiCatalog binds model discovery to one endpoint snapshot. The cache key
// covers the URL and key, so an edited connection never reuses another list.
func (s *Server) apiCatalog(c APIConnection) func(context.Context) ([]AgentModel, error) {
	sum := sha256.Sum256([]byte(c.URL + "\x00" + c.Key + "\x00" + c.Protocol))
	key := "api:" + hex.EncodeToString(sum[:])
	return func(ctx context.Context) ([]AgentModel, error) {
		return s.cachedCatalog(ctx, key, func(ctx context.Context) ([]AgentModel, error) {
			return discoverAPIModels(ctx, c)
		})
	}
}

// apiAgentModels lists the endpoint's models and the user's added IDs, each
// with its current check result. Text models can be entered without a probe;
// image recommendations require verified vision. Added IDs survive catalog errors.
func (s *Server) nativeAIModels(ctx context.Context, c nativeAIStored) ([]AgentModel, error) {
	listed, err := s.apiCatalog(c.Connection)(ctx)
	models := append([]AgentModel{}, listed...)
	for _, id := range c.Config.APIModels {
		if !slices.ContainsFunc(models, func(m AgentModel) bool { return m.ID == id }) {
			models = append(models, AgentModel{ID: id, Name: id, Custom: true})
		}
	}
	if len(models) == 0 {
		if err == nil {
			err = errors.New("API 未返回可用模型")
		}
		return nil, err
	}
	for i := range models {
		models[i].EffortInfo = reasoningRule(resolveAPIEndpoint(c.Connection), models[i].ID, models[i].SupportedEfforts).info()
		key := apiCapabilityKey(models[i].ID)
		if result, ok := c.Capabilities[key]; ok && result.Fingerprint == nativeConfigPrint(c.Connection, models[i].ID) {
			models[i].Capability = &result
		}
	}
	for _, task := range []modelTask{taskChat, taskTranslation, taskVision, taskResearch} {
		passed := []AgentModel{}
		for _, m := range models {
			if task != taskVision && (m.Capability == nil || m.Capability.Text) || task == taskVision && m.Capability != nil && m.Capability.Text && m.Capability.Vision {
				passed = append(passed, m)
			}
		}
		if len(passed) == 0 {
			continue
		}
		choiceTask := task
		if task == taskResearch {
			choiceTask = taskChat
		}
		id := defaultTaskModel(choiceTask, passed)
		if id == "" {
			id = passed[0].ID
		}
		for i := range models {
			if models[i].ID == id {
				models[i].RecommendedFor = append(models[i].RecommendedFor, string(task))
			}
		}
	}
	return models, nil
}

func discoverAPIModels(ctx context.Context, c APIConnection) (models []AgentModel, err error) {
	ctx, _ = traceAPI(ctx, c, "")
	started := time.Now()
	apiLog(ctx, slog.LevelInfo, "api.start", "operation", "models")
	defer func() { logAPIFinish(ctx, started, err) }()

	if e := validateAgentAPI(c); e != nil {
		return nil, generationError(ErrorConfiguration, e.Error())
	}
	response, err := apiRequest(ctx, c, "GET", "/models", nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, generationError(ErrorNetwork, "API 模型列表读取失败")
	}
	if hasAPIError(body) {
		return nil, providerFailure(ctx, c, response.StatusCode, response.Header, body, "catalog")
	}
	return decodeAPIModels(body)
}

// Only id is standard. DeepSeek context_window and OpenRouter context_length
// are optional metadata, never inferred from a model name.
func decodeAPIModels(body []byte) ([]AgentModel, error) {
	var result struct {
		Data []struct {
			ID              string `json:"id"`
			DisplayName     string `json:"display_name"`
			Name            string `json:"name"`
			ContextWindow   int    `json:"context_window"`
			ContextLength   int    `json:"context_length"`
			MaxOutputTokens int    `json:"max_output_tokens"`
			TopProvider     struct {
				ContextLength   int `json:"context_length"`
				MaxOutputTokens int `json:"max_completion_tokens"`
			} `json:"top_provider"`
			Effort struct {
				Levels  []string `json:"supported_levels"`
				Default string   `json:"default_level"`
			} `json:"effort"`
		} `json:"data"`
	}
	if !utf8.Valid(body) || json.Unmarshal(body, &result) != nil {
		return nil, generationError(ErrorProtocol, "API 模型列表格式无效")
	}
	seen := map[string]bool{}
	models := []AgentModel{}
	for _, m := range result.Data {
		id := strings.TrimSpace(m.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		name := strings.TrimSpace(m.Name)
		if name == "" {
			name = strings.TrimSpace(m.DisplayName)
		}
		if name == "" {
			name = id
		}
		window := validContextWindow(m.ContextWindow)
		if window == 0 {
			window = validContextWindow(m.ContextLength)
		}
		if n := validContextWindow(m.TopProvider.ContextLength); n > 0 && (window == 0 || n < window) {
			window = n
		}
		output := validContextWindow(m.MaxOutputTokens)
		if output == 0 {
			output = validContextWindow(m.TopProvider.MaxOutputTokens)
		}
		models = append(models, AgentModel{ID: id, Name: name, ContextWindow: window, MaxOutputTokens: output, SupportedEfforts: m.Effort.Levels, DefaultEffort: m.Effort.Default})
	}
	if len(models) == 0 {
		return nil, errors.New("API 未返回可用模型")
	}
	return models, nil
}
