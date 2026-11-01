package interleaf

import (
	"testing"
)

func TestDocumentContextSources(t *testing.T) {
	for _, tc := range []struct {
		reported, manual, want int
		source                 string
	}{
		{872000, 0, 872000, "api_models"}, {872000, 32768, 32768, "manual_cap+api_models"}, {16384, 65536, 16384, "api_models"}, {0, 32768, 32768, "manual"}, {0, 0, 65536, "fallback_estimate"},
	} {
		n, source := resolveDocumentContext(tc.reported, tc.manual, "api_models")
		if n != tc.want || source != tc.source {
			t.Fatal(tc, n, source)
		}
	}
	_, a := originalDocumentFixture(t)
	if err := a.prepareReading(t.Context(), AIInput{Prompt: "question"}); err != nil {
		t.Fatal(err)
	}
	a.updateContextWindow(872000, 0, "api_models")
	if a.contextTokens != 872000 || a.sourceTokens < 600000 {
		t.Fatal("config ignored", a.contextTokens, a.sourceTokens)
	}
	a.updateContextWindow(256000, 12000, "api_runtime")
	if a.contextTokens != 256000 || a.runtimeUsedTokens != 12000 || a.contextSource != "api_runtime" {
		t.Fatal("runtime window ignored")
	}
}
func TestAPIContextMetadata(t *testing.T) {
	models, err := decodeAPIModels([]byte(`{"data":[{"id":"deepseek-v4-pro","context_window":1048576,"max_output_tokens":393216},{"id":"openrouter/model","context_length":256000,"top_provider":{"context_length":128000,"max_completion_tokens":16000}},{"id":"standard"}]}`))
	if err != nil || len(models) != 3 {
		t.Fatal(err)
	}
	if models[0].ContextWindow != 1048576 || models[0].MaxOutputTokens != 393216 || models[1].ContextWindow != 128000 || models[2].ContextWindow != 0 {
		t.Fatalf("model metadata lost: %+v", models)
	}
}
