package reader

import (
	"context"
	"encoding/json"
	"errors"
)

type nativeToolImage struct {
	SourceID string `json:"sourceId"`
	MIME     string `json:"mime"`
	Label    string `json:"label"`
	Data     []byte `json:"-"`
	Hash     string `json:"hash,omitempty"`
	Bytes    int    `json:"bytes,omitempty"`
}
type nativeToolResult struct {
	Content json.RawMessage
	Images  []nativeToolImage
}
type nativeToolset interface {
	Definitions(vision bool) []any
	Call(context.Context, string, json.RawMessage) (nativeToolResult, error)
	Check(context.Context) error
	ValidateAnswer(context.Context, string) error
}
type nativeImageLoader interface {
	ImageData(context.Context, nativeToolImage) ([]byte, error)
}
type documentToolset struct{ agent *documentAgent }

func (t documentToolset) Definitions(vision bool) []any   { return documentAPITools(vision) }
func (t documentToolset) Check(ctx context.Context) error { return t.agent.check(ctx) }
func (t documentToolset) ValidateAnswer(ctx context.Context, text string) error {
	_, err := t.agent.references(text)
	return err
}
func (t documentToolset) ImageData(ctx context.Context, image nativeToolImage) ([]byte, error) {
	if err := t.Check(ctx); err != nil {
		return nil, err
	}
	for _, ev := range t.agent.Evidence {
		if ev.SourceID == image.SourceID && ev.PageImage != nil {
			return t.agent.pageImageData(*ev.PageImage)
		}
	}
	return nil, generationError(ErrorProtocol, "图片来源已不可用")
}
func (t documentToolset) Call(ctx context.Context, name string, args json.RawMessage) (nativeToolResult, error) {
	raw, err := t.agent.call(ctx, name, args)
	if errors.Is(err, errDocumentReadingBudget) {
		return nativeToolResult{Content: json.RawMessage(`{"shouldFinish":true,"message":"Stop reading and answer from available evidence; state gaps."}`)}, nil
	}
	if err != nil {
		return nativeToolResult{}, err
	}
	result := nativeToolResult{Content: raw}
	for _, page := range resultPageImages(raw) {
		data, err := t.agent.pageImageData(page)
		if err != nil {
			return nativeToolResult{}, err
		}
		result.Images = append(result.Images, nativeToolImage{SourceID: page.SourceID, MIME: "image/png", Label: pageEvidence(page).Text, Data: data, Hash: page.Hash, Bytes: len(data)})
	}
	return result, nil
}
