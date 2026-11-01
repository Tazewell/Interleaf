package interleaf

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func catalog(ids ...string) []AgentModel {
	models := []AgentModel{}
	for i, id := range ids {
		models = append(models, AgentModel{ID: id, Name: id, Default: i == 0})
	}
	return models
}

func TestDefaultNativeTaskModels(t *testing.T) {
	for _, tc := range []struct {
		role modelTask
		ids  []string
		want string
	}{
		{taskChat, []string{"model-pro-2", "model-pro-3"}, "model-pro-3"},
		{taskTranslation, []string{"model-pro", "model-flash"}, "model-flash"},
		{taskTranslation, []string{"gpt-7-codex-mini", "gpt-6-mini"}, "gpt-6-mini"},
		{taskTranslation, []string{"gemini-pro", "lunar-x"}, ""},
		{taskVision, []string{"model-pro", "model-vision"}, "model-vision"},
	} {
		if got := defaultTaskModel(tc.role, catalog(tc.ids...)); got != tc.want {
			t.Fatal(tc, got)
		}
	}
}

func TestTranslationModelAndEffortAreIndependent(t *testing.T) {
	s := testServer(t)
	body := `{"version":2,"connection":{"protocol":"openai","url":"http://127.0.0.1:1","key":null},"models":{"chat":"chat-model","translation":"fast-model"},"efforts":{"chat":"max","translation":"low"}}`
	if r := request(t, s, "PUT", "/api/ai/config", strings.NewReader(body)); r.Code != 200 {
		t.Fatal(r.Body)
	}
	saved, err := s.nativeAIConfig()
	if err != nil || saved.Models[taskTranslation] != "fast-model" || saved.Efforts[taskTranslation] != "low" || saved.Efforts[taskChat] != "max" {
		t.Fatal(saved, err)
	}
	if r := request(t, s, "PUT", "/api/ai/config", strings.NewReader(strings.Replace(body, `"low"`, `"ultra"`, 1))); r.Code != 400 {
		t.Fatal(r.Body)
	}

}

func TestTranslationFailureKeepsChatCapability(t *testing.T) {
	s := testServer(t)
	configureNativeTest(t, s, "http://127.0.0.1:1", "model", false)
	c := s.aiConfig()
	for _, task := range []modelTask{taskTranslation, taskChat} {
		service := s.taskGenerationService(c, task)
		connection := service.connections["api"]
		connection.Adapter = adapterFunc(func(context.Context, GenerateRequest, func(ProviderEvent) error) (GenerateResult, error) {
			return GenerateResult{}, errors.New("unknown model")
		})
		service.connections["api"] = connection
		_, _ = service.Generate(t.Context(), AIInput{Prompt: "test"}, false, nil)
		if !capable(s.aiConfig(), "api:model", false) {
			t.Fatalf("%s runtime failure disabled verified chat capability", task)
		}
	}
}

func TestModelVersion(t *testing.T) {
	for id, want := range map[string]string{
		"gpt-6.1-sol":                "[6 1]",
		"gpt-6-sol-2026-01-15":       "[6]",
		"claude-haiku-4-5-20251001":  "[4 5]",
		"claude-3-5-sonnet-20241022": "[3 5]",
		"moonshot-cn/kimi-k2.7-code": "[2 7]",
	} {
		if got := fmt.Sprint(modelVersion(id)); got != want {
			t.Fatalf("%s: got %s want %s", id, got, want)
		}
	}
}
