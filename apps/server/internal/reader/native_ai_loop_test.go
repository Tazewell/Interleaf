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

type nativeFixtureTools struct {
	calls     int
	validated bool
	reject    bool
}

func (f *nativeFixtureTools) Definitions(bool) []any {
	return []any{map[string]any{"type": "function", "function": map[string]any{"name": "read_passage", "parameters": map[string]any{"type": "object"}}}}
}
func (f *nativeFixtureTools) Call(ctx context.Context, name string, args json.RawMessage) (nativeToolResult, error) {
	f.calls++
	if name != "read_passage" || string(args) != `{"blockId":"p1-b1"}` {
		return nativeToolResult{}, fmt.Errorf("bad arguments: %s %s", name, args)
	}
	return nativeToolResult{Content: json.RawMessage(`{"sourceId":"S1"}`), Images: []nativeToolImage{{SourceID: "paper:A:page1", MIME: "image/png", Label: "page one", Data: []byte("pixels")}}}, nil
}
func (f *nativeFixtureTools) Check(ctx context.Context) error { return ctx.Err() }
func (f *nativeFixtureTools) ValidateAnswer(ctx context.Context, text string) error {
	f.validated = true
	if f.reject {
		return fmt.Errorf("invalid source")
	}
	return nil
}
func nativeFixtureFrame(protocol, kind string) string {
	if protocol == "openai" {
		switch kind {
		case "tool":
			return "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"think\",\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"type\":\"function\",\"function\":{\"name\":\"read_passage\",\"arguments\":\"{\\\"blockId\\\":\"}}]}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"p1-b1\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n"
		case "partial":
			return "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"draft\",\"reasoning_content\":\"think\"}}]}\n\n"
		default:
			return "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer [S1]\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
		}
	}
	start := "data: {\"type\":\"message_start\",\"message\":{\"model\":\"test\"}}\n\n"
	if kind == "tool" {
		return start + "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"c1\",\"name\":\"read_passage\",\"input\":{}}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"blockId\\\":\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"p1-b1\\\"}\"}}\n\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n"
	}
	text := start + "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"answer [S1]\"}}\n\n"
	if kind == "partial" {
		return text
	}
	return text + "data: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n"
}

// Persistence is exercised against SQLite in TestNativeSessionDocumentCompletionCommitsAtomically.
func TestNativeLoopOpenAIAndAnthropicCompletion(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		for _, mode := range []string{"complete", "partial", "unknown", "duplicate", "invalid-source", "cancel"} {
			t.Run(protocol+"/"+mode, func(t *testing.T) {
				calls := 0
				tools := &nativeFixtureTools{reject: mode == "invalid-source"}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					var payload map[string]any
					json.NewDecoder(r.Body).Decode(&payload)
					if calls == 2 && mode == "complete" {
						wire := jsonText(payload)
						if !strings.Contains(wire, "paper:A:page1") || !strings.Contains(wire, "cGl4ZWxz") {
							t.Error("lost source image", wire)
						}
					}
					kind := "tool"
					if calls > 1 {
						kind = "answer"
					}
					if mode == "partial" || mode == "cancel" {
						kind = "partial"
					}
					if mode == "duplicate" && calls == 2 {
						kind = "tool"
					}
					frame := nativeFixtureFrame(protocol, kind)
					if mode == "unknown" {
						frame = strings.ReplaceAll(frame, "read_passage", "execute_shell")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, frame)
				}))
				defer server.Close()
				result, err := runNativeLoop(ctx, nativeLoopRequest{Snapshot: nativeTaskSnapshot{Connection: APIConnection{URL: server.URL, Protocol: protocol}, Model: "test", Tools: true, Vision: true}, Input: AIInput{Prompt: "question"}, Tools: tools}, func(e ProviderEvent) error {
					if mode == "cancel" {
						cancel()
					}
					return nil
				})
				if mode == "complete" {
					if err != nil || result.Result.Text != "answer [S1]" || tools.calls != 1 || !tools.validated || calls != 2 {
						t.Fatal(result, err, tools, calls)
					}
				} else {
					if err == nil || result.Result.Text != "" {
						t.Fatal("saved incomplete result", result, err)
					}
					if calls > 2 {
						t.Fatal("fallback call", calls)
					}
				}
			})
		}
	}
}

