package interleaf

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func deletionFixture(t *testing.T) (*Server, Document, ChatSession) {
	t.Helper()
	s := testServer(t)
	d := organizationDoc(t, s)
	w := request(t, s, "GET", "/api/documents/"+d.ID+"/chat-sessions", nil)
	var sessions []ChatSession
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &sessions) != nil || len(sessions) != 1 {
		t.Fatalf("session fixture: %d %s", w.Code, w.Body.String())
	}
	return s, d, sessions[0]
}

func deletionCount(t *testing.T, s *Server, query string, args ...any) int {
	t.Helper()
	var count int
	if err := s.Store.DB.QueryRow(query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func deletionQuestion(t *testing.T, s *Server, documentID, answerID string) Annotation {
	t.Helper()
	w := request(t, s, "POST", "/api/documents/"+documentID+"/annotations", strings.NewReader(`{"kind":"question","location":{"type":"pdf","page":1},"quote":"source text","note":"Keep my question","color":"#e6b94c"}`))
	var annotation Annotation
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &annotation) != nil {
		t.Fatalf("question fixture: %d %s", w.Code, w.Body.String())
	}
	w = request(t, s, "PATCH", "/api/documents/"+documentID+"/annotations/"+annotation.ID, strings.NewReader(jsonText(map[string]string{"answerId": answerID})))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &annotation) != nil {
		t.Fatalf("answer link fixture: %d %s", w.Code, w.Body.String())
	}
	return annotation
}

