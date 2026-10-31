package interleaf

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func nativeTestServer(t *testing.T) *Server {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DB.Close() })
	server := NewServer(store, "test-secret", "")
	t.Cleanup(server.Close)
	return server
}
func nativeUpdate(t *testing.T, raw string) NativeAIConfigUpdate {
	t.Helper()
	var update NativeAIConfigUpdate
	if err := json.Unmarshal([]byte(raw), &update); err != nil {
		t.Fatal(err)
	}
	return update
}

func TestNativeAIConfigMigrationAndKeyEdits(t *testing.T) {
	t.Run("API primary migrates roles secrets once without touching documents", func(t *testing.T) {
		s := nativeTestServer(t)
		catalog := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"data":[{"id":"changed-model"}]}`)) }))
		defer catalog.Close()
		old := []byte(strings.ReplaceAll(`{"config":{"primary":"api","api":{"protocol":"openai","url":"https://example.com/v1","key":"sk-test-secret"},"models":{"api":"chat-model"},"translationModels":{"api":"fast-model"},"visionModels":{"api":"vision-model"},"efforts":{"api":{"chat-model":"high"}},"translationPrompt":"keep terms","apiModels":["manual"],"capabilities":{}}}`, "https://example.com/v1", catalog.URL+"/v1"))
		path := filepath.Join(s.Store.Root, "ai-connections.json")
		if err := os.WriteFile(path, old, 0600); err != nil {
			t.Fatal(err)
		}
		historical := filepath.Join(s.Store.Root, "historical-notes-answers-translations.json")
		if err := os.WriteFile(historical, []byte("unchanged user data"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at) VALUES('legacy-doc','pdf','Paper','Author',123,'2026-10-20','2026-10-20');INSERT INTO messages(id,document_id,body,created_at) VALUES('answer','legacy-doc','{"text":"old answer"}','2026-10-20');INSERT INTO document_notes(document_id,body,updated_at) VALUES('legacy-doc','old note','2026-10-20');INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES('legacy-doc','p1-b1','hash','complete','{"text":"old translation"}')`); err != nil {
			t.Fatal(err)
		}
		config, err := s.nativeAIConfig()
		if err != nil {
			t.Fatal(err)
		}
		if config.Version != 2 || config.Models[taskChat] != "chat-model" || config.Models[taskTranslation] != "fast-model" || config.Models[taskVision] != "vision-model" || config.Efforts[taskChat] != "high" || !config.Connection.HasKey || config.NeedsConfiguration != "" {
			t.Fatalf("migration: %+v", config)
		}
		publicJSON, _ := json.Marshal(config)
		if bytes.Contains(publicJSON, []byte("sk-test-secret")) || bytes.Contains(publicJSON, []byte(`"key":`)) || !bytes.Contains(publicJSON, []byte(`"hasKey":true`)) {
			t.Fatal("public config exposes secret or loses marker", string(publicJSON))
		}
		backup, err := os.ReadFile(path + ".v1.bak")
		if err != nil || !bytes.Equal(backup, old) {
			t.Fatal("original backup missing", err)
		}
		for _, p := range []string{path, path + ".v1.bak"} {
			info, err := os.Stat(p)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("unprotected file", p, err)
			}
		}
		saved, err := s.saveNativeAIConfig(nativeUpdate(t, strings.ReplaceAll(`{"version":2,"connection":{"protocol":"openai","url":"https://example.com/v1/"},"models":{"chat":"changed-model","research":""}}`, "https://example.com/v1", catalog.URL+"/v1")))
		if err != nil {
			t.Fatal(err)
		}
		snap, err := s.resolveNativeTask(context.Background(), saved, taskResearch)
		if err != nil || snap.Model != "changed-model" || snap.Connection.Key != "sk-test-secret" {
			t.Fatal("same endpoint lost key or research inheritance", snap.Model, err)
		}
		changed, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"https://new.example/v1"},"models":{"chat":"changed-model"}}`))
		if err != nil {
			t.Fatal(err)
		}
		if changed.Connection.HasKey || changed.NeedsConfiguration == "" {
			t.Fatal("changed endpoint inherited key or activated implicitly")
		}
		if _, err = s.resolveNativeTask(context.Background(), changed, taskChat); err == nil {
			t.Fatal("pending endpoint can run")
		}
		cleared, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"http://localhost:11434/v1","key":null},"models":{"chat":"local"}}`))
		if err != nil || cleared.Connection.HasKey || cleared.NeedsConfiguration != "" {
			t.Fatal("explicit keyless endpoint rejected", err)
		}
		restarted := NewServer(s.Store, "test", "")
		if _, err := restarted.nativeAIConfig(); err != nil {
			t.Fatal(err)
		}
		backup, _ = os.ReadFile(path + ".v1.bak")
		if !bytes.Equal(backup, old) {
			t.Fatal("backup replaced on restart")
		}
		body, _ := os.ReadFile(historical)
		if string(body) != "unchanged user data" {
			t.Fatal("migration modified historical data")
		}
		for table, want := range map[string]string{"messages": `{"text":"old answer"}`, "document_notes": "old note", "translations": `{"text":"old translation"}`} {
			var got string
			if err := s.Store.DB.QueryRow("SELECT body FROM " + table + " WHERE document_id='legacy-doc'").Scan(&got); err != nil || got != want {
				t.Fatal("historical record changed", table, got, err)
			}
		}
	})
	for _, tc := range []struct {
		name, raw string
		pending   bool
		url       string
	}{
		{"sole text without primary", `{"config":{"textAPI":{"url":"https://text.example/v1","model":"text","key":"sk-test-secret"}}}`, false, "https://text.example/v1"},
		{"CLI with text candidate", `{"config":{"primary":"codex","textAPI":{"url":"https://text.example/v1","model":"text","key":"sk-test-secret"}}}`, true, "https://text.example/v1"},
		{"conflicting backups", `{"config":{"textAPI":{"url":"https://text.example/v1","model":"text"},"imageAPI":{"url":"https://vision.example/v1","model":"vision"}}}`, true, ""},
		{"CLI only", `{"config":{"primary":"claude"}}`, true, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := nativeTestServer(t)
			path := filepath.Join(s.Store.Root, "ai-connections.json")
			os.WriteFile(path, []byte(tc.raw), 0600)
			c, err := s.nativeAIConfig()
			if err != nil {
				t.Fatal(err)
			}
			if (c.NeedsConfiguration != "") != tc.pending || c.Connection.URL != tc.url {
				t.Fatalf("unexpected migration %+v", c)
			}
			if tc.pending && s.aiConfig().Primary != "" {
				t.Fatal("legacy generation bridge enabled paid backup")
			}
			disk, _ := os.ReadFile(path)
			if bytes.Contains([]byte(tc.raw), []byte("sk-test-secret")) && !bytes.Contains(disk, []byte("sk-test-secret")) {
				t.Fatal("migration discarded candidate key")
			}
		})
	}
	t.Run("malformed legacy preserved", func(t *testing.T) {
		s := nativeTestServer(t)
		path := filepath.Join(s.Store.Root, "ai-connections.json")
		old := []byte(`{"config":`)
		os.WriteFile(path, old, 0600)
		if _, err := s.nativeAIConfig(); err == nil {
			t.Fatal("corruption silently reset")
		}
		body, _ := os.ReadFile(path)
		if !bytes.Equal(body, old) {
			t.Fatal("original damaged")
		}
	})
	t.Run("write failure preserves original", func(t *testing.T) {
		s := nativeTestServer(t)
		path := filepath.Join(s.Store.Root, "ai-connections.json")
		old := []byte(`{"config":{"primary":"api","api":{"url":"https://example.com/v1","key":"sk-test-secret"}}}`)
		os.WriteFile(path, old, 0600)
		os.Mkdir(path+".v1.bak", 0700)
		if _, err := s.nativeAIConfig(); err == nil {
			t.Fatal("backup failure ignored")
		}
		body, _ := os.ReadFile(path)
		if !bytes.Equal(body, old) {
			t.Fatal("original overwritten on migration failure")
		}
	})
}