func TestNativeLoopInputImagesAreNotPersistedAsPixels(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		t.Run(protocol, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var payload map[string]any
				json.NewDecoder(r.Body).Decode(&payload)
				wire := jsonText(payload)
				if !strings.Contains(wire, "cGl4ZWxz") {
					t.Error("input image not sent")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, nativeFixtureFrame(protocol, "answer"))
			}))
			defer server.Close()
			result, err := runNativeLoop(t.Context(), nativeLoopRequest{Snapshot: nativeTaskSnapshot{Connection: APIConnection{URL: server.URL, Protocol: protocol}, Model: "test", Vision: true}, Input: AIInput{Prompt: "look", Images: [][]byte{[]byte("pixels")}}}, nil)
			if err != nil || calls != 1 {
				t.Fatal(err, calls)
			}
			persisted := jsonText(result.Window.Messages)
			if strings.Contains(persisted, "cGl4ZWxz") || strings.Contains(persisted, "data:image") {
				t.Fatal("image pixels leaked into durable history", persisted)
			}
		})
	}
}
func TestNativeLoopUnknownVisionUsesTextAssistance(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		calls++
		var payload map[string]any
		json.NewDecoder(r.Body).Decode(&payload)
		wire := jsonText(payload)
		if strings.Contains(wire, "cGl4ZWxz") || !strings.Contains(wire, "未通过图片检测") {
			t.Error("vision not disabled honestly", wire)
		}
		writeConversationReply(w, "text answer", "")
	}))
	defer server.Close()
	configureDocumentAPI(t, s, server.URL)
	config := s.aiConfig()
	// An image request with no verified vision must reach the same native chat
	// once, with explicit text assistance, rather than invoke Pi or a vision probe.
	in := AIInput{Prompt: "look", Images: [][]byte{[]byte("pixels")}, Chat: &chatInput{server: s, DocumentID: "doc", SessionID: "session", Question: "look"}}
	result, err := s.generationService(config).Generate(t.Context(), in, true, func(ProviderEvent) error { return nil })
	if err != nil || result.Text != "text answer" || calls != 1 {
		t.Fatal(result, err, calls)
	}
}

func TestNativeLoopAnthropicExplicitToolCheck(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var payload map[string]any
		json.NewDecoder(r.Body).Decode(&payload)
		wire := jsonText(payload)
		frame := nativeFixtureFrame("anthropic", "tool")
		if calls == 1 {
			frame = strings.ReplaceAll(frame, "read_passage", "reader_probe")
			frame = strings.ReplaceAll(frame, `{\"blockId\":`, ``)
			frame = strings.ReplaceAll(frame, `\"p1-b1\"}`, `{}`)
		} else {
			var nonce string
			messages, _ := payload["messages"].([]any)
			for _, message := range messages {
				m, _ := message.(map[string]any)
				blocks, _ := m["content"].([]any)
				for _, block := range blocks {
					b, _ := block.(map[string]any)
					if b["type"] == "tool_result" {
						nonce, _ = b["content"].(string)
					}
				}
			}
			if nonce == "" {
				t.Error("missing probe result", wire)
			}
			frame = strings.ReplaceAll(nativeFixtureFrame("anthropic", "answer"), "answer [S1]", nonce)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, frame)
	}))
	defer upstream.Close()
	status, err := probeAPIDocumentTools(t.Context(), APIConnection{URL: upstream.URL, Protocol: "anthropic"}, "test")
	if err != nil || status != "passed" || calls != 2 {
		t.Fatal(status, err, calls)
	}
}

