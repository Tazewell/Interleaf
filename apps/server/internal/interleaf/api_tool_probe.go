package interleaf

import (
	"context"
	"fmt"
	"strings"
)

func probeAPIDocumentTools(ctx context.Context, c APIConnection, model string) (string, error) {
	req := completionRequest{Model: model}
	tool := map[string]any{"type": "function", "function": map[string]any{"name": "interleaf_probe", "description": "Get the hidden random nonce. Call this to obtain it.", "parameters": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}}}
	messages := []toolCompletionMessage{{Role: "user", Content: "Call interleaf_probe once, then reply with its exact returned nonce. Do not guess."}}
	result, e := toolCompletion(ctx, c, req, messages, []any{tool})
	if e != nil {
		return "failed", e
	}
	if len(result.Calls) != 1 || result.Calls[0].Function.Name != "interleaf_probe" || strings.TrimSpace(result.Calls[0].Function.Arguments) != "{}" {
		return "unsupported", fmt.Errorf("模型未返回合法工具调用")
	}
	nonce := "interleaf-" + id()
	messages = append(messages, toolCompletionMessage{Role: "assistant", Content: result.Text, Calls: result.Calls, Reasoning: result.Reasoning, AnthropicContent: result.AnthropicContent}, toolCompletionMessage{Role: "tool", CallID: result.Calls[0].ID, Content: nonce})
	result, e = toolCompletion(ctx, c, req, messages, nil)
	if e != nil {
		return "failed", e
	}
	if len(result.Calls) != 0 || !strings.Contains(result.Text, nonce) {
		return "unsupported", fmt.Errorf("模型未根据工具结果完成回答")
	}
	return "passed", nil
}