func TestNativeAIConfigRolesAndModelBoundaries(t *testing.T) {
	requests := 0
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer sk-test-secret" {
			t.Error("key not supplied to explicit endpoint")
		}
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[{"id":"model","context_window":32000}]}`))
			return
		}
		w.WriteHeader(400)
		w.Write([]byte(`{"error":{"message":"sk-test-secret upstream error"}}`))
	}))
	defer endpoint.Close()
	s := nativeTestServer(t)
	raw := `{"version":2,"connection":{"protocol":"openai","url":"` + endpoint.URL + `/v1","key":"sk-test-secret"},"models":{"chat":"model"}}`
	w := request(t, s, "PUT", "/api/ai/config", bytes.NewBufferString(raw))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if requests != 0 {
		t.Fatal("save automatically called model")
	}
	w = request(t, s, "GET", "/api/ai/models?role=research", nil)
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"model"`)) {
		t.Fatal("localhost catalog rejected", w.Code, w.Body.String())
	}
	for _, path := range []string{"/api/ai/models?provider=codex", "/api/ai/models?role=invalid"} {
		if w := request(t, s, "GET", path, nil); w.Code != 400 {
			t.Fatal("legacy provider or invalid role accepted", path, w.Code)
		}
	}
	for _, body := range []string{`{"provider":"codex"}`, `{"role":"chat","waitSeconds":0}`, `{"role":"chat","waitSeconds":61}`} {
		if w := request(t, s, "POST", "/api/ai/check", bytes.NewBufferString(body)); w.Code != 400 {
			t.Fatal("invalid check accepted", body, w.Code)
		}
	}
	w = request(t, s, "POST", "/api/ai/check", bytes.NewBufferString(`{"role":"chat","model":"model","waitSeconds":1}`))
	if bytes.Contains(w.Body.Bytes(), []byte("sk-test-secret")) {
		t.Fatal("probe error leaks secret", w.Body.String())
	}
	if w.Code != 200 {
		t.Fatal("probe failed to report capability", w.Code, w.Body.String())
	}
}