func TestNativeLoopRejectsMalformedCompletionSignals(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		for _, mode := range []string{"missing-finish", "missing-terminal", "malformed-arguments", "duplicate-batch", "mismatched-finish", "invalid-utf8"} {
			t.Run(protocol+"/"+mode, func(t *testing.T) {
				calls := 0
				tools := &nativeFixtureTools{}
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					frame := nativeFixtureFrame(protocol, "tool")
					switch mode {
					case "invalid-utf8":
						frame = strings.ReplaceAll(frame, "read_passage", "read_"+string([]byte{0xff})+"_passage")
					case "missing-finish":
						if protocol == "openai" {
							frame = strings.ReplaceAll(frame, `,"finish_reason":"tool_calls"`, ``)
						} else {
							frame = strings.ReplaceAll(frame, `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`+"\n\n", "")
						}
					case "missing-terminal":
						if protocol == "openai" {
							frame = strings.ReplaceAll(frame, "data: [DONE]\n\n", "")
						} else {
							frame = strings.ReplaceAll(frame, "data: {\"type\":\"message_stop\"}\n\n", "")
						}
					case "malformed-arguments":
						frame = strings.ReplaceAll(frame, `\"p1-b1\"}`, `\"p1-b1\"`)
					case "duplicate-batch":
						if protocol == "openai" {
							frame = "data: " + jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "same", "type": "function", "function": map[string]string{"name": "read_passage", "arguments": `{"blockId":"p1-b1"}`}}, map[string]any{"index": 1, "id": "same", "type": "function", "function": map[string]string{"name": "read_passage", "arguments": `{"blockId":"p1-b1"}`}}}}, "finish_reason": "tool_calls"}}}) + "\n\ndata: [DONE]\n\n"
						} else {
							fragment := strings.SplitN(frame, "data: {\"type\":\"message_delta\"", 2)
							blocks := strings.TrimPrefix(fragment[0], "data: {\"type\":\"message_start\",\"message\":{\"model\":\"test\"}}\n\n")
							frame = fragment[0] + strings.ReplaceAll(blocks, `"index":0`, `"index":1`) + "data: {\"type\":\"message_delta\"" + fragment[1]
						}
					case "mismatched-finish":
						if protocol == "openai" {
							frame = strings.ReplaceAll(frame, `"finish_reason":"tool_calls"`, `"finish_reason":"stop"`)
						} else {
							frame = strings.ReplaceAll(frame, `"stop_reason":"tool_use"`, `"stop_reason":"end_turn"`)
						}
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, frame)
				}))
				defer upstream.Close()
				result, err := runNativeLoop(t.Context(), nativeLoopRequest{Snapshot: nativeTaskSnapshot{Connection: APIConnection{URL: upstream.URL, Protocol: protocol}, Model: "test", Vision: true, Tools: true}, Input: AIInput{Prompt: "read"}, Tools: tools}, nil)
				if err == nil || result.Result.Text != "" || tools.calls != 0 || calls != 1 {
					t.Fatal("executed incomplete or malformed tool request", result, err, tools.calls, calls)
				}
			})
		}
	}
}

func TestNativeLoopAnthropicUsageIncludesCache(t *testing.T) {
	frame := nativeFixtureFrame("anthropic", "answer")
	frame = strings.Replace(frame, `"model":"test"`, `"model":"test","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":20,"cache_creation_input_tokens":30}`, 1)
	frame = strings.Replace(frame, `"stop_reason":"end_turn"}}`, `"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`, 1)
	result, err := readNativeAnthropicCompletion(t.Context(), strings.NewReader(frame), APIConnection{})
	if err != nil || result.Tokens == nil || result.Tokens.InputTokens != 60 || result.Tokens.OutputTokens != 5 || result.Tokens.TotalTokens != 65 {
		t.Fatal(result.Tokens, err)
	}
}

func TestNativeLoopDoesNotFallbackBeforeOutput(t *testing.T) {
	s, _ := prepareConversationFixture(t)
	primaryCalls, backupCalls := 0, 0
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		primaryCalls++
		w.WriteHeader(503)
	}))
	defer primary.Close()
	backup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backupCalls++
		writeConversationReply(w, "should never run", "")
	}))
	defer backup.Close()
	configureDocumentAPI(t, s, primary.URL)
	config := s.aiConfig()
	config.TextAPI = APIConnection{URL: backup.URL, Model: "backup"}
	config.Capabilities["text-api"] = Capability{Text: true, Fingerprint: configPrint(config, "text-api")}
	result, err := s.generationService(config).Generate(t.Context(), AIInput{Prompt: "question", Chat: &chatInput{server: s, DocumentID: "doc", SessionID: "session", Question: "question"}}, true, func(event ProviderEvent) error {
		if event.Fallback != "" {
			t.Error("native generation fell back")
		}
		return nil
	})
	if err == nil || result.Text != "" || primaryCalls != 1 || backupCalls != 0 {
		t.Fatal("native model replaced after failure", result, err, primaryCalls, backupCalls)
	}
}

