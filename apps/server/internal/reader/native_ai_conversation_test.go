package reader

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNativeSessionRebuildAndCompaction(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	history := []Message{{ID: "old-user", Role: "user", Content: "remember", ReadingLocation: json.RawMessage(`{"type":"epub","href":"chapter.xhtml"}`)}, {ID: "old-answer", Role: "assistant", Content: "old answer", References: json.RawMessage(`[{"sourceId":"S1","corpusRevision":"old"}]`)}}
	state := documentConversation{ID: "old", ConnectionKey: "pi-old", PiEntries: json.RawMessage(`[{"secret":"must-not-replay"}]`), NativeThread: "private-thread", LastMessageID: "old-answer"}
	if err := saveDocumentConversation(t.Context(), s.Store.DB, "doc", conversationProvider("session", "api"), state); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var payload map[string]any
		json.NewDecoder(r.Body).Decode(&payload)
		wire := jsonText(payload)
		if !strings.Contains(wire, "chapter.xhtml") || !strings.Contains(wire, "42") || !strings.Contains(wire, "old answer") || strings.Contains(wire, "private-thread") || strings.Contains(wire, "must-not-replay") {
			t.Error(wire)
		}
		writeConversationReply(w, "native answer", "")
	}))
	defer server.Close()
	chat := &chatInput{server: s, DocumentID: "doc", SessionID: "session", History: history, Question: "continue", ReadingLocation: json.RawMessage(`{"type":"pdf","page":42}`)}
	result, err := (apiAdapter{APIConnection{URL: server.URL, Model: "test"}}).Stream(t.Context(), GenerateRequest{AIInput{Prompt: "continue", Chat: chat}}, nil)
	if err != nil || result.Text != "native answer" || calls != 1 {
		t.Fatal(result, err, calls)
	}
	if err = s.Store.saveChatAnswer(t.Context(), chat, result.Text, ""); err != nil {
		t.Fatal(err)
	}
	saved, err := s.Store.documentConversation(t.Context(), "doc", conversationProvider("session", "api"), nativeConnectionKey(nativeTaskSnapshot{Connection: APIConnection{URL: server.URL, Model: "test"}, Model: "test"}))
	if err != nil || len(saved.Messages) < 4 || len(saved.PiEntries) > 0 || saved.NativeThread != "" {
		t.Fatal(saved, err)
	}
	// A new endpoint/model must rebuild from visible records, never provider state.
	if rebuilt, err := s.Store.documentConversation(t.Context(), "doc", conversationProvider("session", "api"), "new-native-key"); err != nil || len(rebuilt.Messages) != 0 || rebuilt.LastMessageID != "" {
		t.Fatal(rebuilt, err)
	}
	TestConversationCompactionKeepsProtocolGroups(t)
}