func TestChatSessionDeletionIsScopedAndUnlinksOnlyItsAnswers(t *testing.T) {
	s, doc, target := deletionFixture(t)
	w := request(t, s, "POST", "/api/documents/"+doc.ID+"/chat-sessions", strings.NewReader(`{"provider":"api"}`))
	var other ChatSession
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &other) != nil {
		t.Fatal(w.Body.String())
	}
	for _, message := range []Message{
		{ID: "deleted-question", DocumentID: doc.ID, SessionID: target.ID, Role: "user", Content: "Question"},
		{ID: "deleted-answer", DocumentID: doc.ID, SessionID: target.ID, Role: "assistant", Content: "Answer"},
		{ID: "retained-answer", DocumentID: doc.ID, SessionID: other.ID, Role: "assistant", Content: "Other answer"},
	} {
		if err := s.Store.saveMessage(message); err != nil {
			t.Fatal(err)
		}
	}
	question := deletionQuestion(t, s, doc.ID, "deleted-answer")
	retained := deletionQuestion(t, s, doc.ID, "retained-answer")
	for _, session := range []ChatSession{target, other} {
		if err := saveDocumentConversation(t.Context(), s.Store.DB, doc.ID, conversationProvider(session.ID, "api"), documentConversation{ID: session.ID, LastMessageID: session.ID}); err != nil {
			t.Fatal(err)
		}
	}
	for _, answer := range []string{"deleted-answer", "retained-answer"} {
		if _, err := s.Store.DB.Exec("INSERT INTO chat_agent_runs VALUES(?,?,?)", answer, doc.ID, jsonText(map[string]string{"messageId": answer})); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Store.DB.Exec("INSERT INTO chat_runs VALUES(?,?,?)", "completed-run", target.ID, jsonText(ChatRun{ID: "completed-run", SessionID: target.ID, DocumentID: doc.ID, Status: "completed"})); err != nil {
		t.Fatal(err)
	}
	w = request(t, s, "DELETE", "/api/documents/"+doc.ID+"/chat-sessions/"+target.ID, nil)
	if w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	var result struct {
		OK          bool         `json:"ok"`
		Unlinked    []string     `json:"unlinkedAnnotationIds"`
		Replacement *ChatSession `json:"replacement"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || !result.OK || len(result.Unlinked) != 1 || result.Unlinked[0] != question.ID || result.Replacement != nil {
		t.Fatalf("delete result: %+v %v", result, err)
	}
	if _, err := s.Store.chatSession(doc.ID, target.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("deleted session remains", err)
	}
	if messages, err := s.Store.chatHistory(doc.ID, other.ID); err != nil || len(messages) != 1 || messages[0].ID != "retained-answer" {
		t.Fatal("other transcript changed", messages, err)
	}
	for query, expected := range map[string]int{
		"SELECT count(*) FROM messages":               1,
		"SELECT count(*) FROM chat_runs":              0,
		"SELECT count(*) FROM chat_agent_runs":        1,
		"SELECT count(*) FROM document_conversations": 1,
		"SELECT count(*) FROM chat_sessions":          1,
		"SELECT count(*) FROM documents":              1,
		"SELECT count(*) FROM annotations":            2,
	} {
		if got := deletionCount(t, s, query); got != expected {
			t.Fatalf("%s: got %d want %d", query, got, expected)
		}
	}
	w = request(t, s, "GET", "/api/documents/"+doc.ID+"/annotations", nil)
	var annotations []Annotation
	if err := json.Unmarshal(w.Body.Bytes(), &annotations); err != nil {
		t.Fatal(err)
	}
	for _, annotation := range annotations {
		if annotation.Note != "Keep my question" || annotation.Quote != "source text" {
			t.Fatal("annotation text changed", annotation)
		}
		if annotation.ID == question.ID && annotation.AnswerID != "" {
			t.Fatal("dangling answer link", annotation)
		}
		if annotation.ID == retained.ID && annotation.AnswerID != "retained-answer" {
			t.Fatal("other answer link changed", annotation)
		}
	}
	if docAfter, err := s.Store.Document(doc.ID); err != nil || docAfter.OpenQuestionCount != 1 {
		t.Fatal("unlinked question was not reopened", docAfter.OpenQuestionCount, err)
	}
}

func TestChatSessionDeletionReplacesTheLastSessionWithAnEmptyDefault(t *testing.T) {
	s, doc, target := deletionFixture(t)
	if err := s.Store.saveMessage(Message{ID: "last-answer", DocumentID: doc.ID, SessionID: target.ID, Role: "assistant", Content: "Old history"}); err != nil {
		t.Fatal(err)
	}
	w := request(t, s, "DELETE", "/api/documents/"+doc.ID+"/chat-sessions/"+target.ID, nil)
	if w.Code != 200 {
		t.Fatalf("delete: %d %s", w.Code, w.Body.String())
	}
	var result struct {
		Replacement *ChatSession `json:"replacement"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Replacement == nil {
		t.Fatal("missing replacement", w.Body.String(), err)
	}
	if result.Replacement.ID == target.ID || result.Replacement.DocumentID != doc.ID || result.Replacement.Title != "默认会话" {
		t.Fatal("wrong replacement", result.Replacement)
	}
	if got := deletionCount(t, s, "SELECT count(*) FROM chat_sessions WHERE document_id=?", doc.ID); got != 1 {
		t.Fatal("replacement was not atomic", got)
	}
	if history, err := s.Store.chatHistory(doc.ID, result.Replacement.ID); err != nil || len(history) != 0 {
		t.Fatal("history leaked into replacement", history, err)
	}
	if w := request(t, s, "GET", "/api/documents/"+doc.ID+"/chat-sessions/"+target.ID+"/messages", nil); w.Code != 404 {
		t.Fatal("old transcript is still readable", w.Code)
	}
}

func TestChatSessionDeletionRejectsMissingAndWrongDocumentTargets(t *testing.T) {
	s, doc, target := deletionFixture(t)
	if _, err := s.Store.DB.Exec("INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at) VALUES('other-document','pdf','Other','',0,?,?)", now(), now()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/documents/other-document/chat-sessions/" + target.ID,
		"/api/documents/" + doc.ID + "/chat-sessions/missing",
	} {
		if w := request(t, s, "DELETE", path, nil); w.Code != 404 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
	if _, err := s.Store.chatSession(doc.ID, target.ID); err != nil {
		t.Fatal("wrong-document request deleted session", err)
	}
}

func TestChatSessionDeletionRejectsActiveReservedAndPersistedRuns(t *testing.T) {
	for _, state := range []string{"active", "reserved", "persisted"} {
		t.Run(state, func(t *testing.T) {
			s, doc, target := deletionFixture(t)
			switch state {
			case "active":
				s.chatRuns = map[string]*chatRun{target.ID: {}}
				defer delete(s.chatRuns, target.ID)
			case "reserved":
				s.chatReservations = map[string]bool{target.ID: true}
			case "persisted":
				if _, err := s.Store.DB.Exec("INSERT INTO chat_runs VALUES(?,?,?)", "running", target.ID, jsonText(ChatRun{ID: "running", Status: "running"})); err != nil {
					t.Fatal(err)
				}
			}
			w := request(t, s, "DELETE", "/api/documents/"+doc.ID+"/chat-sessions/"+target.ID, nil)
			if w.Code != 409 {
				t.Fatalf("running delete: %d %s", w.Code, w.Body.String())
			}
			if _, err := s.Store.chatSession(doc.ID, target.ID); err != nil {
				t.Fatal("running session was deleted", err)
			}
		})
	}
}

func TestChatSessionDeletionRollsBackTranscriptAndAnswerLinksOnFailure(t *testing.T) {
	s, doc, target := deletionFixture(t)
	if err := s.Store.saveMessage(Message{ID: "rollback-answer", DocumentID: doc.ID, SessionID: target.ID, Role: "assistant", Content: "Keep this answer"}); err != nil {
		t.Fatal(err)
	}
	question := deletionQuestion(t, s, doc.ID, "rollback-answer")
	if err := saveDocumentConversation(t.Context(), s.Store.DB, doc.ID, conversationProvider(target.ID, "api"), documentConversation{ID: "retained"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec("CREATE TRIGGER reject_session_deletion BEFORE DELETE ON chat_sessions BEGIN SELECT RAISE(ABORT,'delete failed'); END"); err != nil {
		t.Fatal(err)
	}
	w := request(t, s, "DELETE", "/api/documents/"+doc.ID+"/chat-sessions/"+target.ID, nil)
	if w.Code != 500 {
		t.Fatalf("failed delete: %d %s", w.Code, w.Body.String())
	}
	if deletionCount(t, s, "SELECT count(*) FROM messages") != 1 || deletionCount(t, s, "SELECT count(*) FROM document_conversations") != 1 || deletionCount(t, s, "SELECT count(*) FROM chat_sessions") != 1 {
		t.Fatal("partial deletion was committed")
	}
	var body string
	if err := s.Store.DB.QueryRow("SELECT body FROM annotations WHERE id=?", question.ID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	var after Annotation
	if err := json.Unmarshal([]byte(body), &after); err != nil || after.AnswerID != "rollback-answer" {
		t.Fatal("answer link was changed by failed deletion", after, err)
	}
}

func TestChatSessionDeletionKeepsAnnotationUndoWithoutRestoringDeletedAnswers(t *testing.T) {
	for _, mutation := range []string{"edit", "delete"} {
		t.Run(mutation, func(t *testing.T) {
			s, doc, target := deletionFixture(t)
			if err := s.Store.saveMessage(Message{ID: "undo-answer", DocumentID: doc.ID, SessionID: target.ID, Role: "assistant", Content: "Answer"}); err != nil {
				t.Fatal(err)
			}
			question := deletionQuestion(t, s, doc.ID, "undo-answer")
			path := "/api/documents/" + doc.ID + "/annotations/" + question.ID
			if mutation == "edit" {
				if w := undoRequest(t, s, "client", "PATCH", path, map[string]string{"note": "Edited question"}); w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			} else if w := undoRequest(t, s, "client", "DELETE", path, nil); w.Code != 204 {
				t.Fatal(w.Body.String())
			}
			if w := request(t, s, "DELETE", "/api/documents/"+doc.ID+"/chat-sessions/"+target.ID, nil); w.Code != 200 {
				t.Fatalf("delete: %d %s", w.Code, w.Body.String())
			}
			w := undoRequest(t, s, "client", "POST", "/api/documents/"+doc.ID+"/annotations/undo", nil)
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"undone":true`) {
				t.Fatalf("undo: %d %s", w.Code, w.Body.String())
			}
			var result struct {
				Annotations []Annotation `json:"annotations"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Annotations) != 1 {
				t.Fatal(w.Body.String(), err)
			}
			after := result.Annotations[0]
			if after.ID != question.ID || after.Note != "Keep my question" || after.Quote != "source text" || after.AnswerID != "" {
				t.Fatal("undo lost annotation content or restored a deleted answer", after)
			}
		})
	}
}
