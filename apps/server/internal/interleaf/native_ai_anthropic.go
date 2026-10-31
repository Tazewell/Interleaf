package interleaf

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"strings"
	"unicode/utf8"
)

// Translate the shared complete protocol groups to Messages blocks. Tool images
// keep their own source labels; no document identity is invented here.
func nativeAnthropicCompletion(ctx context.Context, c APIConnection, req completionRequest, payload map[string]any, messages []toolCompletionMessage, tools []any, callbacks ...toolStreamCallbacks) (toolCompletionResult, error) {
	var system []string
	var wire []map[string]any
	for _, m := range messages {
		if m.Role == "system" {
			text, ok := m.Content.(string)
			if !ok {
				return toolCompletionResult{}, generationError(ErrorProtocol, "无效系统消息")
			}
			system = append(system, text)
			continue
		}
		role := m.Role
		var content []any
		if role == "tool" {
			role = "user"
			content = []any{map[string]any{"type": "tool_result", "tool_use_id": m.CallID, "content": m.Content}}
		} else if len(m.AnthropicContent) > 0 {
			content = m.AnthropicContent
		} else {
			switch value := m.Content.(type) {
			case string:
				if value != "" {
					content = append(content, map[string]any{"type": "text", "text": value})
				}
			default:
				raw, _ := json.Marshal(value)
				var parts []map[string]any
				if json.Unmarshal(raw, &parts) != nil {
					return toolCompletionResult{}, generationError(ErrorProtocol, "图片消息无效")
				}
				for _, part := range parts {
					if part["type"] == "text" {
						content = append(content, part)
						continue
					}
					image, ok := part["image_url"].(map[string]any)
					if !ok {
						return toolCompletionResult{}, generationError(ErrorProtocol, "图片消息无效")
					}
					url, _ := image["url"].(string)
					header, data, ok := strings.Cut(url, ",")
					if !ok || !strings.HasSuffix(header, ";base64") {
						return toolCompletionResult{}, generationError(ErrorProtocol, "图片数据无效")
					}
					content = append(content, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64"), "data": data}})
				}
			}
			for _, call := range m.Calls {
				var args any
				if json.Unmarshal([]byte(call.Function.Arguments), &args) != nil {
					return toolCompletionResult{}, generationError(ErrorProtocol, "工具参数无效")
				}
				content = append(content, map[string]any{"type": "tool_use", "id": call.ID, "name": call.Function.Name, "input": args})
			}
		}
		if len(content) == 0 {
			content = []any{map[string]any{"type": "text", "text": " "}}
		}
		if len(wire) > 0 && wire[len(wire)-1]["role"] == role {
			last := wire[len(wire)-1]
			last["content"] = append(last["content"].([]any), content...)
		} else {
			wire = append(wire, map[string]any{"role": role, "content": content})
		}
	}
	payload["system"] = strings.Join(system, "\n\n")
	payload["messages"] = wire
	delete(payload, "n")
	delete(payload, "stream_options")
	delete(payload, "tools")
	if len(tools) > 0 {
		var defs []any
		for _, d := range tools {
			var def struct {
				Function struct {
					Name, Description string
					Parameters        any
				} `json:"function"`
			}
			json.Unmarshal([]byte(jsonText(d)), &def)
			defs = append(defs, map[string]any{"name": def.Function.Name, "description": def.Function.Description, "input_schema": def.Function.Parameters})
		}
		payload["tools"] = defs
	}
	if _, ok := payload["max_tokens"]; !ok {
		limit := 8192
		if req.MaxOutputTokens > 0 {
			limit = min(limit, req.MaxOutputTokens)
		}
		payload["max_tokens"] = limit
	}
	if maximum, ok := payload["max_tokens"].(int); ok && req.MaxOutputTokens > 0 && maximum > req.MaxOutputTokens {
		payload["max_tokens"] = req.MaxOutputTokens
		if thinking, ok := payload["thinking"].(map[string]any); ok && thinking["type"] == "enabled" {
			if budget, ok := thinking["budget_tokens"].(int); ok && budget >= req.MaxOutputTokens {
				return toolCompletionResult{}, generationError(ErrorConfiguration, "模型输出窗口不足以容纳已选思考预算")
			}
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return toolCompletionResult{}, err
	}
	if len(body) > 48<<20 {
		return toolCompletionResult{}, errDocumentToolContext
	}
	response, err := apiRequest(ctx, c, "POST", "/messages", body)
	if err != nil {
		return toolCompletionResult{}, err
	}
	defer response.Body.Close()
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if media != "text/event-stream" {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if hasAPIError(data) {
			return toolCompletionResult{}, providerFailure(ctx, c, response.StatusCode, response.Header, data, "http")
		}
		return toolCompletionResult{}, generationError(ErrorProtocol, "Messages API 未返回 SSE 流")
	}
	return readNativeAnthropicCompletion(ctx, response.Body, c, callbacks...)
}
func readNativeAnthropicCompletion(ctx context.Context, r io.Reader, c APIConnection, callbacks ...toolStreamCallbacks) (toolCompletionResult, error) {
	var result toolCompletionResult
	started, finished := false, false
	finish := ""
	seen := map[int]bool{}
	active := map[int]map[string]any{}
	blocks := map[int]map[string]any{}
	arguments := map[int]string{}
	callIDs := map[string]bool{}
	reasoningBytes := 0
	protocol := func() error { return generationError(ErrorProtocol, "Messages API 流无效或缺少成功终态") }
	draft := func(text string, reset bool) error {
		if len(callbacks) > 0 && callbacks[0].Draft != nil {
			return callbacks[0].Draft(text, reset)
		}
		return nil
	}
	thinking := func(text string) error {
		reasoningBytes += len(text)
		if reasoningBytes > 256<<10 {
			return generationError(ErrorLimit, "思考内容超过限制")
		}
		if len(callbacks) > 0 && callbacks[0].Reasoning != nil && text != "" {
			return callbacks[0].Reasoning(text)
		}
		return nil
	}
	dispatch := func(data string) (bool, error) {
		var e struct {
			Type    string `json:"type"`
			Index   *int   `json:"index"`
			Message struct {
				Model string         `json:"model"`
				Usage anthropicUsage `json:"usage"`
			} `json:"message"`
			Block map[string]any `json:"content_block"`
			Delta struct {
				Type, Text, Thinking, Signature string
				Partial                         string `json:"partial_json"`
				Reason                          string `json:"stop_reason"`
			} `json:"delta"`
			Usage anthropicUsage `json:"usage"`
		}
		if !utf8.ValidString(data) || json.Unmarshal([]byte(data), &e) != nil {
			return false, protocol()
		}
		if e.Type == "error" {
			return false, providerFailure(ctx, c, 200, nil, []byte(data), "stream")
		}
		if e.Type == "ping" {
			return false, nil
		}
		if e.Type == "message_start" {
			if started {
				return false, protocol()
			}
			started = true
			result.Model = e.Message.Model
			result.Tokens = anthropicNativeTokens(e.Message.Usage, nil)
			return false, nil
		}
		if !started {
			return false, protocol()
		}
		if e.Type == "message_stop" {
			if !finished || len(active) != 0 || finish == "tool_use" && len(result.Calls) == 0 || finish != "tool_use" && len(result.Calls) > 0 {
				return false, protocol()
			}
			for i := 0; i < len(blocks); i++ {
				block := blocks[i]
				if block == nil {
					return false, protocol()
				}
				result.AnthropicContent = append(result.AnthropicContent, block)
			}
			return true, nil
		}
		if finished {
			return false, protocol()
		}
		switch e.Type {
		case "content_block_start":
			if e.Index == nil || *e.Index < 0 || *e.Index >= 4096 || seen[*e.Index] {
				return false, protocol()
			}
			index := *e.Index
			seen[index] = true
			block := e.Block
			kind, _ := block["type"].(string)
			if kind != "text" && kind != "tool_use" && kind != "thinking" && kind != "redacted_thinking" {
				return false, protocol()
			}
			if kind == "thinking" || kind == "redacted_thinking" {
				for _, field := range []string{"signature", "data"} {
					if text, ok := block[field].(string); ok {
						reasoningBytes += len(text)
					}
				}
				if reasoningBytes > 256<<10 {
					return false, generationError(ErrorLimit, "API 续接信息超过限制")
				}
			}
			active[index] = block
			blocks[index] = block
			if kind == "tool_use" {
				id, _ := block["id"].(string)
				name, _ := block["name"].(string)
				if id == "" || name == "" || callIDs[id] {
					return false, protocol()
				}
				callIDs[id] = true
				return false, draft("", true)
			}
			if kind == "thinking" {
				text, _ := block["thinking"].(string)
				return false, thinking(text)
			}
			if kind == "text" {
				text, _ := block["text"].(string)
				result.Text += text
				return false, draft(text, false)
			}
		case "content_block_delta":
			if e.Index == nil || active[*e.Index] == nil {
				return false, protocol()
			}
			index := *e.Index
			block := active[index]
			kind := block["type"]
			field, part := "", ""
			switch {
			case kind == "text" && e.Delta.Type == "text_delta":
				field, part = "text", e.Delta.Text
				result.Text += part
				if len(result.Text) > 1<<20 {
					return false, generationError(ErrorLimit, "回答超过限制")
				}
				if err := draft(part, false); err != nil {
					return false, err
				}
			case kind == "thinking" && e.Delta.Type == "thinking_delta":
				field, part = "thinking", e.Delta.Thinking
				if err := thinking(part); err != nil {
					return false, err
				}
			case kind == "thinking" && e.Delta.Type == "signature_delta":
				field, part = "signature", e.Delta.Signature
				reasoningBytes += len(part)
				if reasoningBytes > 256<<10 {
					return false, generationError(ErrorLimit, "API 续接信息超过限制")
				}
			case kind == "tool_use" && e.Delta.Type == "input_json_delta":
				arguments[index] += e.Delta.Partial
				if len(arguments[index]) > 4096 {
					return false, generationError(ErrorLimit, "工具参数过长")
				}
				return false, nil
			default:
				return false, protocol()
			}
			old, _ := block[field].(string)
			block[field] = old + part
		case "content_block_stop":
			if e.Index == nil || active[*e.Index] == nil {
				return false, protocol()
			}
			index := *e.Index
			block := active[index]
			if block["type"] == "tool_use" {
				raw := arguments[index]
				if raw == "" {
					raw = jsonText(block["input"])
				}
				var args map[string]json.RawMessage
				if json.Unmarshal([]byte(raw), &args) != nil || args == nil {
					return false, protocol()
				}
				block["input"] = args
				call := completionToolCall{ID: block["id"].(string), Type: "function"}
				call.Function.Name = block["name"].(string)
				call.Function.Arguments = raw
				result.Calls = append(result.Calls, call)
			}
			delete(active, index)
		case "message_delta":
			if len(active) != 0 {
				return false, protocol()
			}
			finish = e.Delta.Reason
			switch finish {
			case "end_turn", "stop_sequence", "tool_use":
				finished = true
			default:
				return false, protocol()
			}
			result.Tokens = anthropicNativeTokens(e.Usage, result.Tokens)
		default:
			return false, protocol()
		}
		return false, nil
	}
	if err := consumeCompletionFrames(ctx, r, dispatch); err != nil {
		return result, err
	}
	return result, nil
}
func anthropicNativeTokens(usage anthropicUsage, prior *TokenCounts) *TokenCounts {
	if prior == nil {
		prior = &TokenCounts{}
	}
	// Messages reports uncached input separately from cache read/write tokens.
	input := prior.InputTokens
	if prior.CachedInputTokens != nil {
		input -= *prior.CachedInputTokens
	}
	if prior.CacheWriteInputTokens != nil {
		input -= *prior.CacheWriteInputTokens
	}
	if usage.Input != nil {
		input = *usage.Input
	}
	if usage.Output != nil {
		prior.OutputTokens = *usage.Output
	}
	if usage.Read != nil {
		prior.CachedInputTokens = usage.Read
	}
	if usage.Write != nil {
		prior.CacheWriteInputTokens = usage.Write
	}
	if prior.CachedInputTokens != nil {
		input += *prior.CachedInputTokens
	}
	if prior.CacheWriteInputTokens != nil {
		input += *prior.CacheWriteInputTokens
	}
	prior.InputTokens = input
	prior.TotalTokens = input + prior.OutputTokens
	return prior
}
