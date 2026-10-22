package reader

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeTasksWithoutAgentRuntimes(t *testing.T) {
	dir := t.TempDir()
	trap := filepath.Join(dir, "called")
	for _, name := range []string{"codex", "claude", "kimi"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\necho called >> "+trap+"\nexit 99\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("READER_AGENT", filepath.Join(dir, "absent"))
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			fmt.Fprint(w, `{"data":[{"id":"native-model"}]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"native answer\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer endpoint.Close()
	s := nativeTestServer(t)
	raw := `{"version":2,"connection":{"protocol":"openai","url":"` + endpoint.URL + `/v1","key":null},"models":{"chat":"native-model","translation":"native-model","vision":"native-model"}}`
	if w := request(t, s, "PUT", "/api/ai/config", bytes.NewBufferString(raw)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for _, role := range []modelTask{taskChat, taskTranslation} {
		t.Run(string(role), func(t *testing.T) {
			service := s.currentGenerationService(role)
			result, err := service.Generate(context.Background(), AIInput{Prompt: "answer"}, false, nil)
			if err != nil || result.Text != "native answer" {
				t.Fatalf("native %s generation failed: %v %+v", role, err, result)
			}
		})
	}

	for name, run := range map[string]func(*testing.T){
		"chat-images":               TestImageChatSendsPixelsAndRecordsAttachmentWithFallback,
		"multi-session":             TestNativeSessionSessionsConcurrentCancelAndDetachedSubscriber,
		"translation-batches":       TestTranslationRunsThreeBatchesAndSavesBeforeProviderCompletes,
		"formula":                   TestFormulaConversionDoesNotBlockCaptionTranslation,
		"bilingual-preflight-start": TestBilingualPDFStreamingFrozenAPIAndAttachment,
	} {
		t.Run(name, run)
	}
	t.Run("overview", func(t *testing.T) {
		server, _ := originalDocumentFixture(t)
		calls, failAt := 0, -1
		fake := overviewTestService(t, &calls, &failAt)
		api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "GET" {
				fmt.Fprint(w, `{"data":[]}`)
				return
			}
			var input apiCall
			json.NewDecoder(r.Body).Decode(&input)
			prompt, _ := input.Messages[len(input.Messages)-1].Content.(string)
			result, err := fake.Generate(r.Context(), AIInput{Prompt: prompt}, false, nil)
			if err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			writeAPIReply(w, result.Text)
		}))
		defer api.Close()
		configureNativeTest(t, server, api.URL, "overview-model", false)
		if err := server.compileOverview(t.Context(), overviewTestJob(t, server), server.currentGenerationService(taskChat)); err != nil || calls == 0 {
			t.Fatal(err, calls)
		}
	})
	t.Run("classification", func(t *testing.T) {
		server, _, _ := translationFixture(t)
		api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "GET" {
				fmt.Fprint(w, `{"data":[]}`)
				return
			}
			var body apiCall
			json.NewDecoder(r.Body).Decode(&body)
			if !strings.Contains(jsonText(body), "Classify") {
				t.Error("wrong classification prompt")
			}
			writeAPIReply(w, `{"category":"paper"}`)
		}))
		defer api.Close()
		configureNativeTest(t, server, api.URL, "classification-model", false)
		server.Store.DB.Exec("UPDATE documents SET classification_status='pending',category_source='default' WHERE id='doc'")
		server.classifyDocument(t.Context(), "doc", server.currentGenerationService(taskChat))
		doc, err := server.Store.Document("doc")
		if err != nil || doc.ClassificationStatus != "done" || doc.Category != "paper" {
			t.Fatal(doc, err)
		}
	})
	if _, err := os.Stat(trap); !os.IsNotExist(err) {
		t.Fatal("external runtime was invoked")
	}
}

func TestNativeTranslationSnapshotOverridesAndKey(t *testing.T) {
	s := testServer(t)
	calls := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[]}`)
			return
		}
		calls++
		var body apiCall
		json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("Authorization") != "Bearer original-key" || body.Model != "task-model" {
			t.Errorf("snapshot changed: %s %s", r.Header.Get("Authorization"), body.Model)
		}
		if calls == 2 && len(body.Messages) < 4 {
			t.Error("worker lost previous completed turn")
		}
		writeAPIReply(w, "complete")
	}))
	defer api.Close()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, fmt.Sprintf(`{"version":2,"connection":{"url":%q,"protocol":"openai","key":"original-key"},"models":{"chat":"chat-model","translation":"canonical-model"}}`, api.URL)))
	if err != nil {
		t.Fatal(err)
	}
	s.configMu.Lock()
	stored, err := s.readNativeAIConfig()
	s.configMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	options := &translationRunOptions{Provider: "api", Model: "task-model", Effort: "low"}
	stored.Config = options.apply(stored.Config)
	snapshot, err := s.resolveNativeStoredTask(t.Context(), stored, taskTranslation)
	if err != nil {
		t.Fatal(err)
	}
	canonical, _ := s.nativeAIConfig()
	if canonical.Models[taskTranslation] != "canonical-model" {
		t.Fatal("override mutated saved config")
	}
	service, session := s.nativeTranslationService(snapshot, nil)
	defer session.close()
	_, err = s.saveNativeAIConfig(nativeUpdate(t, fmt.Sprintf(`{"version":2,"connection":{"url":%q,"protocol":"openai","key":"replacement-key"},"models":{"chat":"new-model","translation":"new-model"}}`, api.URL)))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := service.Generate(t.Context(), AIInput{Prompt: "batch"}, false, nil); err != nil {
			t.Fatal(err)
		}
	}
	session.close()
	if len(session.history) != 0 {
		t.Fatal("worker history retained after close")
	}
}
func TestNativeCloseDocumentIO(t *testing.T) {
	for _, boundary := range []string{"close", "delete", "migration"} {
		for _, role := range []modelTask{taskChat, taskTranslation, taskVision} {
			t.Run(boundary+"/"+string(role), func(t *testing.T) {
				s, _, _ := translationFixture(t)
				entered := make(chan struct{})
				done := make(chan struct{})
				api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method == "GET" {
						fmt.Fprint(w, `{"data":[]}`)
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n")
					w.(http.Flusher).Flush()
					close(entered)
					select {
					case <-r.Context().Done():
					case <-time.After(3 * time.Second):
					}
				}))
				defer api.Close()
				configureNativeTest(t, s, api.URL, "test", true)
				go func() {
					defer close(done)
					ctx, finish, err := s.beginDocumentTask(t.Context(), "doc")
					if err != nil {
						t.Error(err)
						return
					}
					defer finish()
					g := s.currentGenerationServiceContext(ctx, role)
					result, err := g.Generate(ctx, AIInput{Prompt: "blocked"}, false, nil)
					if err == nil || result.Text != "" {
						t.Errorf("partial task succeeded: %+v %v", result, err)
					}
				}()
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("API not reached")
				}
				if boundary == "delete" {
					w := request(t, s, "DELETE", "/api/documents/doc", nil)
					if w.Code != 204 {
						t.Fatal(w.Code, w.Body.String())
					}
				} else {
					s.Close()
				}
				select {
				case <-done:
				default:
					t.Fatal("boundary returned before join")
				}
				if boundary == "migration" {
					reopened, err := OpenStore(s.Store.Root)
					if err != nil {
						t.Fatal(err)
					}
					defer reopened.DB.Close()
					var n int
					reopened.DB.QueryRow("SELECT count(*) FROM messages WHERE role='assistant'").Scan(&n)
					if n != 0 {
						t.Fatal("late answer survived migration", n)
					}
				}
			})
		}
	}
}

