package reader

import (
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConnectionSecretsAndFingerprint(t *testing.T) {
	s := testServer(t)
	cfg, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"https://example.com/v1","key":"private-value"},"models":{"chat":"model-a"}}`))
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := json.Marshal(cfg)
	if bytes.Contains(pub, []byte("private-value")) || !bytes.Contains(pub, []byte(`"hasKey":true`)) {
		t.Fatal("secret exposed or marker missing")
	}
	stored, err := s.readNativeAIConfig()
	if err != nil {
		t.Fatal(err)
	}
	before := nativeConfigPrint(stored.Connection, "model-a")
	if before == nativeConfigPrint(stored.Connection, "model-b") {
		t.Fatal("model fingerprint unchanged")
	}
	stored.Connection.Key = "replacement"
	if before == nativeConfigPrint(stored.Connection, "model-a") {
		t.Fatal("key fingerprint unchanged")
	}
	info, e := os.Stat(filepath.Join(s.Store.Root, "ai-connections.json"))
	if e != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatal("config permissions", e)
	}
}

func TestVisionProbe(t *testing.T) {
	b, expected, e := visionProbe()
	if e != nil {
		t.Fatal(e)
	}
	im, e := png.Decode(bytes.NewReader(b))
	if e != nil {
		t.Fatal(e)
	}
	words := strings.Fields(expected)
	if len(words) != 8 {
		t.Fatal(expected)
	}
	for i, w := range words {
		r, g, b, _ := im.At(i*100+50, 70).RGBA()
		actual := ""
		switch {
		case r > 50000 && g > 40000:
			actual = "YELLOW"
		case r > 50000:
			actual = "RED"
		case b > 50000:
			actual = "BLUE"
		case g > 30000:
			actual = "GREEN"
		}
		if w != actual {
			t.Fatalf("tile %d: %s vs %s", i, w, actual)
		}
	}
}

func TestFallbackAndCancellation(t *testing.T) {
	s := testServer(t)
	nativeFakeAgent(t, s, "fail-before")
	service := s.currentGenerationService(taskChat)
	result, err := service.Generate(t.Context(), AIInput{Prompt: "test"}, false, func(e ProviderEvent) error {
		if e.Fallback != "" {
			t.Error("fallback emitted")
		}
		return nil
	})
	if err == nil || result.Fallback {
		t.Fatal("quota failure did not remain on selected model")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err = service.Generate(ctx, AIInput{Prompt: "cancelled"}, false, nil); err == nil {
		t.Fatal("cancelled request succeeded")
	}
}
