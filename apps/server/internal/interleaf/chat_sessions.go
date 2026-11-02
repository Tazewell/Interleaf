package interleaf

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type ChatSession struct {
	ID         string   `json:"id"`
	DocumentID string   `json:"documentId"`
	Title      string   `json:"title"`
	Provider   string   `json:"provider"`
	CreatedAt  string   `json:"createdAt"`
	UpdatedAt  string   `json:"updatedAt"`
	LatestRun  *ChatRun `json:"latestRun,omitempty"`
}

type ChatSessionDeletion struct {
	OK                    bool         `json:"ok"`
	UnlinkedAnnotationIDs []string     `json:"unlinkedAnnotationIds"`
	Replacement           *ChatSession `json:"replacement,omitempty"`
}

// Migrate in a single transaction. IDs, evidence, reading positions and annotation
// links stay intact; the old provider continuation moves with the transcript.
func (s *Store) ensureDefaultChatSession(documentID, provider string) (string, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var sessionID string
	err = tx.QueryRow("SELECT id FROM chat_sessions WHERE document_id=? ORDER BY rowid LIMIT 1", documentID).Scan(&sessionID)
	if err == nil {
		return sessionID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	sessionID = id()
	stamp := now()
	if _, err = tx.Exec("INSERT INTO chat_sessions(id,document_id,title,provider,created_at,updated_at) VALUES(?,?,?,?,?,?)", sessionID, documentID, "默认会话", provider, stamp, stamp); err != nil {
		return "", err
	}
	if _, err = tx.Exec("UPDATE messages SET body=json_set(body,'$.sessionId',?) WHERE document_id=? AND COALESCE(json_extract(body,'$.sessionId'),'')=''", sessionID, documentID); err != nil {
		return "", err
	}
	if _, err = tx.Exec("UPDATE document_conversations SET provider='session:' || ? || ':' || provider WHERE document_id=? AND provider NOT LIKE 'session:%'", sessionID, documentID); err != nil {
		return "", err
	}
	return sessionID, tx.Commit()
}
func (s *Store) chatSession(documentID, sessionID string) (ChatSession, error) {
	var session ChatSession
	err := s.DB.QueryRow("SELECT id,document_id,title,provider,created_at,updated_at FROM chat_sessions WHERE id=? AND document_id=?", sessionID, documentID).Scan(&session.ID, &session.DocumentID, &session.Title, &session.Provider, &session.CreatedAt, &session.UpdatedAt)
	return session, err
}

// Avoid taking the legacy generation lock for ordinary session polling.
func (s *Server) ensureChatSession(documentID, provider string) (string, error) {
	var existing string
	err := s.Store.DB.QueryRow("SELECT id FROM chat_sessions WHERE document_id=? ORDER BY rowid LIMIT 1", documentID).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	s.aiMu.Lock()
	defer s.aiMu.Unlock()
	session, err := s.Store.ensureDefaultChatSession(documentID, provider)
	if err == nil {
	}
	return session, err
}
func (s *Server) listChatSessions(w http.ResponseWriter, r *http.Request) {
	doc, err := s.Store.Document(r.PathValue("id"))
	if err != nil || doc.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	provider := "api"
	if !validAgent(provider) {
		provider = "api"
	}
	_, err = s.ensureChatSession(doc.ID, provider)
	if err != nil {
		fail(w, 500, "无法迁移会话历史")
		return
	}
	rows, err := s.Store.DB.Query("SELECT id,document_id,title,provider,created_at,updated_at FROM chat_sessions WHERE document_id=? ORDER BY rowid", doc.ID)
	if err != nil {
		fail(w, 500, "无法读取会话")
		return
	}
	sessions := []ChatSession{}
	for rows.Next() {
		var v ChatSession
		if err = rows.Scan(&v.ID, &v.DocumentID, &v.Title, &v.Provider, &v.CreatedAt, &v.UpdatedAt); err != nil {
			break
		}
		sessions = append(sessions, v)
	}
	rowErr := rows.Err()
	rows.Close()
	if err != nil || rowErr != nil {
		fail(w, 500, "无法读取会话")
		return
	}
	for i := range sessions {
		run, err := s.Store.latestChatRun(sessions[i].ID)
		if err == nil {
			sessions[i].LatestRun = &run
		} else if !errors.Is(err, sql.ErrNoRows) {
			fail(w, 500, "无法读取运行状态")
			return
		}
	}
	respond(w, 200, sessions)
}
func (s *Server) createChatSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title    string `json:"title"`
		Provider string `json:"provider"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Title == "" {
		req.Title = "新会话"
	}
	title, err := metadataText(json.RawMessage(jsonText(req.Title)), 80, false)
	if err != nil || !validAgent(req.Provider) {
		fail(w, 400, "会话名称或后端无效")
		return
	}
	doc, err := s.Store.Document(r.PathValue("id"))
	if err != nil || doc.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	ctx, finish, err := s.beginDocumentTask(r.Context(), doc.ID)
	if err != nil {
		fail(w, 409, "文档不可用")
		return
	}
	defer finish()
	_, err = s.ensureChatSession(doc.ID, req.Provider)
	if err != nil {
		fail(w, 500, "无法迁移会话历史")
		return
	}
	v := ChatSession{ID: id(), DocumentID: doc.ID, Title: title, Provider: req.Provider, CreatedAt: now(), UpdatedAt: now()}
	_, err = s.Store.DB.ExecContext(ctx, "INSERT INTO chat_sessions(id,document_id,title,provider,created_at,updated_at) VALUES(?,?,?,?,?,?)", v.ID, v.DocumentID, v.Title, v.Provider, v.CreatedAt, v.UpdatedAt)
	if err != nil {
		fail(w, 500, "无法创建会话")
		return
	}
	respond(w, 201, v)
}
func (s *Server) updateChatSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title    *string `json:"title"`
		Provider *string `json:"provider"`
	}
	if !decode(w, r, &req) {
		return
	}
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	v, err := s.Store.chatSession(r.PathValue("id"), r.PathValue("session"))
	if err != nil {
		fail(w, 404, "会话不存在")
		return
	}
	if req.Title != nil {
		title, e := metadataText(json.RawMessage(jsonText(*req.Title)), 80, false)
		if e != nil {
			fail(w, 400, "会话名称无效")
			return
		}
		v.Title = title
	}
	if req.Provider != nil {
		if !validAgent(*req.Provider) {
			fail(w, 400, "后端无效")
			return
		}
		if s.chatRuns[v.ID] != nil || s.chatReservations[v.ID] {
			fail(w, 409, "请等待当前会话运行结束后切换后端")
			return
		}
		v.Provider = *req.Provider
	}
	v.UpdatedAt = now()
	if _, err = s.Store.DB.Exec("UPDATE chat_sessions SET title=?,provider=?,updated_at=? WHERE id=?", v.Title, v.Provider, v.UpdatedAt, v.ID); err != nil {
		fail(w, 500, "无法保存会话")
		return
	}
	respond(w, 200, v)
}
func (s *Server) deleteChatSession(w http.ResponseWriter, r *http.Request) {
	documentID, sessionID := r.PathValue("id"), r.PathValue("session")
	doc, err := s.Store.Document(documentID)
	if err != nil || doc.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	ctx, finish, err := s.beginDocumentTask(r.Context(), documentID)
	if err != nil {
		fail(w, 409, "文档不可用")
		return
	}
	defer finish()
	// Hold the generation lock through commit: a checked session cannot accept
	// another run between the activity check and transcript cleanup.
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	session, err := s.Store.chatSession(documentID, sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "会话不存在")
		return
	}
	if err != nil {
		fail(w, 500, "无法读取会话")
		return
	}
	if s.chatRuns[sessionID] != nil || s.chatReservations[sessionID] {
		fail(w, 409, "请先停止当前会话的回答生成，再删除会话")
		return
	}
	// Undo snapshots must change with the stored annotations, including marks
	// currently deleted but still restorable from history.
	s.annotationMu.Lock()
	defer s.annotationMu.Unlock()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		fail(w, 500, "无法删除会话")
		return
	}
	defer tx.Rollback()
	var running int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM chat_runs WHERE session_id=? AND json_extract(body,'$.status')='running'", sessionID).Scan(&running); err != nil {
		fail(w, 500, "无法读取运行状态")
		return
	}
	if running != 0 {
		fail(w, 409, "请先停止当前会话的回答生成，再删除会话")
		return
	}
	result, removed, err := deleteChatSessionTx(ctx, tx, session)
	if err != nil {
		fail(w, 500, "无法删除会话")
		return
	}
	history, err := s.annotationHistoryWithoutAnswers(documentID, removed)
	if err != nil {
		fail(w, 500, "无法更新批注撤销记录")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "无法删除会话")
		return
	}
	s.annotationHistory = history
	respond(w, 200, result)
}

func deleteChatSessionTx(ctx context.Context, tx *sql.Tx, session ChatSession) (ChatSessionDeletion, map[string]bool, error) {
	result := ChatSessionDeletion{OK: true, UnlinkedAnnotationIDs: []string{}}
	removed := map[string]bool{}
	rows, err := tx.QueryContext(ctx, "SELECT id FROM messages WHERE document_id=? AND json_extract(body,'$.sessionId')=?", session.DocumentID, session.ID)
	if err != nil {
		return result, nil, err
	}
	for rows.Next() {
		var messageID string
		if err = rows.Scan(&messageID); err != nil {
			break
		}
		removed[messageID] = true
	}
	rowErr := rows.Err()
	rows.Close()
	if err != nil || rowErr != nil {
		return result, nil, errors.Join(err, rowErr)
	}
	const targetMessages = "SELECT id FROM messages WHERE document_id=? AND json_extract(body,'$.sessionId')=?"
	rows, err = tx.QueryContext(ctx, "SELECT id FROM annotations WHERE document_id=? AND json_extract(body,'$.answerId') IN ("+targetMessages+") ORDER BY id", session.DocumentID, session.DocumentID, session.ID)
	if err != nil {
		return result, nil, err
	}
	for rows.Next() {
		var annotationID string
		if err = rows.Scan(&annotationID); err != nil {
			break
		}
		result.UnlinkedAnnotationIDs = append(result.UnlinkedAnnotationIDs, annotationID)
	}
	rowErr = rows.Err()
	rows.Close()
	if err != nil || rowErr != nil {
		return result, nil, errors.Join(err, rowErr)
	}
	for _, query := range []string{
		"UPDATE annotations SET body=json_remove(body,'$.answerId') WHERE document_id=? AND json_extract(body,'$.answerId') IN (" + targetMessages + ")",
		"DELETE FROM chat_agent_runs WHERE document_id=? AND json_extract(body,'$.messageId') IN (" + targetMessages + ")",
	} {
		if _, err = tx.ExecContext(ctx, query, session.DocumentID, session.DocumentID, session.ID); err != nil {
			return result, nil, err
		}
	}
	// Match the complete session prefix literally; LIKE would interpret '_' and
	// '%' inside historical session IDs as wildcards.
	prefix := conversationProvider(session.ID, "")
	if _, err = tx.ExecContext(ctx, "DELETE FROM document_conversations WHERE document_id=? AND substr(provider,1,length(?))=?", session.DocumentID, prefix, prefix); err != nil {
		return result, nil, err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM messages WHERE document_id=? AND json_extract(body,'$.sessionId')=?", session.DocumentID, session.ID); err != nil {
		return result, nil, err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM chat_runs WHERE session_id=?", session.ID); err != nil {
		return result, nil, err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM chat_sessions WHERE id=? AND document_id=?", session.ID, session.DocumentID); err != nil {
		return result, nil, err
	}
	var remaining int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM chat_sessions WHERE document_id=?", session.DocumentID).Scan(&remaining); err != nil {
		return result, nil, err
	}
	if remaining == 0 {
		stamp := now()
		replacement := ChatSession{ID: id(), DocumentID: session.DocumentID, Title: "默认会话", Provider: session.Provider, CreatedAt: stamp, UpdatedAt: stamp}
		if _, err = tx.ExecContext(ctx, "INSERT INTO chat_sessions(id,document_id,title,provider,created_at,updated_at) VALUES(?,?,?,?,?,?)", replacement.ID, replacement.DocumentID, replacement.Title, replacement.Provider, replacement.CreatedAt, replacement.UpdatedAt); err != nil {
			return result, nil, err
		}
		result.Replacement = &replacement
	}
	return result, removed, nil
}

func (s *Server) sessionMessages(w http.ResponseWriter, r *http.Request) {
	v, err := s.Store.chatSession(r.PathValue("id"), r.PathValue("session"))
	if err != nil {
		fail(w, 404, "会话不存在")
		return
	}
	messages, err := s.Store.chatHistory(v.DocumentID, v.ID)
	if err != nil {
		fail(w, 500, "无法读取对话")
		return
	}
	if messages == nil {
		messages = []Message{}
	}
	respond(w, 200, messages)
}
func conversationProvider(session, provider string) string {
	if session == "" {
		return provider
	}
	return "session:" + session + ":" + provider
}
func (a *documentAgent) conversationProvider() string {
	return conversationProvider(a.sessionID, a.provider)
}
func sessionTitle(question string) string {
	runes := []rune(strings.Join(strings.Fields(question), " "))
	if len(runes) > 32 {
		return string(runes[:32]) + "…"
	}
	return string(runes)
}

func (s *Store) saveChatAnswer(ctx context.Context, chat *chatInput, text, reasoning string) error {
	message := Message{ID: id(), CreatedAt: now(), DocumentID: chat.DocumentID, SessionID: chat.SessionID, Role: "assistant", Content: text, Reasoning: reasoning}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "INSERT INTO messages VALUES(?,?,?,?)", message.ID, message.DocumentID, jsonText(message), message.CreatedAt); err != nil {
		return err
	}
	if chat.nativeConversation != nil {
		chat.nativeConversation.LastMessageID = message.ID
		if err = saveDocumentConversation(ctx, tx, chat.DocumentID, conversationProvider(chat.SessionID, chat.nativeProvider), *chat.nativeConversation); err != nil {
			return err
		}
	}

	return tx.Commit()
}
