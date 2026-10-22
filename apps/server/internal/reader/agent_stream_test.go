package reader

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Run the test binary as the CLI so protocol tests need no installed agents,
// credentials, network, or additional scripting runtime.
func fakeAgent(t *testing.T, provider, mode string) string {
	t.Helper()
	dir := t.TempDir()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	name := provider
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	target := filepath.Join(dir, name)
	// Windows keeps the running test executable locked, including its hard links.
	// Copy there so TempDir cleanup can remove the helper after the child exits.
	if runtime.GOOS == "windows" || os.Link(binary, target) != nil {
		data, err := os.ReadFile(binary)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("READER_AGENT_HELPER", provider)
	t.Setenv("READER_AGENT_MODE", mode)
	ack := filepath.Join(dir, "received")
	t.Setenv("READER_AGENT_ACK", ack)
	return ack
}

func TestChatStreamsOverHTTP(t *testing.T) {
	for _, provider := range []string{"api"} {
		for _, withImage := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/image=%t", provider, withImage), func(t *testing.T) {
				s, _ := imageFixture(t)
				ack := nativeFakeAgent(t, s, "gated")
				server := httptest.NewServer(s.Handler())
				defer server.Close()
				body := map[string]any{"provider": provider, "prompt": "explain", "context": "source"}
				if withImage {
					body["attachments"] = []string{"p1-b1"}
				}
				b, _ := json.Marshal(body)
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/documents/doc/chat", strings.NewReader(string(b)))
				req.Header.Set("Authorization", "Bearer test-secret")
				res, err := server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				if res.StatusCode != 200 {
					t.Fatalf("status %d", res.StatusCode)
				}
				scanner := bufio.NewScanner(res.Body)
				event, text, done, chunks := "", "", false, 0
				for scanner.Scan() {
					line := scanner.Text()
					if strings.HasPrefix(line, "event: ") {
						event = strings.TrimPrefix(line, "event: ")
					}
					if !strings.HasPrefix(line, "data: ") {
						continue
					}
					if event == "error" {
						t.Fatal(line)
					}
					if event == "done" {
						done = true
					}
					if event != "draft" && event != "delta" {
						continue
					}
					var part struct {
						Text string `json:"text"`
					}
					if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &part); err != nil {
						t.Fatal(err)
					}
					if event == "delta" {
						text += part.Text
						continue
					}
					chunks++
					if chunks == 1 {
						// The fake agent cannot finish until the HTTP client acknowledges
						// this first delta. This also verifies Flush, not just callbacks.
						var count int
						if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE document_id='doc'").Scan(&count); err != nil || count != 1 {
							t.Fatalf("premature persistence: %d %v", count, err)
						}
						if err := os.WriteFile(ack, []byte("received"), 0600); err != nil {
							t.Fatal(err)
						}
					}
				}
				if scanner.Err() != nil || !done || chunks != 2 || text != "你好，世界" {
					t.Fatalf("SSE: done=%t chunks=%d text=%q error=%v", done, chunks, text, scanner.Err())
				}
				stored := request(t, s, "GET", "/api/documents/doc/messages", nil)
				var messages []Message
				if json.Unmarshal(stored.Body.Bytes(), &messages) != nil || len(messages) != 2 || messages[1].Content != text {
					t.Fatalf("stored answer: %s", stored.Body.String())
				}
			})
		}
	}
}

func TestChatPartialFailureIsNotSaved(t *testing.T) {
	for _, provider := range []string{"api"} {
		t.Run(provider, func(t *testing.T) {
			s, _ := imageFixture(t)
			nativeFakeAgent(t, s, "fail-after")
			res := request(t, s, "POST", "/api/documents/doc/chat", strings.NewReader(fmt.Sprintf(`{"provider":%q,"prompt":"test","context":"","attachments":["p1-b1"]}`, provider)))
			if !strings.Contains(res.Body.String(), "event: draft") || !strings.Contains(res.Body.String(), "event: error") || strings.Contains(res.Body.String(), "event: done") {
				t.Fatal(res.Body.String())
			}
			var count int
			if err := s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE document_id='doc'").Scan(&count); err != nil || count != 1 {
				t.Fatalf("partial assistant answer persisted: %d %v", count, err)
			}
		})
	}
}