func TestNativeLoopBoundsAnthropicPrivateContinuation(t *testing.T) {
	frame := "data: {\"type\":\"message_start\",\"message\":{\"model\":\"test\"}}\n\n"
	frame += "data: " + jsonText(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": "thinking", "thinking": "", "signature": strings.Repeat("s", (256<<10)+1)}}) + "\n\n"
	frame += "data: {\"type\":\"content_block_stop\",\"index\":0}\n\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"answer\"}}\n\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n"
	_, err := readNativeAnthropicCompletion(t.Context(), strings.NewReader(frame), APIConnection{})
	if err == nil || errorKind(err) != ErrorLimit {
		t.Fatal("unbounded private signature accepted", err)
	}
}

// Promoted from the independently failing review overlay. Compaction and
// generation spend the same model-call budget; the last call must finish.
func TestNativeLoopCompactionReservesFinalAnswerRound(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		for _, scope := range []string{"generic", "document"} {
			for _, mode := range []string{"answer", "late-tool", "exhausted"} {
				t.Run(protocol+"/"+scope+"/"+mode, func(t *testing.T) {
					calls, reserved, compactions, answerCalls := 0, 0, 0, 0
					fixture := &nativeFixtureTools{}
					var tools nativeToolset = fixture
					var agent *documentAgent
					repeat := 1500
					if scope == "document" {
						_, agent = prepareConversationFixture(t)
						agent.contextTokens = 8192
						agent.conversation = &documentConversation{SeenSources: map[string]bool{}}
						tools = documentToolset{agent}
					}
					maxRounds := 4
					if mode == "exhausted" {
						maxRounds = 3
					}
					messages := []toolCompletionMessage{{Role: "system", Content: "instructions"}, {Role: "user", Content: "old question"}, {Role: "assistant", Content: strings.Repeat("old evidence ", repeat)}, {Role: "user", Content: "continue"}}
					before := jsonText(messages)
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						calls++
						var payload struct {
							Tools    []any  `json:"tools"`
							Messages any    `json:"messages"`
							System   string `json:"system"`
						}
						if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
							t.Error(err)
							return
						}
						w.Header().Set("Content-Type", "text/event-stream")
						frame := nativeFixtureFrame(protocol, "answer")
						if strings.Contains(jsonText(payload), "整理对话检查点") {
							compactions++
							fmt.Fprint(w, strings.ReplaceAll(frame, "answer [S1]", "checkpoint"))
							return
						}
						answerCalls++
						if calls != maxRounds || reserved != maxRounds {
							t.Errorf("final generation did not consume last reserved call: HTTP=%d reserved=%d budget=%d", calls, reserved, maxRounds)
						}
						if len(payload.Tools) != 0 {
							t.Error("final remaining model call still advertises read tools after compaction")
						}
						if mode == "late-tool" || len(payload.Tools) != 0 {
							frame = nativeFixtureFrame(protocol, "tool")
						} else {
							frame = strings.ReplaceAll(frame, "answer [S1]", "answer")
						}
						fmt.Fprint(w, frame)
					}))
					defer upstream.Close()
					result, err := runNativeLoop(t.Context(), nativeLoopRequest{Snapshot: nativeTaskSnapshot{Connection: APIConnection{URL: upstream.URL, Protocol: protocol}, Model: "test", Tools: true, Vision: true, ContextWindow: 8192}, Window: nativeConversation{Messages: messages}, Tools: tools, Budget: nativeLoopBudget{MaxRounds: maxRounds, ReserveCall: func(context.Context) error { reserved++; return nil }}}, nil)
					if calls != maxRounds || reserved != maxRounds || compactions != 3 {
						t.Fatal("incorrect paid-call count", calls, reserved, compactions, err)
					}
					toolCalls := fixture.calls
					if agent != nil {
						toolCalls = len(agent.Traces)
					}
					if toolCalls != 0 || jsonText(messages) != before {
						t.Fatal("late tool executed or original window changed", toolCalls)
					}
					if mode == "answer" {
						if err != nil || result.Result.Text != "answer" || answerCalls != 1 || len(result.Window.Checkpoints) != 1 {
							t.Fatal(result, err, answerCalls)
						}
						if agent != nil {
							if agent.readingRounds != maxRounds || !agent.readingStopped() {
								t.Fatal("document last-round state was not refreshed", agent.readingRounds, agent.readingStop)
							}
							finished, finishErr := agent.finishDocumentAnswer(t.Context(), result.Result, nil)
							if finishErr != nil || !strings.Contains(finished.Text, "工具轮次达到保护上限") {
								t.Fatal("reading scope stop reminder missing", finished, finishErr)
							}
						}
					} else {
						if err == nil || result.Result.Text != "" || len(result.Window.Messages) != 0 {
							t.Fatal("budget failure reported success", result, err)
						}
						if mode == "exhausted" && (answerCalls != 0 || errorKind(err) != ErrorLimit) {
							t.Fatal("generation escaped exhausted compaction budget", answerCalls, err)
						}
					}
				})
			}
		}
	}
}