func TestNativeAIConfigResolveRoleSnapshot(t *testing.T) {
	catalogRequests := 0
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		catalogRequests++
		w.Write([]byte(`{"data":[{"id":"model-pro","context_window":32000,"max_output_tokens":4000},{"id":"model-flash"}]}`))
	}))
	defer endpoint.Close()
	s := nativeTestServer(t)
	config, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`/v1","key":"sk-test-secret"},"models":{"chat":"model-pro"},"efforts":{"chat":"high"}}`))
	if err != nil {
		t.Fatal(err)
	}
	chat, err := s.resolveNativeTask(context.Background(), config, taskChat)
	if err != nil {
		t.Fatal(err)
	}
	research, err := s.resolveNativeTask(context.Background(), config, taskResearch)
	if err != nil {
		t.Fatal(err)
	}
	translation, err := s.resolveNativeTask(context.Background(), config, taskTranslation)
	if err != nil {
		t.Fatal(err)
	}
	if chat.Model != "model-pro" || research.Model != "model-pro" || research.Effort != "high" || translation.Model != "model-flash" || chat.ContextWindow != 32000 || chat.MaxOutputTokens != 4000 || chat.Vision || chat.Tools {
		t.Fatal("invalid role resolution", chat.Model, research.Model, research.Effort, translation.Model)
	}
	if _, err := s.resolveNativeTask(context.Background(), config, taskVision); err == nil {
		t.Fatal("unverified chat model used for vision")
	}
	if catalogRequests != 1 {
		t.Fatal("catalog not cached per connection", catalogRequests)
	}
	stored, err := s.readNativeAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	bridge := nativeLegacyView(stored)
	stored.Capabilities["api:model-pro"] = Capability{Text: true, Vision: true, Tools: "passed", ToolSchemaVersion: documentToolSchemaVersion, Fingerprint: configPrint(bridge, "api:model-pro")}
	if err := s.writeNativeAIConfig(stored); err != nil {
		t.Fatal(err)
	}
	vision, err := s.resolveNativeTask(context.Background(), config, taskVision)
	if err != nil || vision.Model != "model-pro" || !vision.Vision || !vision.Tools {
		t.Fatal("verified model was not reused", err)
	}
	oldFingerprint := vision.Fingerprint
	updated, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`/v1","key":"replacement-secret"},"models":{"chat":"custom-id"}}`))
	if err != nil {
		t.Fatal(err)
	}
	next, err := s.resolveNativeTask(context.Background(), updated, taskChat)
	if err != nil || next.Model != "custom-id" || next.Vision || next.Tools || next.Fingerprint == oldFingerprint {
		t.Fatal("custom choice or capability invalidation failed", err)
	}
	if chat.Connection.Key != "sk-test-secret" || next.Connection.Key != "replacement-secret" {
		t.Fatal("snapshot secret was mutated by later save")
	}
	if _, err := s.resolveNativeTask(context.Background(), config, taskChat); err == nil {
		t.Fatal("stale public snapshot resolved with new key")
	}
}

