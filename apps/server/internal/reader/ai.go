package reader

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

type Provider struct {
	ID            string `json:"id"`
	Installed     bool   `json:"installed"`
	Authenticated bool   `json:"authenticated"`
	Status        string `json:"status"`
}

func (s *Server) providers(w http.ResponseWriter, r *http.Request) {
	config, err := s.nativeAIConfig()
	if err != nil {
		fail(w, 500, "无法读取 AI 配置")
		return
	}
	respond(w, 200, []Provider{{ID: "api", Installed: config.Connection.URL != "", Authenticated: config.Connection.HasKey, Status: "API"}})
}

var chatMessageIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserMessageID   string          `json:"userMessageId"`
		Provider        string          `json:"provider"`
		Prompt          string          `json:"prompt"`
		Context         *string         `json:"context"`
		ReadingLocation json.RawMessage `json:"readingLocation"`
		References      json.RawMessage `json:"references"`
		Attachments     []string        `json:"attachments"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Context == nil {
		fail(w, 400, "缺少 context 字段")
		return
	}
	if !validAgent(req.Provider) {
		fail(w, 400, "未知 AI 服务")
		return
	}
	if req.UserMessageID != "" && !chatMessageIDPattern.MatchString(req.UserMessageID) {
		fail(w, 400, "问题消息编号无效")
		return
	}
	// Bound explicit source attachments independently of the model context window.
	if strings.TrimSpace(req.Prompt) == "" || len(req.Prompt) > 16000 || len(*req.Context) > chatContextBytes {
		fail(w, 400, "问题或上下文长度无效")
		return
	}
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	if len(req.ReadingLocation) > 0 && (len(req.ReadingLocation) > 16384 || !validLocation(req.ReadingLocation, d.Type)) {
		fail(w, 400, "阅读位置无效")
		return
	}
	ctx, finish, err := s.beginDocumentTask(r.Context(), d.ID)
	if err != nil {
		fail(w, 409, "文档正在删除")
		return
	}
	defer finish()
	r = r.WithContext(ctx)
	if r.PathValue("session") == "" {
		var defaultID string
		if s.Store.DB.QueryRow("SELECT id FROM chat_sessions WHERE document_id=? ORDER BY rowid LIMIT 1", d.ID).Scan(&defaultID) == nil {
			r.SetPathValue("session", defaultID)
			r.SetPathValue("legacy", "true")
		}
	}
	s.chatDocument(w, r, d, req.Provider, req.Prompt, *req.Context, req.References, req.Attachments, req.ReadingLocation, req.UserMessageID)
}
