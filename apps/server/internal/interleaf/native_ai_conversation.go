package interleaf

import (
	"context"
)

// Only visible history and Reader protocol groups participate in continuation.
// Private CLI thread IDs and Pi entries are deliberately never read.
func streamNativeChat(ctx context.Context, snapshot nativeTaskSnapshot, in AIInput, emit func(ProviderEvent) error) (GenerateResult, error) {
	chat := in.Chat
	key := nativeConnectionKey(snapshot)
	provider := in.UsageProvider
	if provider == "" {
		provider = "api"
	}
	state := documentConversation{ID: id(), ConnectionKey: key}
	if chat.server != nil {
		var err error
		state, err = chat.server.Store.documentConversation(ctx, chat.DocumentID, conversationProvider(chat.SessionID, provider), key)
		if err != nil {
			return GenerateResult{}, err
		}
	}
	history := chat.History
	if state.LastMessageID != "" {
		found := false
		for i, m := range history {
			if m.ID == state.LastMessageID {
				history = history[i+1:]
				found = true
				break
			}
		}
		if !found {
			return GenerateResult{}, generationError(ErrorProtocol, "会话记录不一致，历史已保留")
		}
	}
	messages := append([]toolCompletionMessage(nil), state.Messages...)
	if len(messages) == 0 {
		messages = []toolCompletionMessage{{Role: "system", Content: chatInstructions}}
	}
	messages = append(messages, conversationHistory(history)...)
	current := *chat
	current.History = nil
	prompt := current.legacyPrompt() + readingLocationPrompt(chat.ReadingLocation)
	messages = append(messages, nativeInputMessage(prompt, in, snapshot.Vision))
	result, err := runNativeLoop(ctx, nativeLoopRequest{Snapshot: snapshot, Input: in, Window: nativeConversation{Messages: messages, ConnectionKey: key}}, emit)
	if err != nil {
		return GenerateResult{}, err
	}
	state.Messages = result.Window.Messages
	state.Compactions += len(result.Window.Checkpoints)
	state.PiEntries = nil
	state.NativeThread = ""
	state.NativePending = ""
	state.NativeCommitted = ""
	state.NativeDirty = false
	state.NativeUsage = nil
	chat.nativeConversation = &state
	chat.nativeProvider = provider
	return result.Result, nil
}
