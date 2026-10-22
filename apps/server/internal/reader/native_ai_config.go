package reader

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

type NativeAIConnection struct {
	Protocol string `json:"protocol"`
	URL      string `json:"url"`
	HasKey   bool   `json:"hasKey"`
}
type NativeAIConfig struct {
	Version            int                  `json:"version"`
	Connection         NativeAIConnection   `json:"connection"`
	Models             map[modelTask]string `json:"models"`
	Efforts            map[modelTask]string `json:"efforts"`
	APIModels          []string             `json:"apiModels"`
	TranslationPrompt  *string              `json:"translationPrompt,omitempty"`
	NeedsConfiguration string               `json:"needsConfiguration,omitempty"`
}
type NativeAIConnectionUpdate struct {
	Protocol string `json:"protocol"`
	URL      string `json:"url"`
	// nil means omitted; JSON null explicitly clears the saved key.
	Key json.RawMessage `json:"key,omitempty"`
}
type NativeAIConfigUpdate struct {
	Version           int                      `json:"version"`
	Connection        NativeAIConnectionUpdate `json:"connection"`
	Models            map[modelTask]string     `json:"models"`
	Efforts           map[modelTask]string     `json:"efforts"`
	APIModels         []string                 `json:"apiModels"`
	TranslationPrompt *string                  `json:"translationPrompt,omitempty"`
}
type nativeTaskSnapshot struct {
	Connection                     APIConnection
	Model, Effort, Fingerprint     string
	ContextWindow, MaxOutputTokens int
	Text, Vision, Tools            bool
}

