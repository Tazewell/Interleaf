package reader

import (
	"context"
	"net/http"
	"time"
)

type AgentModel struct {
	EffortInfo      *APIEffortInfo `json:"effortInfo,omitempty"`
	ContextWindow   int            `json:"contextWindow,omitempty"`
	MaxOutputTokens int            `json:"maxOutputTokens,omitempty"`
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Description     string         `json:"description"`
	Default         bool           `json:"isDefault"`
	Aliases         []string       `json:"aliases,omitempty"`
	RecommendedFor  []string       `json:"recommendedFor,omitempty"`
	// API agent only: an ID the user added, and the model's own check result.
	Custom           bool        `json:"custom,omitempty"`
	Capability       *Capability `json:"capability,omitempty"`
	SupportedEfforts []string    `json:"-"`
	DefaultEffort    string      `json:"-"`
}

func (s *Server) agentModels(w http.ResponseWriter, r *http.Request) {
	ctxIO, finishIO, ioErr := s.beginAIIO(r.Context())
	if ioErr != nil {
		fail(w, 503, ioErr.Error())
		return
	}
	defer finishIO()
	r = r.WithContext(ctxIO)

	role := modelTask(r.URL.Query().Get("role"))
	if r.URL.Query().Has("provider") || !validNativeRole(role) {
		fail(w, 400, "请选择有效的模型用途")
		return
	}
	config, err := s.nativeAIConfig()
	if err != nil {
		fail(w, 500, "无法读取 AI 配置")
		return
	}
	if config.NeedsConfiguration != "" {
		fail(w, 409, "请先确认 AI 连接配置")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	s.configMu.Lock()
	stored, readErr := s.readNativeAIConfig()
	s.configMu.Unlock()
	if readErr != nil {
		fail(w, 500, "无法读取 AI 配置")
		return
	}
	models, err := s.nativeAIModels(ctx, stored)
	if err != nil {
		fail(w, 502, "无法获取 API 模型列表："+safeNativeError(err, stored.Connection.Key))
		return
	}
	respond(w, 200, models)
}
