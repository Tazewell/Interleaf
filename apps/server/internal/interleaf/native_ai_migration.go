package interleaf

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Secrets and migration candidates never cross the public config boundary.
type nativeAIStored struct {
	Version      int                   `json:"version"`
	Config       NativeAIConfig        `json:"config"`
	Connection   APIConnection         `json:"connection"`
	Capabilities map[string]Capability `json:"capabilities"`
	Fingerprints map[string]string     `json:"fingerprints"`
	Candidates   []APIConnection       `json:"migrationCandidates,omitempty"`
}

func emptyNativeAIStored() nativeAIStored {
	return nativeAIStored{Version: 2, Config: NativeAIConfig{Version: 2, Connection: NativeAIConnection{Protocol: "openai"}, Models: map[modelTask]string{}, Efforts: map[modelTask]string{}, APIModels: []string{}, NeedsConfiguration: "请填写 API 地址和问答模型"}, Connection: APIConnection{Protocol: "openai"}, Capabilities: map[string]Capability{}, Fingerprints: map[string]string{}}
}
func (s *Server) nativeAIPath() string { return filepath.Join(s.Store.Root, "ai-connections.json") }
func (s *Server) readNativeAIConfig() (nativeAIStored, error) {
	path := s.nativeAIPath()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return emptyNativeAIStored(), nil
	}
	if err != nil {
		return nativeAIStored{}, err
	}
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return nativeAIStored{}, err
	}
	if header.Version == 2 {
		var stored nativeAIStored
		if err := json.Unmarshal(data, &stored); err != nil {
			return stored, err
		}
		if stored.Config.Version != 2 || stored.Config.Models == nil || stored.Config.Efforts == nil {
			return stored, errors.New("AI 配置损坏")
		}
		if stored.Capabilities == nil {
			stored.Capabilities = map[string]Capability{}
		}
		for key, cap := range stored.Capabilities {
			cap.Fingerprint = stored.Fingerprints[key]
			if cap.ToolSchemaVersion != documentToolSchemaVersion {
				cap.Tools = ""
				cap.ToolError = ""
			}
			stored.Capabilities[key] = cap
		}
		stored.Config.Connection.HasKey = stored.Connection.Key != ""
		return stored, nil
	}
	if header.Version != 0 && header.Version != 1 {
		return nativeAIStored{}, errors.New("未知的 AI 配置版本")
	}
	var legacy savedConfig
	if err := json.Unmarshal(data, &legacy); err != nil {
		return nativeAIStored{}, err
	}
	// A syntactically valid but unrelated file is not a reason to erase user data.
	var envelope map[string]json.RawMessage
	json.Unmarshal(data, &envelope)
	if _, ok := envelope["config"]; !ok {
		return nativeAIStored{}, errors.New("旧 AI 配置缺少 config")
	}
	stored := migrateNativeAIConfig(legacy)
	backup := path + ".v1.bak"
	if _, err := os.Stat(backup); errors.Is(err, os.ErrNotExist) {
		if err := atomicFile(backup, data); err != nil {
			return nativeAIStored{}, err
		}
	} else if err != nil {
		return nativeAIStored{}, err
	} else {
		info, err := os.Stat(backup)
		if err != nil || !info.Mode().IsRegular() {
			return nativeAIStored{}, errors.New("旧 AI 配置备份不可用")
		}
	}
	if err := os.Chmod(backup, 0600); err != nil {
		return nativeAIStored{}, err
	}
	if err := s.writeNativeAIConfig(stored); err != nil {
		return nativeAIStored{}, err
	}
	return stored, nil
}
func migrateNativeAIConfig(legacy savedConfig) nativeAIStored {
	stored := emptyNativeAIStored()
	old := legacy.Config
	normalized := func(c APIConnection) APIConnection {
		if c.Protocol == "" || c.Protocol == "auto" {
			c.Protocol = resolveAPIEndpoint(c).Protocol
		}
		c.URL = normalizeNativeURL(c.URL)
		c.HasKey = false
		return c
	}
	api, text, vision := normalized(old.API), normalized(old.TextAPI), normalized(old.ImageAPI)
	for _, c := range []APIConnection{api, text, vision} {
		if c.URL != "" {
			stored.Candidates = append(stored.Candidates, c)
		}
	}
	selected := APIConnection{Protocol: "openai"}
	active := false
	if old.Primary == "api" && api.URL != "" {
		selected = api
		active = true
	} else if api.URL != "" {
		selected = api
	} else if text.URL != "" && (vision.URL == "" || vision.URL == text.URL && vision.Protocol == text.Protocol && vision.Key == text.Key) {
		selected = text
		active = old.Primary == ""
	}
	stored.Connection = selected
	stored.Connection.Model = ""
	stored.Config.Connection = NativeAIConnection{Protocol: selected.Protocol, URL: selected.URL, HasKey: selected.Key != ""}
	stored.Config.APIModels = old.APIModels
	if stored.Config.APIModels == nil {
		stored.Config.APIModels = []string{}
	}
	stored.Config.TranslationPrompt = old.TranslationPrompt
	if selected.URL == api.URL && selected.URL != "" {
		for role, models := range map[modelTask]map[string]string{taskChat: old.Models, taskTranslation: old.TranslationModels, taskVision: old.VisionModels} {
			stored.Config.Models[role] = models["api"]
			efforts := old.Efforts
			if role == taskTranslation {
				efforts = old.TranslationEfforts
			}
			if role == taskVision {
				efforts = old.VisionEfforts
			}
			if e := efforts["api"][models["api"]]; e != "" {
				stored.Config.Efforts[role] = e
			}
		}
	} else if selected.URL != "" {
		stored.Config.Models[taskChat] = text.Model
		stored.Config.Models[taskTranslation] = text.Model
		if vision.URL == selected.URL && vision.Protocol == selected.Protocol {
			stored.Config.Models[taskVision] = vision.Model
		}
	}
	if active {
		stored.Config.NeedsConfiguration = ""
	} else {
		stored.Config.NeedsConfiguration = "请确认主要 API 连接和模型；旧连接仅作为候选保留"
	}
	if active {
		for key, cap := range old.Capabilities {
			cap.Fingerprint = legacy.Fingerprints[key]
			if strings.HasPrefix(key, "api:") && cap.Fingerprint == configPrint(old, key) {
				cap.Fingerprint = nativeConfigPrint(stored.Connection, strings.TrimPrefix(key, "api:"))
				stored.Capabilities[key] = cap
			}
		}
		// A sole legacy text connection already passed its text probe. Preserve
		// that observation at the same endpoint/model without a paid recheck.
		for _, entry := range []struct {
			key        string
			connection APIConnection
		}{{"text-api", text}, {"image-api", vision}} {
			candidate := entry.connection
			if candidate.URL != selected.URL || candidate.Protocol != selected.Protocol || candidate.Key != selected.Key || candidate.Model == "" {
				continue
			}
			cap, ok := old.Capabilities[entry.key]
			if !ok || legacy.Fingerprints[entry.key] != configPrint(old, entry.key) {
				continue
			}
			key := apiCapabilityKey(candidate.Model)
			if previous, exists := stored.Capabilities[key]; exists {
				// Text and image checks used separate legacy slots even when
				// they selected the same model. Keep the newer image observation.
				if cap.Text && cap.Vision && previous.Text && cap.CheckedAt > previous.CheckedAt {
					previous.Vision = true
					previous.VisionFirstOutputMs = cap.VisionFirstOutputMs
					stored.Capabilities[key] = previous
				}
				continue
			}
			cap.Fingerprint = nativeConfigPrint(stored.Connection, strings.TrimPrefix(key, "api:"))
			stored.Capabilities[key] = cap
		}
	}
	return stored
}
func (s *Server) writeNativeAIConfig(stored nativeAIStored) error {
	stored.Version = 2
	stored.Config.Version = 2
	stored.Fingerprints = map[string]string{}
	for key, cap := range stored.Capabilities {
		stored.Fingerprints[key] = cap.Fingerprint
	}
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return err
	}
	return atomicFile(s.nativeAIPath(), data)
}