func validNativeRole(role modelTask) bool {
	return role == taskChat || role == taskTranslation || role == taskVision || role == taskResearch
}
func normalizeNativeURL(raw string) string {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.Scheme = strings.ToLower(u.Scheme)
	host, port := strings.ToLower(u.Hostname()), u.Port()
	if u.Scheme == "https" && port == "443" || u.Scheme == "http" && port == "80" {
		port = ""
	}
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	return u.String()
}
func normalizedNativeConnection(protocol, raw string) (string, string, error) {
	protocol = strings.TrimSpace(protocol)
	if protocol != "openai" && protocol != "anthropic" {
		return "", "", errors.New("请选择 OpenAI 或 Anthropic 协议")
	}
	raw = normalizeNativeURL(raw)
	if raw != "" {
		if err := validateAPIURL(raw); err != nil {
			return "", "", err
		}
	}
	return protocol, raw, nil
}
func (s *Server) nativeAIConfig() (NativeAIConfig, error) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	stored, err := s.readNativeAIConfig()
	return stored.Config, err
}
func (s *Server) saveNativeAIConfig(update NativeAIConfigUpdate) (NativeAIConfig, error) {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	if update.Version != 2 {
		return NativeAIConfig{}, errors.New("无效的 AI 配置版本")
	}
	protocol, url, err := normalizedNativeConnection(update.Connection.Protocol, update.Connection.URL)
	if err != nil {
		return NativeAIConfig{}, err
	}
	old, err := s.readNativeAIConfig()
	if err != nil {
		return NativeAIConfig{}, err
	}
	next := old
	next.Config.Connection = NativeAIConnection{Protocol: protocol, URL: url}
	next.Connection = APIConnection{Protocol: protocol, URL: url}
	same := old.Connection.Protocol == protocol && old.Connection.URL == url
	if len(update.Connection.Key) == 0 {
		if same {
			next.Connection.Key = old.Connection.Key
		}
	} else if string(update.Connection.Key) != "null" {
		if err := json.Unmarshal(update.Connection.Key, &next.Connection.Key); err != nil {
			return NativeAIConfig{}, errors.New("API Key 必须为字符串或 null")
		}
		next.Connection.Key = strings.TrimSpace(next.Connection.Key)
	}
	next.Config.Connection.HasKey = next.Connection.Key != ""
	next.Config.NeedsConfiguration = ""
	if url == "" {
		next.Config.NeedsConfiguration = "请填写 API 地址和问答模型"
	} else if !same && len(update.Connection.Key) == 0 {
		next.Config.NeedsConfiguration = "API 地址已改变，请填写 Key 或明确清空以确认无需密钥"
	}
	if update.Models != nil {
		next.Config.Models = update.Models
	}
	if update.Efforts != nil {
		next.Config.Efforts = update.Efforts
	}
	for role, model := range next.Config.Models {
		if !validNativeRole(role) || len(model) > 200 {
			return NativeAIConfig{}, errors.New("无效的用途或模型名称")
		}
		next.Config.Models[role] = strings.TrimSpace(model)
	}
	for role, effort := range next.Config.Efforts {
		if !validNativeRole(role) || !validEffort("api", effort) {
			return NativeAIConfig{}, errors.New("无效的用途或 Effort 档位")
		}
	}
	if update.APIModels != nil {
		next.Config.APIModels = []string{}
		for _, id := range update.APIModels {
			id = strings.TrimSpace(id)
			if id != "" && !slices.Contains(next.Config.APIModels, id) {
				next.Config.APIModels = append(next.Config.APIModels, id)
			}
		}
	}
	if len(next.Config.APIModels) > 50 || slices.ContainsFunc(next.Config.APIModels, func(id string) bool { return len(id) > 200 }) {
		return NativeAIConfig{}, errors.New("手动添加的模型过多或名称过长")
	}
	if update.TranslationPrompt != nil {
		value := strings.TrimSpace(*update.TranslationPrompt)
		if utf8.RuneCountInString(value) > 6000 {
			return NativeAIConfig{}, errors.New("翻译提示词不能超过 6000 个字符")
		}
		next.Config.TranslationPrompt = &value
	}
	// Probe results are valid only for this exact endpoint, key and model.
	bridge := nativeLegacyView(next)
	for key, cap := range next.Capabilities {
		if cap.Fingerprint != configPrint(bridge, key) {
			delete(next.Capabilities, key)
		}
	}
	if err := s.writeNativeAIConfig(next); err != nil {
		return NativeAIConfig{}, err
	}
	return next.Config, nil
}
func nativeLegacyView(stored nativeAIStored) AIConfig {
	c := AIConfig{Primary: "api", API: stored.Connection, Models: map[string]string{"api": stored.Config.Models[taskChat]}, TranslationModels: map[string]string{"api": stored.Config.Models[taskTranslation]}, VisionModels: map[string]string{"api": stored.Config.Models[taskVision]}, Efforts: map[string]map[string]string{}, TranslationEfforts: map[string]map[string]string{}, VisionEfforts: map[string]map[string]string{}, APIModels: stored.Config.APIModels, TranslationPrompt: stored.Config.TranslationPrompt, Capabilities: stored.Capabilities}
	for role, field := range map[modelTask]map[string]map[string]string{taskChat: c.Efforts, taskTranslation: c.TranslationEfforts, taskVision: c.VisionEfforts} {
		field["api"] = map[string]string{stored.Config.Models[role]: stored.Config.Efforts[role]}
	}
	if stored.Config.NeedsConfiguration != "" {
		c.Primary = ""
		c.API = APIConnection{}
		c.Capabilities = map[string]Capability{}
	}
	if c.Capabilities == nil {
		c.Capabilities = map[string]Capability{}
	}
	return c
}
func (s *Server) resolveNativeTask(ctx context.Context, config NativeAIConfig, role modelTask) (nativeTaskSnapshot, error) {
	if !validNativeRole(role) {
		return nativeTaskSnapshot{}, errors.New("无效的模型用途")
	}
	s.configMu.Lock()
	stored, err := s.readNativeAIConfig()
	s.configMu.Unlock()
	if err != nil {
		return nativeTaskSnapshot{}, err
	}
	if config.NeedsConfiguration != "" || stored.Config.NeedsConfiguration != "" {
		return nativeTaskSnapshot{}, generationError(ErrorConfiguration, "请先确认 AI 连接配置")
	}
	a, _ := json.Marshal(config)
	b, _ := json.Marshal(stored.Config)
	if string(a) != string(b) {
		return nativeTaskSnapshot{}, generationError(ErrorConfiguration, "AI 配置已改变，请重试")
	}
	models, catalogErr := s.apiAgentModels(ctx, nativeLegacyView(stored))
	// The catalog has already excluded failed models from role recommendations.
	// Do not rerun family ranking over its unfiltered entries.
	recommended := func(role modelTask) string {
		for _, model := range models {
			if slices.Contains(model.RecommendedFor, string(role)) {
				return model.ID
			}
		}
		return ""
	}
	chat := config.Models[taskChat]
	if chat == "" && catalogErr == nil {
		chat = recommended(taskChat)
	}
	if chat == "" {
		return nativeTaskSnapshot{}, generationError(ErrorConfiguration, "请填写问答模型")
	}
	model := config.Models[role]
	if model == "" {
		switch role {
		case taskTranslation:
			if catalogErr == nil {
				model = recommended(taskTranslation)
			}
			if model == "" {
				model = chat
			}
		case taskVision:
			if capable(nativeLegacyView(stored), apiCapabilityKey(chat), true) {
				model = chat
			}
		default:
			model = chat
		}
	}
	if model == "" {
		return nativeTaskSnapshot{}, generationError(ErrorCapability, "图片模型未配置或未通过检测，当前为纯文字模式")
	}
	effort := config.Efforts[role]
	if effort == "" && role == taskResearch && config.Models[role] == "" {
		effort = config.Efforts[taskChat]
	}
	if effort == "" {
		effort = "medium"
	}
	snapshot := nativeTaskSnapshot{Connection: stored.Connection, Model: model, Effort: effort, Text: true}
	bridge := nativeLegacyView(stored)
	cap := bridge.Capabilities[apiCapabilityKey(model)]
	if cap.Fingerprint == configPrint(bridge, apiCapabilityKey(model)) {
		snapshot.Vision = cap.Text && cap.Vision
		snapshot.Tools = cap.Tools == "passed" && cap.ToolSchemaVersion == documentToolSchemaVersion
	}
	for _, m := range models {
		if m.ID == model {
			snapshot.ContextWindow = m.ContextWindow
			snapshot.MaxOutputTokens = m.MaxOutputTokens
		}
	}
	data, _ := json.Marshal([]any{stored.Connection, model, effort, snapshot.Vision, snapshot.Tools})
	sum := sha256.Sum256(data)
	snapshot.Fingerprint = hex.EncodeToString(sum[:])
	return snapshot, nil
}
func (s *Server) checkNativeAI(w http.ResponseWriter, r *http.Request) {
	ctxIO, finishIO, ioErr := s.beginAIIO(r.Context())
	if ioErr != nil {
		fail(w, 503, ioErr.Error())
		return
	}
	defer finishIO()
	r = r.WithContext(ctxIO)

	var input struct {
		Role        modelTask `json:"role"`
		Model       string    `json:"model"`
		WaitSeconds *int      `json:"waitSeconds"`
	}
	if !decode(w, r, &input) {
		return
	}
	wait := 15
	if input.WaitSeconds != nil {
		wait = *input.WaitSeconds
	}
	if !validNativeRole(input.Role) || wait < 1 || wait > 60 {
		fail(w, 400, "请选择用途，检测等待须为 1–60 秒")
		return
	}
	s.configMu.Lock()
	stored, err := s.readNativeAIConfig()
	s.configMu.Unlock()
	if err != nil {
		fail(w, 500, "无法读取 AI 配置")
		return
	}
	config := stored.Config
	// Resolve against a request-local model override, without saving it.
	model := strings.TrimSpace(input.Model)
	if model == "" {
		snapshot, err := s.resolveNativeTask(r.Context(), config, input.Role)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		model = snapshot.Model
	}
	if len(model) > 200 || model == "" || config.NeedsConfiguration != "" {
		fail(w, 400, "请先保存连接并填写模型")
		return
	}
	c := nativeLegacyView(stored)
	fingerprint := configPrint(c, apiCapabilityKey(model))
	level := config.Efforts[input.Role]
	if level == "" && input.Role == taskResearch && config.Models[taskResearch] == "" {
		level = config.Efforts[taskChat]
	}
	if level == "" {
		level = "medium"
	}
	c.Models["api"] = model
	c.Efforts["api"] = map[string]string{model: level}
	c.VisionModels["api"] = model
	c.VisionEfforts["api"] = map[string]string{model: level}
	cap := Capability{CheckedAt: now(), Fingerprint: fingerprint}
	answer, first, err := s.probeConnection(r.Context(), c, apiCapabilityKey(model), AIInput{Prompt: "Reply with exactly READER_OK. Do not use any tools."}, time.Duration(wait)*time.Second)
	cap.TextFirstOutputMs = first
	if err != nil {
		cap.Error = safeNativeError(err, c.API.Key)
	} else {
		cap.Text = strings.TrimSpace(answer) != ""
		if !cap.Text {
			cap.Error = "测试未返回文字"
		}
	}
	if cap.Text {
		if previous := c.Capabilities[apiCapabilityKey(model)]; previous.Fingerprint == fingerprint {
			cap.Vision = previous.Vision
			cap.VisionFirstOutputMs = previous.VisionFirstOutputMs
			cap.Tools = previous.Tools
			cap.ToolSchemaVersion = previous.ToolSchemaVersion
			cap.ToolError = previous.ToolError
		}
	}
	if cap.Text && (input.Role == taskChat || input.Role == taskResearch) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(wait)*time.Second)
		status, toolErr := probeAPIDocumentTools(ctx, c.API, model)
		cancel()
		cap.Tools = status
		cap.ToolSchemaVersion = documentToolSchemaVersion
		cap.ToolError = ""
		if toolErr != nil {
			cap.ToolError = safeNativeError(toolErr, c.API.Key)
		}
	}
	if cap.Text && input.Role == taskVision {
		image, expected, probeErr := visionProbe()
		if probeErr == nil {
			answer, first, probeErr = s.probeConnection(r.Context(), c, apiCapabilityKey(model), AIInput{Prompt: visionPrompt, Image: image}, time.Duration(wait)*time.Second)
		}
		cap.VisionFirstOutputMs = first
		cap.Vision = probeErr == nil && matchesVisionProbe(answer, expected)
		if probeErr != nil {
			cap.Error = safeNativeError(probeErr, c.API.Key)
		}
	}
	if r.Context().Err() != nil {
		return
	}
	s.configMu.Lock()
	latest, readErr := s.readNativeAIConfig()
	if readErr != nil {
		s.configMu.Unlock()
		fail(w, 500, "无法读取 AI 配置")
		return
	}
	if configPrint(nativeLegacyView(latest), apiCapabilityKey(model)) != fingerprint {
		s.configMu.Unlock()
		fail(w, 409, "连接已改变，请重新检测")
		return
	}
	latest.Capabilities[apiCapabilityKey(model)] = cap
	err = s.writeNativeAIConfig(latest)
	s.configMu.Unlock()
	if err != nil {
		fail(w, 500, "无法保存检测结果")
		return
	}
	respond(w, 200, struct {
		Capability
		Model       string `json:"model"`
		Fingerprint string `json:"fingerprint"`
	}{cap, model, fingerprint})
}
func safeNativeError(err error, key string) string {
	message := err.Error()
	if key != "" {
		message = strings.ReplaceAll(message, key, "[redacted]")
	}
	return message
}
