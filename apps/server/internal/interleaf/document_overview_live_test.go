package interleaf

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Opt-in, original synthetic text only. Never alter the user's Reader config.
func TestLiveOverviewThenOriginal(t *testing.T) {
	provider := "api"
	s, a := originalDocumentFixture(t)
	stored := configureLiveNative(t, s, false)
	config := nativeLegacyView(stored)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Minute)
	defer cancel()
	job := overviewTestJob(t, s)
	start := time.Now()
	if err := s.compileOverview(ctx, job, s.generationService(config)); err != nil {
		t.Fatal(err)
	}
	overview, err := s.currentOverview(ctx, a.corpus)
	if err != nil || overview == nil || overview.CompiledPassages != len(a.corpus.Passages) {
		t.Fatal("overview missing", err)
	}
	t.Logf("overview provider=%s elapsed=%s coverage=%d/%d", provider, time.Since(start).Round(time.Millisecond), overview.CompiledPassages, overview.TotalPassages)
	for _, question := range []string{"这篇文章大致讲什么？简洁介绍即可。", "请核对原文：cobalt 协议的精确 nonce、适用条件和实验交易数量分别是什么？请引用原文。"} {
		callCtx, stop := context.WithTimeout(ctx, 3*time.Minute)
		a.ctx = callCtx
		input := AIInput{Prompt: question, Chat: &chatInput{DocumentID: "doc", Question: question, Agent: a}}
		started := time.Now()
		var output strings.Builder
		emit := func(e ProviderEvent) error { output.WriteString(e.Text); return nil }
		var result GenerateResult
		req, e := s.apiAgentAdapter(config, taskChat).resolve(callCtx, false)
		if e != nil {
			stop()
			t.Fatal(e)
		}
		req.Tools = true
		result, err = streamAPIDocumentChat(callCtx, config.API, req, input, emit)

		if err != nil {
			stop()
			t.Fatal(err)
		}
		if result.Text != output.String() {
			stop()
			t.Fatal("stream mismatch")
		}
		if strings.Contains(question, "nonce") && (!strings.Contains(result.Text, "COBALT-19") || !strings.Contains(result.Text, "37") || len(a.Evidence) == 0) {
			stop()
			t.Fatal("specific claim did not read original", result.Text)
		}
		if _, e := a.references(result.Text); e != nil {
			stop()
			t.Fatal(e)
		}
		t.Logf("question=%s elapsed=%s tools=%d originals=%d window=%d source=%s", question, time.Since(started).Round(time.Millisecond), len(a.Traces), len(a.Evidence), a.contextTokens, a.contextSource)
		stop()
	}
}
