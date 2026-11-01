package interleaf

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type APIConnection struct {
	Protocol string `json:"protocol,omitempty"`
	URL      string `json:"url"`
	Model    string `json:"model"`
	Key      string `json:"key,omitempty"`
	HasKey   bool   `json:"hasKey"`
}
type Capability struct {
	TextFirstOutputMs   *int64 `json:"textFirstOutputMs,omitempty"`
	VisionFirstOutputMs *int64 `json:"visionFirstOutputMs,omitempty"`
	Tools               string `json:"tools,omitempty"`
	ToolSchemaVersion   string `json:"toolSchemaVersion,omitempty"`
	ToolError           string `json:"toolError,omitempty"`
	PendingVision       bool   `json:"pendingVision,omitempty"`
	Text                bool   `json:"text"`
	Vision              bool   `json:"vision"`
	CheckedAt           string `json:"checkedAt"`
	Error               string `json:"error,omitempty"`
	Fingerprint         string `json:"-"`
}

// AIConfig and savedConfig decode historical JSON for one-time migration only.
// Runtime and public configuration use NativeAIConfig.
type AIConfig struct {
	Primary string                       `json:"primary"`
	Models  map[string]string            `json:"models"`
	Efforts map[string]map[string]string `json:"efforts,omitempty"`
	// Translation choices are independent of chat. An empty model means
	// Reader picks the fast tier from the live catalog.
	TranslationModels  map[string]string            `json:"translationModels,omitempty"`
	TranslationEfforts map[string]map[string]string `json:"translationEfforts,omitempty"`
	TranslationPrompt  *string                      `json:"translationPrompt,omitempty"`
	// The API agent also picks a model for image input. Other agents send
	// images to their chat model.
	VisionModels  map[string]string            `json:"visionModels,omitempty"`
	VisionEfforts map[string]map[string]string `json:"visionEfforts,omitempty"`
	// API is the endpoint of the "api" agent; API.Model is unused. APIModels
	// are model IDs the user added beside the endpoint's /models list.
	API          APIConnection         `json:"api"`
	APIModels    []string              `json:"apiModels"`
	TextAPI      APIConnection         `json:"textAPI"`
	ImageAPI     APIConnection         `json:"imageAPI"`
	Capabilities map[string]Capability `json:"capabilities"`
}
type savedConfig struct {
	Config       AIConfig          `json:"config"`
	Fingerprints map[string]string `json:"fingerprints"`
}
type AIInput struct {
	SourceOnly    bool
	ContextInfo   func(window, used int)
	UsageSink     func(UsageCall) error
	UsageProvider string
	Chat          *chatInput
	Effort        string
	Prompt        string
	Image         []byte
	Images        [][]byte
}

func (in AIInput) images() [][]byte {
	if len(in.Images) > 0 {
		return in.Images
	}
	if len(in.Image) > 0 {
		return [][]byte{in.Image}
	}
	return nil
}

type AIResult struct {
	Reasoning string
	Text      string
	Provider  string
	Fallback  bool
}

func validAgent(p string) bool { return p == "codex" || p == "claude" || p == "kimi" || p == "api" }
func atomicFile(path string, b []byte) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".write-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(name, path)
}
func configPrint(c AIConfig, p string) string {
	var value any
	if p == "text-api" {
		value = c.TextAPI
	} else if p == "image-api" {
		value = c.ImageAPI
	} else if model, ok := strings.CutPrefix(p, "api:"); ok {
		value = []string{"api", c.API.URL, c.API.Key, c.API.Protocol, apiRulesVersion, model}
	} else if p == "api" {
		// Checked per model, never as a whole.
		return ""
	} else {
		value = []string{p, c.Models[p]}
	}
	b, _ := json.Marshal(value)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func validateAPI(c APIConnection) error {
	if e := validateAPIProtocol(c.Protocol); e != nil {
		return e
	}
	if c.URL == "" && c.Model == "" && c.Key == "" {
		return nil
	}
	if e := validateAPIURL(c.URL); e != nil {
		return e
	}
	if strings.TrimSpace(c.Model) == "" {
		return errors.New("请填写 API 模型")
	}
	return nil
}

// The API agent chooses models per task, so only the endpoint is required.
func validateAgentAPI(c APIConnection) error {
	if e := validateAPIProtocol(c.Protocol); e != nil {
		return e
	}
	if c.URL == "" && c.Key == "" {
		return nil
	}
	return validateAPIURL(c.URL)
}
func validateAPIProtocol(protocol string) error {
	if protocol != "" && protocol != "auto" && protocol != "openai" && protocol != "anthropic" {
		return errors.New("无效的 API 协议")
	}
	return nil
}
func validateAPIURL(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("API 地址无效")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return errors.New("API 需要 HTTPS，本机服务可使用 HTTP")
	}
	return nil
}
func (s *Server) getAIConfig(w http.ResponseWriter, r *http.Request) {
	c, err := s.nativeAIConfig()
	if err != nil {
		fail(w, 500, "无法读取 AI 配置")
		return
	}
	respond(w, 200, c)
}
func (s *Server) putAIConfig(w http.ResponseWriter, r *http.Request) {
	var update NativeAIConfigUpdate
	if !decode(w, r, &update) {
		return
	}
	c, err := s.saveNativeAIConfig(update)
	if err != nil {
		fail(w, 400, "无法保存 AI 配置："+err.Error())
		return
	}
	respond(w, 200, c)
	s.wakeProcessing()
}

var visionColorNames = regexp.MustCompile(`(?i)\b(?:red|blue|green|yellow)\b`)

func matchesVisionProbe(answer, expected string) bool {
	return strings.Join(visionColorNames.FindAllString(strings.ToUpper(answer), -1), " ") == expected
}

func validEffort(provider, effort string) bool {
	return validAgent(provider) && (effort == "low" || effort == "medium" || effort == "high" || effort == "max")
}

const visionPrompt = "Inspect the attached image. It contains one horizontal row of 8 colored squares. Reply with exactly 8 uppercase color names in left-to-right order, separated by single spaces. Allowed names: RED BLUE GREEN YELLOW. No punctuation or tools."

func visionProbe() ([]byte, string, error) {
	choices := make([]byte, 8)
	if _, err := rand.Read(choices); err != nil {
		return nil, "", err
	}
	colors := []color.RGBA{{230, 30, 30, 255}, {25, 70, 235, 255}, {30, 175, 65, 255}, {245, 210, 20, 255}}
	names := []string{"RED", "BLUE", "GREEN", "YELLOW"}
	im := image.NewRGBA(image.Rect(0, 0, 800, 140))
	for y := 0; y < 140; y++ {
		for x := 0; x < 800; x++ {
			im.Set(x, y, color.White)
		}
	}
	answer := make([]string, 8)
	for i, v := range choices {
		choice := int(v) % 4
		answer[i] = names[choice]
		for y := 30; y < 110; y++ {
			for x := i*100 + 10; x < i*100+90; x++ {
				im.Set(x, y, colors[choice])
			}
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, im); err != nil {
		return nil, "", err
	}
	return data.Bytes(), strings.Join(answer, " "), nil
}