func TestNativeSessionDocumentCompletionCommitsAtomically(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		for _, mode := range []string{"complete", "complete-tool", "partial", "partial-tool", "unknown-tool", "duplicate-tool", "cancel", "invalid-source", "save-failure"} {
			t.Run(protocol+"/"+mode, func(t *testing.T) {
				s, _ := prepareConversationFixture(t)
				session, err := s.Store.ensureDefaultChatSession("doc", "api")
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				calls := 0
				blockID := ""
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method == "GET" {
						respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
						return
					}
					calls++
					var payload map[string]any
					json.NewDecoder(r.Body).Decode(&payload)
					wire := jsonText(payload)
					if strings.Contains(wire, "reader_probe") {
						t.Error("hidden probe")
					}
					kind := "answer"
					if mode == "partial" || mode == "cancel" || mode == "partial-tool" && calls == 2 {
						kind = "partial"
					}
					if (mode == "complete-tool" || mode == "partial-tool") && calls == 1 || mode == "unknown-tool" || mode == "duplicate-tool" {
						kind = "tool"
					}
					frame := nativeFixtureFrame(protocol, kind)
					frame = strings.ReplaceAll(frame, "p1-b1", blockID)
					if mode == "unknown-tool" {
						frame = strings.ReplaceAll(frame, "read_passage", "execute_shell")
					}
					answer := "native answer"
					if mode == "complete-tool" {
						answer = "native answer [S2]"
					}
					frame = strings.ReplaceAll(frame, "answer [S1]", answer)
					if mode == "invalid-source" {
						frame = strings.ReplaceAll(frame, "native answer", "forged [S999]")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, frame)
				}))
				defer upstream.Close()
				configureDocumentAPI(t, s, upstream.URL)
				config := s.aiConfig()
				config.API.Protocol = protocol
				// This fixture explicitly supplies checked tools for the selected
				// protocol; a protocol edit must not reuse the old fingerprint.
				cap := config.Capabilities["api:test"]
				cap.Fingerprint = configPrint(config, "api:test")
				config.Capabilities["api:test"] = cap
				if err = s.writeAIConfig(config); err != nil {
					t.Fatal(err)
				}
				aCorpus, err := s.documentCorpus(t.Context(), "doc", nil)
				if err != nil {
					t.Fatal(err)
				}
				blockID = aCorpus.Passages[1].ID
				a := &documentAgent{server: s, corpus: aCorpus, ctx: t.Context(), ID: id(), sessionID: session}
				user := Message{ID: "original-user", DocumentID: "doc", SessionID: session, Role: "user", Content: "old question", ReadingLocation: json.RawMessage(`{"type":"epub","href":"chapter.xhtml"}`)}
				old := Message{ID: "original-answer", DocumentID: "doc", SessionID: session, Role: "assistant", Content: "old answer", References: json.RawMessage(`[{"sourceId":"S1","corpusRevision":"old"}]`)}
				for _, m := range []Message{user, old} {
					if err = s.Store.saveMessage(m); err != nil {
						t.Fatal(err)
					}
				}
				seed := documentConversation{ID: "old-state", ConnectionKey: "old-pi-key", PiEntries: json.RawMessage(`[{"hidden":"DO_NOT_SEND"}]`), NativeThread: "DO_NOT_SEND"}
				if err = saveDocumentConversation(t.Context(), s.Store.DB, "doc", conversationProvider(session, "api"), seed); err != nil {
					t.Fatal(err)
				}
				before := jsonText(seed)
				if mode == "save-failure" {
					_, err = s.Store.DB.Exec(`CREATE TRIGGER native_fail BEFORE INSERT ON chat_agent_runs BEGIN SELECT RAISE(ABORT,'save failure'); END`)
					if err != nil {
						t.Fatal(err)
					}
				}
				input := AIInput{Prompt: "continue", Chat: &chatInput{server: s, DocumentID: "doc", SessionID: session, Agent: a, History: []Message{user, old}, Question: "continue"}}
				events := 0
				assertUncommitted := func() {
					t.Helper()
					var savedAnswers, runs int
					if scanErr := s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE document_id='doc' AND json_extract(body,'$.role')='assistant' AND id!='original-answer'").Scan(&savedAnswers); scanErr != nil {
						t.Fatal(scanErr)
					}
					if savedAnswers != 0 {
						t.Fatal("answer persisted before validated save", savedAnswers)
					}
					if scanErr := s.Store.DB.QueryRow("SELECT count(*) FROM chat_agent_runs WHERE document_id='doc'").Scan(&runs); scanErr != nil {
						t.Fatal(scanErr)
					}
					var raw string
					if scanErr := s.Store.DB.QueryRow("SELECT body FROM document_conversations WHERE document_id='doc' AND provider=?", conversationProvider(session, "api")).Scan(&raw); scanErr != nil {
						t.Fatal(scanErr)
					}
					if runs != 0 || raw != before {
						t.Fatal("audit or conversation committed before validated save", runs, raw)
					}
				}
				result, err := s.apiAgentAdapter(config, taskChat).Stream(ctx, GenerateRequest{input}, func(event ProviderEvent) error {
					events++
					assertUncommitted()
					if mode == "cancel" {
						cancel()
					}
					if event.Text != "" && mode == "invalid-source" {
						t.Fatal("unvalidated final answer emitted")
					}
					return nil
				})
				if events == 0 {
					t.Fatal("save boundary was never observed during streaming")
				}
				assertUncommitted()
				if err == nil {
					err = s.saveDocumentAgentAnswer(t.Context(), a, result.Text, "api")
				}
				expectedCalls := 1
				if mode == "complete-tool" || mode == "partial-tool" || mode == "duplicate-tool" {
					expectedCalls = 2
				}
				if calls != expectedCalls {
					t.Fatal("fallback or hidden generation", calls, err)
				}
				var raw string
				if scanErr := s.Store.DB.QueryRow("SELECT body FROM document_conversations WHERE document_id='doc' AND provider=?", conversationProvider(session, "api")).Scan(&raw); scanErr != nil {
					t.Fatal(scanErr)
				}
				var answers, runs int
				if scanErr := s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE id NOT IN ('original-user','original-answer')").Scan(&answers); scanErr != nil {
					t.Fatal(scanErr)
				}
				if scanErr := s.Store.DB.QueryRow("SELECT count(*) FROM chat_agent_runs").Scan(&runs); scanErr != nil {
					t.Fatal(scanErr)
				}
				if mode == "complete" || mode == "complete-tool" {
					if err != nil || answers != 1 || runs != 1 || raw == before || strings.Contains(raw, "DO_NOT_SEND") {
						t.Fatal(err, answers, runs, raw)
					}
				} else {
					if err == nil || answers != 0 || runs != 0 || raw != before {
						t.Fatal("partial transactional save", err, answers, runs, raw)
					}
				}
				history, err := s.Store.chatHistory("doc", session)
				if mode == "complete-tool" && err == nil && !strings.Contains(string(history[len(history)-1].References), "S2") {
					t.Fatal("successful tool evidence not saved", history[len(history)-1])
				}
				if err != nil || history[0].ID != user.ID || string(history[0].ReadingLocation) != string(user.ReadingLocation) || history[1].ID != old.ID || string(history[1].References) != string(old.References) {
					t.Fatal("historical data changed", history, err)
				}
			})
		}
	}
}
func TestNativeSessionFailedCompactionPreservesWindow(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		t.Run(protocol, func(t *testing.T) {
			calls, reserved := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, nativeFixtureFrame(protocol, "partial"))
			}))
			defer server.Close()
			messages := []toolCompletionMessage{{Role: "system", Content: "instructions"}, {Role: "user", Content: "old question"}, {Role: "assistant", Content: strings.Repeat("old evidence ", 4000)}, {Role: "user", Content: "latest user input must remain whole"}}
			before := jsonText(messages)
			result, err := runNativeLoop(t.Context(), nativeLoopRequest{Snapshot: nativeTaskSnapshot{Connection: APIConnection{URL: server.URL, Protocol: protocol}, Model: "test", ContextWindow: 8192}, Window: nativeConversation{Messages: messages, Checkpoints: []string{"previous checkpoint"}}, Budget: nativeLoopBudget{ReserveCall: func(context.Context) error { reserved++; return nil }}}, nil)
			if err == nil || calls != 1 || reserved != 1 || len(result.Window.Messages) != 0 || jsonText(messages) != before {
				t.Fatal("failed compaction overwrote history", result, err, calls, reserved)
			}
		})
	}
}

