package interleaf

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDocumentChatWaitsForExplicitToolCapabilityCheck(t *testing.T) {
	s, _ := pageImageFixture(t, true)
	probes, reads, generations := 0, 0, 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			respond(w, 200, map[string]any{"data": []any{map[string]string{"id": "test"}}})
			return
		}
		var payload struct {
			Messages []toolCompletionMessage `json:"messages"`
			Tools    []any                   `json:"tools"`
		}
		json.NewDecoder(r.Body).Decode(&payload)
		if strings.Contains(jsonText(payload.Messages), "Call interleaf_probe once") {
			probes++
			if payload.Messages[len(payload.Messages)-1].Role == "tool" {
				writeConversationReply(w, payload.Messages[len(payload.Messages)-1].Content.(string), "")
			} else {
				writeToolReply(w, "interleaf_probe", `{}`)
			}
			return
		}
		// Explicit /check also performs its separately requested text check.
		if strings.Contains(jsonText(payload.Messages), "Reply with exactly INTERLEAF_OK") {
			writeConversationReply(w, "INTERLEAF_OK", "")
			return
		}
		generations++
		if strings.Contains(jsonText(payload.Tools), "read_pdf_pages") {
			reads++
			writeConversationReply(w, "checked tools available", "")
			return
		}
		if len(payload.Tools) != 0 {
			t.Error("unverified tools enabled")
		}
		writeConversationReply(w, "text assistance", "")
	}))
	defer upstream.Close()
	c := AIConfig{Primary: "api", API: APIConnection{URL: upstream.URL}, Models: map[string]string{"api": "test"}, APIModels: []string{"test"}, Capabilities: map[string]Capability{}}
	passModels(&c, map[string]bool{"test": true})
	if err := s.writeAIConfig(c); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		out := conversationRequest(t, s, "api", "第二页的图讲的是什么")
		if !strings.Contains(out.Body.String(), "event: done") || !strings.Contains(out.Body.String(), "文字检索辅助") {
			t.Fatal(out.Body.String())
		}
	}
	if probes != 0 || reads != 0 || generations != 2 {
		t.Fatal("hidden paid probe", probes, reads, generations)
	}
	out := request(t, s, "POST", "/api/ai/check", strings.NewReader(`{"role":"chat","model":"test"}`))
	if out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	if probes != 2 {
		t.Fatal("missing explicit tool round trip", probes)
	}
	out = conversationRequest(t, s, "api", "再解释一次")
	if !strings.Contains(out.Body.String(), "event: done") || reads != 1 || generations != 3 || probes != 2 {
		t.Fatal(out.Body.String(), probes, reads, generations)
	}
}

func TestMultimodalToolRequestDoesNotUseTextOnlyBodyLimit(t *testing.T) {
	called := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; writeConversationReply(w, "ok", "") }))
	defer upstream.Close()
	request := completionRequest{Model: "vision", Vision: true, PageImageData: func(documentPageImage) ([]byte, error) { return []byte(strings.Repeat("x", 4<<20)), nil }}
	messages := []toolCompletionMessage{{Role: "user", Content: "page", PageImages: []documentPageImage{{Page: 1, SourceID: "S1"}}}}
	if _, err := toolCompletion(t.Context(), APIConnection{URL: upstream.URL}, request, messages, nil); err != nil || !called {
		t.Fatal("valid image payload rejected by text-only ceiling", err)
	}
}
