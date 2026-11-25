package interleaf

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const babeldocTestLatinProse = "Recent research has brought advances across several scientific disciplines. The article introduces a unified framework to connect previously independent developments. It outlines the motivation behind each proposal and considers performance across different applications. The authors evaluate their hypotheses with experiments and assemble observations to make the findings readily accessible. The analysis identifies limitations and directions for exploration, along with a practical overview of the available tools and methods that are relevant to the wider field."

const babeldocTestChineseProse = "本文介绍统一框架，并说明它如何连接此前相互独立的研究方向。作者对实验结果进行了分析，探讨研究的局限和可能的后续方向。"

func TestBabelDOCContentRejectsMostlyUntranslatedProse(t *testing.T) {
	original := make([]string, 19)
	translated := make([]string, len(original))
	for i := range original {
		original[i] = babeldocTestLatinProse
		// Reordering and punctuation changes alone do not count as translation.
		end := strings.IndexByte(babeldocTestLatinProse, '.')
		translated[i] = babeldocTestLatinProse[end+2:] + "\n" + strings.ToUpper(babeldocTestLatinProse[:end])
	}
	for _, page := range []int{3, 8, 10, 11, 15} {
		translated[page] = babeldocTestChineseProse
	}
	if !babeldocMostlyUntranslated(
		babeldocTestExtracted(t, original...),
		babeldocTestExtracted(t, translated...),
	) {
		t.Fatal("14 of 19 pages retain their source prose and the output has only sparse Chinese text")
	}
}

func TestBabelDOCContentRejectsUnchangedSinglePagePaper(t *testing.T) {
	paper := babeldocTestExtracted(t, babeldocTestLatinProse)
	if !babeldocMostlyUntranslated(paper, paper) {
		t.Fatal("a single-page paper retaining all prose should be rejected")
	}
}

func TestBabelDOCContentKeepsMixedOrInconclusivePDFs(t *testing.T) {
	tests := []struct {
		name                 string
		original, translated []string
	}{
		{
			name:       "translated prose with retained references",
			original:   []string{babeldocTestLatinProse, babeldocTestLatinProse, babeldocTestLatinProse},
			translated: []string{strings.Repeat(babeldocTestChineseProse, 5), babeldocTestLatinProse, babeldocTestLatinProse},
		},
		{
			name:       "short translated caption with only the references qualifying",
			original:   []string{"Behavior on two experimental tasks.", "", babeldocTestLatinProse},
			translated: []string{"两项实验任务的表现。", "", babeldocTestLatinProse},
		},
		{
			name:       "source is already Chinese",
			original:   []string{strings.Repeat(babeldocTestChineseProse, 20) + babeldocTestLatinProse},
			translated: []string{strings.Repeat(babeldocTestChineseProse, 20) + babeldocTestLatinProse},
		},
		{
			name:       "scans formulas and short annotations",
			original:   []string{"", strings.Repeat("alpha beta gamma x = 123; ε + ψ ", 40), "Photograph of the mountain"},
			translated: []string{"", strings.Repeat("alpha beta gamma x = 123; ε + ψ ", 40), "Photograph of the mountain"},
		},
		{
			name:       "text is unavailable in the translated PDF",
			original:   []string{babeldocTestLatinProse},
			translated: []string{""},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if babeldocMostlyUntranslated(
				babeldocTestExtracted(t, test.original...),
				babeldocTestExtracted(t, test.translated...),
			) {
				t.Fatal("insufficient evidence that the translation engine copied the source prose")
			}
		})
	}
}

func TestBabelDOCContentHonorsCancellationWithoutConfiguredWorker(t *testing.T) {
	t.Setenv("INTERLEAF_NODE", "")
	check := func(ctx context.Context) error {
		return checkBabelDOCReadingContent(ctx, t.TempDir(), []byte("source"), []byte("candidate"), 1)
	}
	if err := check(context.Background()); err != nil {
		t.Fatalf("standalone reading without a worker: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := check(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation = %v", err)
	}
}

func babeldocTestExtracted(t *testing.T, pages ...string) extractedPDF {
	t.Helper()
	var extracted extractedPDF
	body := struct {
		TotalPages int              `json:"totalPages"`
		Pages      []map[string]any `json:"pages"`
	}{TotalPages: len(pages)}
	for i, text := range pages {
		body.Pages = append(body.Pages, map[string]any{
			"page": i + 1, "spans": []map[string]string{{"text": text}},
		})
	}
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &extracted); err != nil {
		t.Fatal(err)
	}
	return extracted
}
