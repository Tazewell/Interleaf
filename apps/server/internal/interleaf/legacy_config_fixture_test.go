package interleaf

import (
	"context"
	"encoding/json"
	"strings"
)

func nativeLegacyView(stored nativeAIStored) AIConfig {
	c := AIConfig{Primary: "api", API: stored.Connection, Models: map[string]string{"api": stored.Config.Models[taskChat]}, TranslationModels: map[string]string{"api": stored.Config.Models[taskTranslation]}, VisionModels: map[string]string{"api": stored.Config.Models[taskVision]}, Efforts: map[string]map[string]string{}, TranslationEfforts: map[string]map[string]string{}, VisionEfforts: map[string]map[string]string{}, APIModels: stored.Config.APIModels, TranslationPrompt: stored.Config.TranslationPrompt, Capabilities: stored.Capabilities}
	for role, field := range map[modelTask]map[string]map[string]string{taskChat: c.Efforts, taskTranslation: c.TranslationEfforts, taskVision: c.VisionEfforts} {
		field["api"] = map[string]string{stored.Config.Models[role]: stored.Config.Efforts[role]}
	}
	if stored.Config.NeedsConfiguration != "" {
		c.Primary = ""
		c.API = APIConnection{}
		c.Capabilities = map[string]Capability{}
	}
	if c.Capabilities == nil {
		c.Capabilities = map[string]Capability{}
	}
	return c
}
func (s *Server) aiConfig() AIConfig {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	return s.readAIConfig()
}

// Test-only conversion preserves old protocol fixtures while production accepts only v2.
func (s *Server) readAIConfig() AIConfig {
	stored, err := s.readNativeAIConfig()
	if err != nil {
		return nativeLegacyView(emptyNativeAIStored())
	}
	return nativeLegacyView(stored)
}

// Test fixtures always write the native v2 store; migration itself is tested separately.
func (s *Server) writeAIConfig(c AIConfig) error {
	stored, err := s.readNativeAIConfig()
	if err != nil {
		return err
	}
	view := nativeLegacyView(stored)
	comparable := c
	comparable.Capabilities = nil
	view.Capabilities = nil
	incoming, _ := json.Marshal(comparable)
	current, _ := json.Marshal(view)
	if string(incoming) != string(current) {
		// Private callers write through the same v2 source; public handlers never accept AIConfig.
		fingerprints := map[string]string{}
		for key, cap := range c.Capabilities {
			fingerprints[key] = cap.Fingerprint
		}
		migrated := migrateNativeAIConfig(savedConfig{Config: c, Fingerprints: fingerprints})
		if model, ok := stored.Config.Models[taskResearch]; ok {
			migrated.Config.Models[taskResearch] = model
		}
		if effort, ok := stored.Config.Efforts[taskResearch]; ok {
			migrated.Config.Efforts[taskResearch] = effort
		}
		if len(stored.Candidates) > 0 {
			migrated.Candidates = stored.Candidates
		}
		stored = migrated
	} else {
		stored.Capabilities = c.Capabilities
	}
	return s.writeNativeAIConfig(stored)
}

// apiTaskModel is the user's choice for a task; empty means automatic.
func apiTaskModel(c AIConfig, task modelTask, vision bool) string {
	if vision {
		return c.VisionModels["api"]
	}
	if task == taskTranslation {
		return c.TranslationModels["api"]
	}
	return c.Models["api"]
}

// apiCapable reports whether the API agent can serve a task: the chosen model
// passed its check or, with no choice, some checked model passed.
func apiCapable(c AIConfig, task modelTask, vision bool) bool {
	if model := apiTaskModel(c, task, vision); model != "" {
		return capable(c, apiCapabilityKey(model), vision)
	}
	for key := range c.Capabilities {
		if strings.HasPrefix(key, "api:") && capable(c, key, vision) {
			return true
		}
	}
	return false
}

// primaryCapable reports whether the primary agent passed the text check
// for a task. Only the API agent picks models by its own per-model checks.
func primaryCapable(c AIConfig, task modelTask) bool {
	if c.Primary == "api" {
		return apiCapable(c, task, false)
	}
	return capable(c, c.Primary, false)
}

func (s *Server) apiAgentAdapter(c AIConfig, task modelTask) apiAgentAdapter {
	models, efforts := c.Models, c.Efforts
	if task == taskTranslation {
		models, efforts = c.TranslationModels, c.TranslationEfforts
	}
	choice := func(models map[string]string, efforts map[string]map[string]string) apiModelChoice {
		model := models["api"]
		level := efforts["api"][model]
		if level == "" {
			level = "medium"
		}
		return apiModelChoice{model, level}
	}
	return apiAgentAdapter{c.API, choice(models, efforts), choice(c.VisionModels, c.VisionEfforts), task, func(ctx context.Context) ([]AgentModel, error) {
		return s.apiAgentModels(ctx, c)
	}}
}

func (s *Server) apiAgentModels(ctx context.Context, c AIConfig) ([]AgentModel, error) {
	return s.nativeAIModels(ctx, fixtureNativeStored(c))
}
func (s *Server) generationService(c AIConfig) *GenerationService {
	return s.taskGenerationService(c, taskChat)
}
func (s *Server) taskGenerationService(c AIConfig, task modelTask) *GenerationService {
	snapshot, err := s.resolveNativeStoredTask(context.Background(), fixtureNativeStored(c), task)
	if err != nil {
		return &GenerationService{initialError: err}
	}
	if task != taskTranslation {
		c.TranslationPrompt = nil
	}
	return s.nativeSnapshotService(snapshot, c.TranslationPrompt)
}
func (s *Server) translationService(c AIConfig) (*GenerationService, *nativeTranslationSession) {
	snapshot, err := s.resolveNativeStoredTask(context.Background(), fixtureNativeStored(c), taskTranslation)
	if err != nil {
		return &GenerationService{initialError: err}, &nativeTranslationSession{apiTranslationSession: &apiTranslationSession{}, server: s}
	}
	return s.nativeTranslationService(snapshot, c.TranslationPrompt)
}
func capable(c AIConfig, p string, vision bool) bool {
	if p == "api" {
		return apiCapable(c, taskChat, false) && (!vision || apiCapable(c, taskChat, true))
	}
	v := c.Capabilities[p]
	return v.Fingerprint == configPrint(c, p) && v.Text && (!vision || v.Vision)
}
func publicConfig(c AIConfig) AIConfig {
	c.API.HasKey = c.API.Key != ""
	c.API.Key = ""
	c.TextAPI.HasKey = c.TextAPI.Key != ""
	c.TextAPI.Key = ""
	c.ImageAPI.HasKey = c.ImageAPI.Key != ""
	c.ImageAPI.Key = ""
	return c
}

// Preserve every saved capability fingerprint when translating old test data.
func fixtureNativeStored(c AIConfig) nativeAIStored {
	prints := map[string]string{}
	for key, cap := range c.Capabilities {
		prints[key] = cap.Fingerprint
	}
	return migrateNativeAIConfig(savedConfig{Config: c, Fingerprints: prints})
}