func TestNativeSessionAttachmentReloadsWithoutPersistingPixels(t *testing.T) {
	s, pixels := imageFixture(t)
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var payload map[string]any
		json.NewDecoder(r.Body).Decode(&payload)
		if !strings.Contains(jsonText(payload), imageData(pixels)) {
			t.Error("attachment lost after restart")
		}
		writeConversationReply(w, "answer", "")
	}))
	defer upstream.Close()
	snapshot := nativeTaskSnapshot{Connection: APIConnection{URL: upstream.URL}, Model: "test", Vision: true}
	user := Message{ID: "u", Role: "user", DocumentID: "doc", SessionID: "session", Content: "look", Attachments: []ImageAttachment{{ID: "p1-b1"}}}
	chat := &chatInput{server: s, DocumentID: "doc", SessionID: "session", Question: "look"}
	result, err := streamNativeChat(t.Context(), snapshot, AIInput{Prompt: "look", Images: [][]byte{pixels}, Chat: chat}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Store.saveChatAnswer(t.Context(), chat, result.Text, ""); err != nil {
		t.Fatal(err)
	}
	history, err := s.Store.chatHistory("doc", "session")
	if err != nil {
		t.Fatal(err)
	}
	history = append([]Message{user}, history...)
	// A new chatInput forces loading JSON from SQLite, so runtime image bytes
	// cannot accidentally mask a broken persisted continuation.
	next := &chatInput{server: s, DocumentID: "doc", SessionID: "session", Question: "continue", History: history}
	result, err = streamNativeChat(t.Context(), snapshot, AIInput{Prompt: "continue", Chat: next}, nil)
	if err != nil || result.Text != "answer" || calls != 2 {
		t.Fatal("attachment continuation broken", result, err, calls)
	}
	var raw string
	s.Store.DB.QueryRow("SELECT body FROM document_conversations").Scan(&raw)
	if strings.Contains(raw, "data:image") {
		t.Fatal("pixels persisted")
	}
}

func TestNativeSessionSourceChangeRebuildsWindow(t *testing.T) {
	s, a := originalDocumentFixture(t)
	a.provider = "api"
	state := documentConversation{ID: "native", ConnectionKey: "reader-native-v1:key", Revision: "old-revision", PassageCount: 3, LastMessageID: "answer", ReadBlocks: []string{"old-block"}, Messages: []toolCompletionMessage{{Role: "system", Content: "system"}, {Role: "user", NativeImages: []nativeToolImage{{SourceID: "old-page", Hash: "old"}}}}}
	if err := saveDocumentConversation(t.Context(), s.Store.DB, "doc", "api", state); err != nil {
		t.Fatal(err)
	}
	history := []Message{{ID: "question", Role: "user", Content: "old question"}, {ID: "answer", Role: "assistant", Content: "old answer"}}
	missing, err := a.beginConversation(t.Context(), AIInput{Chat: &chatInput{Agent: a, History: history}}, state.ConnectionKey)
	if err != nil || len(a.conversation.Messages) != 0 || len(missing) != 2 || len(a.conversation.ReadBlocks) != 0 || a.conversation.SourceOffset != 3 {
		t.Fatal("stale protocol/source window reused", a.conversation, missing, err)
	}
	var persisted string
	s.Store.DB.QueryRow("SELECT body FROM document_conversations").Scan(&persisted)
	if persisted != jsonText(state) {
		t.Fatal("rebuild prematurely changed durable state")
	}
}