func TestNativeTranslationCloseJoinsStream(t *testing.T) {
	s := testServer(t)
	entered := make(chan struct{})
	done := make(chan struct{})
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(entered)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	defer api.Close()
	g, session := s.nativeTranslationService(nativeTaskSnapshot{Connection: APIConnection{URL: api.URL, Protocol: "openai"}, Model: "test", Text: true}, nil)
	go func() { defer close(done); _, _ = g.Generate(t.Context(), AIInput{Prompt: "batch"}, false, nil) }()
	<-entered
	session.close()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Error("session close returned before request joined")
	}
	s.Close()
	<-done
	if len(session.history) != 0 {
		t.Fatal("partial turn retained")
	}
	if _, err := g.Generate(t.Context(), AIInput{Prompt: "late"}, false, nil); err == nil {
		t.Fatal("closed worker accepted another batch")
	}
}

func TestNativeCloseDuringChatCatalogJoinsPreparation(t *testing.T) {
	for _, boundary := range []string{"delete", "close"} {
		t.Run(boundary, func(t *testing.T) {
			s, _, _ := translationFixture(t)
			entered := make(chan struct{})
			release := make(chan struct{})
			done := make(chan struct{})
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					t.Error("generation after cancellation")
					return
				}
				close(entered)
				select {
				case <-r.Context().Done():
				case <-release:
				}
			}))
			defer api.Close()
			defer close(release)
			configureNativeTest(t, s, api.URL, "test", false)
			go func() {
				defer close(done)
				request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(`{"provider":"api","prompt":"hi","context":""}`))
			}()
			<-entered
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				if boundary == "delete" {
					request(t, s, "DELETE", "/api/documents/doc", nil)
				} else {
					s.Close()
				}
			}()
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("catalog preparation did not cancel")
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("request still running after boundary")
			}
		})
	}
}