func TestNativeAIConfigNormalizedIdentity(t *testing.T) {
	s := nativeTestServer(t)
	old := AIConfig{Primary: "api", API: APIConnection{URL: "https://EXAMPLE.test:443/v1/", Key: "sk-test-secret", Protocol: "auto"}, Models: map[string]string{"api": "custom"}, Capabilities: map[string]Capability{}}
	old.Capabilities["api:custom"] = Capability{Text: true, Vision: true, CheckedAt: "2026-10-21", Fingerprint: configPrint(old, "api:custom")}
	raw, _ := json.Marshal(savedConfig{Config: old, Fingerprints: map[string]string{"api:custom": old.Capabilities["api:custom"].Fingerprint}})
	os.WriteFile(s.nativeAIPath(), raw, 0600)
	config, err := s.nativeAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !capable(s.aiConfig(), "api:custom", true) {
		t.Fatal("valid legacy verification was lost while normalizing the same endpoint")
	}
	config, err = s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"https://example.test/v1"}}`))
	if err != nil || !config.Connection.HasKey || config.NeedsConfiguration != "" {
		t.Fatal("equivalent endpoint did not preserve key", err)
	}
	config, err = s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"anthropic","url":"https://example.test/v1"}}`))
	if err != nil || config.Connection.HasKey || config.NeedsConfiguration == "" {
		t.Fatal("protocol switch reused a key", err)
	}
}

func TestNativeAIConfigPrivateBridgeWritesCanonicalRoles(t *testing.T) {
	s := nativeTestServer(t)
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"https://example.test/v1","key":"sk-test-secret"},"models":{"chat":"model","research":"research"},"efforts":{"research":"high"}}`))
	if err != nil {
		t.Fatal(err)
	}
	bridge := s.aiConfig()
	bridge.API.Key = "changed-secret"
	bridge.TranslationModels["api"] = "fast"
	if err := s.writeAIConfig(bridge); err != nil {
		t.Fatal(err)
	}
	config, err := s.nativeAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Models[taskTranslation] != "fast" || config.Models[taskResearch] != "research" || config.Efforts[taskResearch] != "high" || s.aiConfig().API.Key != "changed-secret" {
		t.Fatal("private bridge failed canonical role/key update")
	}
}

func TestNativeAIConfigOnlyExplicitCheckEnablesTools(t *testing.T) {
	postCalls := 0
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Write([]byte(`{"data":[{"id":"model"}]}`))
			return
		}
		postCalls++
		var body struct {
			Messages []toolCompletionMessage `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if strings.Contains(jsonText(body.Messages), "Call interleaf_probe once") {
			if body.Messages[len(body.Messages)-1].Role == "tool" {
				writeAPIReply(w, body.Messages[len(body.Messages)-1].Content.(string))
			} else {
				writeToolReply(w, "interleaf_probe", "{}")
			}
			return
		}
		writeAPIReply(w, "INTERLEAF_OK")
	}))
	defer endpoint.Close()
	s := nativeTestServer(t)
	config, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":null},"models":{"chat":"model"}}`))
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := s.readNativeAIConfig()
	stored.Capabilities["api:model"] = Capability{Text: true, Vision: true, Fingerprint: configPrint(nativeLegacyView(stored), "api:model")}
	s.writeNativeAIConfig(stored)
	snapshot, err := s.resolveNativeTask(t.Context(), config, taskChat)
	if err != nil || snapshot.Tools || postCalls != 0 {
		t.Fatal("configuration or resolution ran an inference probe", err)
	}
	w := request(t, s, "POST", "/api/ai/check", strings.NewReader(`{"role":"chat","waitSeconds":1}`))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	snapshot, err = s.resolveNativeTask(t.Context(), config, taskChat)
	if err != nil || !snapshot.Tools || !snapshot.Vision || postCalls != 3 {
		t.Fatal("explicit check failed to enable tools or lost verified vision", snapshot.Tools, snapshot.Vision, postCalls, err)
	}
}

