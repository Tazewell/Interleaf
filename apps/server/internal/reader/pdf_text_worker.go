package reader

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// The caller owns work and its cleanup. Never launch from an original file's
// directory. Both local corpus and remote candidates use this same boundary.
func runPDFTextWorker(ctx context.Context, work, input, pages string) (extractedPDF, error) {
	var extracted extractedPDF
	worker := os.Getenv("READER_CORPUS_PROCESSOR")
	if worker == "" && os.Getenv("READER_PROCESSOR") != "" {
		worker = filepath.Join(filepath.Dir(os.Getenv("READER_PROCESSOR")), "corpus.mjs")
	}
	node := os.Getenv("READER_NODE")
	if worker == "" || node == "" {
		return extracted, generationError(ErrorConfiguration, "全文检索需要本地 PDF 文字提取程序")
	}
	output := filepath.Join(work, "text.json")
	cmd := exec.CommandContext(ctx, node, worker, "--input", input, "--output", output)
	if pages != "" {
		cmd.Args = append(cmd.Args, "--pages", pages)
	}
	cmd.Dir = work
	cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 3 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return extracted, ctx.Err()
		}
		return extracted, generationError(ErrorConfiguration, "全文文字提取失败，请检查 PDF 或本地解析程序")
	}
	info, err := os.Lstat(output)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 32<<20 {
		return extracted, generationError(ErrorLimit, "PDF 原文索引不可用或过大")
	}
	file, err := os.Open(output)
	if err != nil {
		return extracted, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (32<<20)+1))
	if err != nil {
		return extracted, err
	}
	if len(data) > 32<<20 || json.Unmarshal(data, &extracted) != nil || extracted.TotalPages < 1 || extracted.TotalPages > 1000 || len(extracted.Pages) < 1 {
		return extracted, fmt.Errorf("PDF corpus invalid")
	}
	seen := map[int]bool{}
	for _, page := range extracted.Pages {
		if page.Page < 1 || page.Page > extracted.TotalPages || seen[page.Page] {
			return extracted, fmt.Errorf("PDF page invalid or duplicated")
		}
		seen[page.Page] = true
	}
	return extracted, ctx.Err()
}
