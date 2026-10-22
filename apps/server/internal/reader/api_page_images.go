package reader

import (
	"encoding/base64"
)

// Store only page references. Rehydrate image bytes at the provider boundary,
// not in SQLite, usage logs, compact prompts or the public chat transcript.
func pageImageMessages(req completionRequest, messages []toolCompletionMessage) ([]toolCompletionMessage, error) {
	wire := append([]toolCompletionMessage(nil), messages...)
	bytes := 0
	for i, m := range wire {
		if len(m.PageImages) == 0 && len(m.NativeImages) == 0 {
			continue
		}
		if !req.Vision || (len(m.PageImages) > 0 && req.PageImageData == nil) || (len(m.NativeImages) > 0 && req.NativeImageData == nil) {
			return nil, generationError(ErrorCapability, "当前聊天模型未通过图片能力检测，请使用支持读图的模型")
		}
		parts := []any{map[string]any{"type": "text", "text": m.Content}}
		for _, page := range m.PageImages {
			data, err := req.PageImageData(page)
			if err != nil {
				return nil, err
			}
			bytes += len(data)
			if bytes > 32<<20 {
				return nil, generationError(ErrorLimit, "当前对话图片超过传输上限，请整理上下文后重试")
			}
			parts = append(parts, map[string]any{"type": "text", "text": "[" + page.SourceID + "] " + pageEvidence(page).Text}, map[string]any{"type": "image_url", "image_url": map[string]string{"url": imageData(data), "detail": "high"}})
		}
		for _, im := range m.NativeImages {
			data, err := req.NativeImageData(im)
			if err != nil {
				return nil, err
			}
			bytes += len(data)
			if bytes > 32<<20 {
				return nil, generationError(ErrorLimit, "当前对话图片超过传输上限")
			}
			if im.Hash != "" && sourceKey(string(data)) != im.Hash {
				return nil, generationError(ErrorProtocol, "图片来源已改变")
			}
			mime := im.MIME
			if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
				return nil, generationError(ErrorProtocol, "图片格式无效")
			}
			parts = append(parts, map[string]any{"type": "text", "text": "[" + im.SourceID + "] " + im.Label}, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), "detail": "high"}})
		}
		wire[i].NativeImages = nil
		wire[i].PageImages = nil
		wire[i].Content = parts
	}
	return wire, nil
}
