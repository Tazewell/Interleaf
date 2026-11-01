package interleaf

import (
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

func configureNativeTest(t *testing.T, s *Server, url, model string, vision bool) {
	t.Helper()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, fmt.Sprintf(`{"version":2,"connection":{"protocol":"openai","url":%q,"key":null},"models":{"chat":%q,"translation":%q,"vision":%q}}`, url, model, model, model)))
	if err != nil {
		t.Fatal(err)
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	stored, err := s.readNativeAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	stored.Capabilities[apiCapabilityKey(model)] = Capability{Text: true, Vision: vision, Fingerprint: nativeConfigPrint(stored.Connection, model)}
	if err = s.writeNativeAIConfig(stored); err != nil {
		t.Fatal(err)
	}
}
func nativeFakeAgent(t *testing.T, s *Server, mode string) string {
	t.Helper()
	ack := filepath.Join(t.TempDir(), "ack")
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"native-model"}]}`)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if mode == "fail-before" {
			w.WriteHeader(429)
			fmt.Fprint(w, `{"error":{"message":"quota"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"model\":\"native-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好，\"}}]}\n\n")
		w.(http.Flusher).Flush()
		if mode == "fail-after" {
			return
		}
		if mode == "cancel" {
			<-r.Context().Done()
			return
		}
		if mode == "gated" {
			deadline := time.After(3 * time.Second)
			for {
				if _, err := os.Stat(ack); err == nil {
					break
				}
				select {
				case <-r.Context().Done():
					return
				case <-deadline:
					t.Error("client did not acknowledge first delta")
					return
				case <-time.After(time.Millisecond):
				}
			}
		}
		fmt.Fprint(w, "data: {\"model\":\"native-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"世界\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":10,\"total_tokens\":30}}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(endpoint.Close)
	configureNativeTest(t, s, endpoint.URL, "native-model", true)
	return ack
}

// Live tests use explicit environment input only, never another application's credentials.
func configureLiveNative(t *testing.T, s *Server, vision bool) nativeAIStored {
	t.Helper()
	key, url, model := os.Getenv("INTERLEAF_TEST_NATIVE_KEY"), os.Getenv("INTERLEAF_TEST_NATIVE_URL"), os.Getenv("INTERLEAF_TEST_NATIVE_MODEL")
	if os.Getenv("INTERLEAF_TEST_NATIVE_API") != "1" || key == "" || url == "" || model == "" {
		t.Skip("set INTERLEAF_TEST_NATIVE_API=1 and INTERLEAF_TEST_NATIVE_URL/KEY/MODEL")
	}
	protocol := os.Getenv("INTERLEAF_TEST_NATIVE_PROTOCOL")
	if protocol == "" {
		protocol = "openai"
	}
	body := fmt.Sprintf(`{"version":2,"connection":{"url":%q,"protocol":%q,"key":%q},"models":{"chat":%q,"translation":%q,"vision":%q}}`, url, protocol, key, model, model, model)
	if w := request(t, s, "PUT", "/api/ai/config", strings.NewReader(body)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	roles := []modelTask{taskChat}
	if vision {
		roles = append(roles, taskVision)
	}
	for _, role := range roles {
		w := request(t, s, "POST", "/api/ai/check", strings.NewReader(fmt.Sprintf(`{"role":%q,"model":%q,"waitSeconds":60}`, role, model)))
		var cap Capability
		if json.Unmarshal(w.Body.Bytes(), &cap) != nil || w.Code != 200 || !cap.Text || (vision && role == taskVision && !cap.Vision) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	stored, err := s.readNativeAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	return stored
}