func TestNativeAIConfigSoleTextBackupKeepsVerification(t *testing.T) {
	s := nativeTestServer(t)
	old := AIConfig{TextAPI: APIConnection{Protocol: "openai", URL: "https://text.example/v1", Model: "text-model", Key: "sk-test-secret"}, Capabilities: map[string]Capability{}}
	old.Capabilities["text-api"] = Capability{Text: true, CheckedAt: "2026-10-20", Fingerprint: configPrint(old, "text-api")}
	raw, _ := json.Marshal(savedConfig{Config: old, Fingerprints: map[string]string{"text-api": old.Capabilities["text-api"].Fingerprint}})
	os.WriteFile(s.nativeAIPath(), raw, 0600)
	config, err := s.nativeAIConfig()
	if err != nil || config.NeedsConfiguration != "" || !capable(s.aiConfig(), "api:text-model", false) {
		t.Fatal("sole verified text connection requires an unnecessary new paid probe", err)
	}
	other := nativeTestServer(t)
	old.ImageAPI = old.TextAPI
	old.Capabilities["image-api"] = Capability{Text: true, Vision: true, CheckedAt: "2026-10-21"}
	raw, _ = json.Marshal(savedConfig{Config: old, Fingerprints: map[string]string{"text-api": configPrint(old, "text-api"), "image-api": configPrint(old, "image-api")}})
	os.WriteFile(other.nativeAIPath(), raw, 0600)
	if _, err := other.nativeAIConfig(); err != nil || !capable(other.aiConfig(), "api:text-model", true) {
		t.Fatal("same-model legacy image observation lost", err)
	}
}

func TestNativeAIConfigDefaultsExcludeFailedModels(t *testing.T) {
	for _, tc := range []struct {
		name         string
		role         modelTask
		failed, want string
	}{
		{"chat preferred family failed", taskChat, "model-pro", "model-flash"},
		{"translation fast family failed", taskTranslation, "model-flash", "model-pro"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`{"data":[{"id":"model-pro"},{"id":"model-flash"}]}`))
			}))
			defer endpoint.Close()
			s := nativeTestServer(t)
			config, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":null}}`))
			if err != nil {
				t.Fatal(err)
			}
			stored, err := s.readNativeAIConfig()
			if err != nil {
				t.Fatal(err)
			}
			bridge := nativeLegacyView(stored)
			stored.Capabilities[apiCapabilityKey(tc.failed)] = Capability{Text: false, CheckedAt: "failed", Fingerprint: configPrint(bridge, apiCapabilityKey(tc.failed))}
			stored.Capabilities[apiCapabilityKey(tc.want)] = Capability{Text: true, CheckedAt: "passed", Fingerprint: configPrint(bridge, apiCapabilityKey(tc.want))}
			if err := s.writeNativeAIConfig(stored); err != nil {
				t.Fatal(err)
			}
			catalog, err := s.apiAgentModels(t.Context(), s.aiConfig())
			if err != nil {
				t.Fatal(err)
			}
			recommended := ""
			for _, model := range catalog {
				for _, role := range model.RecommendedFor {
					if role == string(tc.role) {
						recommended = model.ID
					}
				}
			}
			if recommended != tc.want {
				t.Fatal("catalog recommendation", recommended, "want", tc.want)
			}
			snapshot, err := s.resolveNativeTask(t.Context(), config, tc.role)
			if err != nil || snapshot.Model != tc.want {
				t.Fatal("default snapshot disagrees with available recommendation", snapshot.Model, tc.want, err)
			}
			update := nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`"},"models":{"chat":"hand-entered","translation":"`+tc.failed+`"}}`)
			manual, err := s.saveNativeAIConfig(update)
			if err != nil {
				t.Fatal(err)
			}
			for role, want := range map[modelTask]string{taskChat: "hand-entered", taskTranslation: tc.failed} {
				snap, err := s.resolveNativeTask(t.Context(), manual, role)
				if err != nil || snap.Model != want {
					t.Fatal("explicit model was replaced", snap.Model, want, err)
				}
			}
		})
	}
}
