package interleaf

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestConnectionStages(t *testing.T) {
	var calls atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Write([]byte(`{"data":[]}`))
			return
		}
		calls.Add(1)
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		raw, _ := json.Marshal(body)
		if strings.Contains(string(raw), "image_url") {
			http.Error(w, "image input not supported", 400)
			return
		}
		writeAPIReply(w, "Sure — **INTERLEAF_OK**.")
	}))
	defer api.Close()
	s := testServer(t)
	configureNativeTest(t, s, api.URL, "test", false)
	text := request(t, s, "POST", "/api/ai/check", strings.NewReader(`{"role":"translation","model":"test"}`))
	var cap Capability
	if json.Unmarshal(text.Body.Bytes(), &cap) != nil || text.Code != 200 || !cap.Text || cap.Vision || calls.Load() != 1 {
		t.Fatal(text.Body.String(), calls.Load())
	}
	vision := request(t, s, "POST", "/api/ai/check", strings.NewReader(`{"role":"vision","model":"test"}`))
	if json.Unmarshal(vision.Body.Bytes(), &cap) != nil || vision.Code != 200 || !cap.Text || cap.Vision || cap.Error == "" || calls.Load() != 3 {
		t.Fatal(vision.Body.String(), calls.Load())
	}
}
func TestVisionProbeFormatting(t *testing.T) {
	expected := "RED BLUE GREEN YELLOW RED BLUE GREEN YELLOW"
	for _, answer := range []string{expected, "The colors are: red, blue, green, yellow, red, blue, green, yellow.", "1. RED\n2. BLUE\n3. GREEN\n4. YELLOW\n5. RED\n6. BLUE\n7. GREEN\n8. YELLOW"} {
		if !matchesVisionProbe(answer, expected) {
			t.Fatalf("valid image answer rejected: %q", answer)
		}
	}
	for _, answer := range []string{"INTERLEAF_OK", "I cannot see the image", "RED BLUE", expected + " RED", "YELLOW BLUE GREEN YELLOW RED BLUE GREEN YELLOW"} {
		if matchesVisionProbe(answer, expected) {
			t.Fatalf("invalid image answer accepted: %q", answer)
		}
	}
}

func TestConnectionProbeRejectsStaleResult(t *testing.T) {
	for _, change := range []string{"connection", "new-check"} {
		t.Run(change, func(t *testing.T) {
			s := testServer(t)
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					w.Write([]byte(`{"data":[]}`))
					return
				}
				s.configMu.Lock()
				stored, err := s.readNativeAIConfig()
				if err != nil {
					t.Error(err)
				}
				if change == "connection" {
					stored.Connection.Key = "replacement"
				} else {
					stored.Capabilities["api:test"] = Capability{Text: false, Error: "newer failure", CheckedAt: "newer", Fingerprint: nativeConfigPrint(stored.Connection, "test")}
				}
				err = s.writeNativeAIConfig(stored)
				s.configMu.Unlock()
				if err != nil {
					t.Error(err)
				}
				writeAPIReply(w, "INTERLEAF_OK")
			}))
			defer api.Close()
			configureNativeTest(t, s, api.URL, "test", false)
			w := request(t, s, "POST", "/api/ai/check", strings.NewReader(`{"role":"translation","model":"test"}`))
			if w.Code != 409 {
				t.Fatalf("stale result saved: %s", w.Body.String())
			}
		})
	}
}
