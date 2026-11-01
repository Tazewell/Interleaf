package interleaf

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestBailianOfficialOriginsDoNotUseRelayDefaults(t *testing.T) {
	for _, base := range []string{
		"https://dashscope.aliyuncs.com/compatible-mode/v1",
		"https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		"https://dashscope-us.aliyuncs.com/compatible-mode/v1",
		"https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
		"https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		"https://workspace-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		"https://trial.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
	} {
		t.Run(base, func(t *testing.T) {
			e := resolveAPIEndpoint(APIConnection{URL: base, Protocol: "openai"})
			if e.Vendor != "bailian" || e.Base != base {
				t.Fatalf("Bailian treated as generic relay: %+v", e)
			}
			for _, model := range []string{"qwen-plus", "vanchin/deepseek-v4.1-flash-1017", "kimi-k2.6", "future-model", "qwen3.8-max-2099-01-01", "deepseek-v4-pro-2099-01-01"} {
				rule := reasoningRule(e, model, nil)
				payload := map[string]any{}
				rule.apply(payload, "openai", "medium", rule.resolve("medium"))
				if len(payload) != 0 || rule.info().Mode != "unknown" {
					t.Fatalf("injected unverified model parameters for %s: %+v", model, payload)
				}
			}
		})
	}
	for _, base := range []string{
		"https://dashscope.aliyuncs.com.evil.test/compatible-mode/v1",
		"https://workspace.cn-beijing.maas.aliyuncs.com.evil.test/compatible-mode/v1",
		"https://dashscope.aliyuncs.com/not-compatible",
		"https://dashscope.aliyuncs.com:8443/compatible-mode/v1",
		"http://dashscope.aliyuncs.com/compatible-mode/v1",
	} {
		if e := resolveAPIEndpoint(APIConnection{URL: base}); e.Vendor == "bailian" {
			t.Fatalf("unverified origin acquired Bailian rules: %+v", e)
		}
	}
}

func TestBailianActualWireUsesOnlyVerifiedModelParameters(t *testing.T) {
	original := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = original })
	for _, tc := range []struct{ model, effort, want string }{
		{"qwen-plus", "medium", ""},
		{"vanchin/deepseek-v4.1-flash-1017", "medium", ""},
		{"deepseek-v4-pro", "medium", "high"},
		{"deepseek-v4.1-flash", "medium", "high"},
		{"deepseek-v4.1-flash", "low", "low"},
		{"qwen3.8-max", "max", "xhigh"},
	} {
		t.Run(tc.model+tc.effort, func(t *testing.T) {
			http.DefaultTransport = apiRoundTripper(func(request *http.Request) (*http.Response, error) {
				var body map[string]any
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if tc.want == "" {
					if _, ok := body["reasoning_effort"]; ok {
						t.Fatal("unsupported effort was sent", body["reasoning_effort"])
					}
				} else if body["reasoning_effort"] != tc.want {
					t.Fatalf("effort=%v want %s", body["reasoning_effort"], tc.want)
				}
				for _, field := range []string{"thinking", "thinking_budget", "reasoning_split"} {
					if _, ok := body[field]; ok {
						t.Fatal("inherited an original vendor parameter", field)
					}
				}
				if request.URL.Path != "/compatible-mode/v1/chat/completions" {
					t.Fatal(request.URL.Path)
				}
				wire := "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"INTERLEAF_OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(wire))}, nil
			})
			_, err := streamCompletion(t.Context(), APIConnection{URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", Protocol: "openai", Key: "fake-key"}, completionRequest{Model: tc.model, Effort: tc.effort}, AIInput{Prompt: "test"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			_, err = toolCompletion(t.Context(), APIConnection{URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", Protocol: "openai", Key: "fake-key"}, completionRequest{Model: tc.model, Effort: tc.effort}, []toolCompletionMessage{{Role: "user", Content: "test"}}, nil)
			if err != nil {
				t.Fatal("document/chat request did not share the compatibility rules", err)
			}
		})
	}
}

func TestMiniMaxDomesticOfficialOrigin(t *testing.T) {
	e := resolveAPIEndpoint(APIConnection{URL: "https://api.minimax.cn/v1", Protocol: "openai"})
	r := reasoningRule(e, "MiniMax-M2.7", nil)
	if e.Vendor != "minimax" || e.Base != "https://api.minimax.cn/v1" || r.Mode != "fixed" {
		t.Fatalf("domestic preset used relay effort defaults: %+v %+v", e, r)
	}
}

func TestBailianTopLevelErrorKeepsSafeParameterOnly(t *testing.T) {
	c := APIConnection{URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", Key: "secret-key"}
	ctx, _ := traceAPI(t.Context(), c, "test")
	err := providerFailure(ctx, c, 400, nil, []byte(`{"code":"InvalidParameter","message":"reasoning_effort unsupported secret-key private-paper","request_id":"req_123"}`), "http")
	if err.(*apiFailure).Param != "reasoning_effort" || errorKind(err) != ErrorConfiguration {
		t.Fatal("lost the safe rejected parameter", err)
	}
	if strings.Contains(err.Error(), "secret-key") || strings.Contains(err.Error(), "private-paper") {
		t.Fatal("raw error exposed sensitive data")
	}
}

func TestBailianUnactivatedModelIsNotARequestParameterFailure(t *testing.T) {
	for _, body := range []string{
		`{"code":"InvalidParameter","message":"The product is not activated, please confirm that you have activated products and try again after activation.","request_id":"req_activation"}`,
		`{"error":{"code":"invalid_parameter_error","message":"The product is not activated, please confirm that you have activated products and try again after activation."}}`,
	} {
		ctx, _ := traceAPI(t.Context(), APIConnection{URL: "https://dashscope.aliyuncs.com/compatible-mode/v1"}, "test")
		err := providerFailure(ctx, APIConnection{URL: "https://dashscope.aliyuncs.com/compatible-mode/v1"}, 400, nil, []byte(body), "http")
		if errorKind(err) != ErrorPermission || !strings.Contains(err.Error(), "模型服务尚未开通") || strings.Contains(err.Error(), "拒绝请求参数") {
			t.Fatalf("model activation returned a misleading parameter error: %v", err)
		}
	}
}

func TestBailianActivationClassificationIsScoped(t *testing.T) {
	for _, tc := range []struct{ url, body string }{
		{"https://relay.test/v1", `{"code":"InvalidParameter","message":"The product is not activated"}`},
		{"https://dashscope.aliyuncs.com/compatible-mode/v1", `{"code":"InvalidParameter","message":"Invalid reasoning_effort parameter"}`},
	} {
		err := providerFailure(t.Context(), APIConnection{URL: tc.url}, 400, nil, []byte(tc.body), "http")
		if errorKind(err) != ErrorConfiguration || strings.Contains(err.Error(), "模型服务尚未开通") {
			t.Fatalf("overrode another endpoint/parameter failure: %v", err)
		}
	}
}
