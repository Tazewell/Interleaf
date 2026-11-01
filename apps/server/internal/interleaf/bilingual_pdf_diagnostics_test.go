package interleaf

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBilingualProcessorPreservesOnlyVerifiedOverflowDiagnostic(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Setenv("INTERLEAF_NODE", node)
	t.Setenv("INTERLEAF_PROCESSOR", filepath.Join(dir, "main.mjs"))
	const known = "第 1 页段落 p1.p1-b1.caption 排版溢出（最小字号 9 pt）"
	for _, tc := range []struct {
		name, stderr, stage, id string
		page                    int
		preserved               bool
	}{
		{"verified", known + "\n", "render", "p1.p1-b1.caption", 1, true},
		{"unknown paragraph", strings.ReplaceAll(known, "p1.p1-b1.caption", "p1.unknown"), "render", "p1.p1-b1.caption", 1, false},
		{"wrong page", strings.ReplaceAll(known, "第 1 页", "第 2 页"), "render", "p1.p1-b1.caption", 1, false},
		{"free error", "/private/file.pdf API key=test-secret", "render", "p1.p1-b1.caption", 1, false},
		{"appended secret", known + "\nAPI key=test-secret", "render", "p1.p1-b1.caption", 1, false},
		{"truncated output", known + strings.Repeat(" ", 8192) + "API key=test-secret", "render", "p1.p1-b1.caption", 1, false},
		{"prepare stage", known, "prepare", "p1.p1-b1.caption", 1, false},
		{"unsafe prepared ID", "第 1 页段落 /private/path 排版溢出（最小字号 9 pt）", "render", "/private/path", 1, false},
		{"out of range prepared page", known, "render", "p1.p1-b1.caption", 2, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			encoded, _ := json.Marshal(tc.stderr)
			if err := os.WriteFile(filepath.Join(dir, "bilingual-pdf-cli.mjs"), []byte("process.stderr.write("+string(encoded)+");process.exitCode=1;"), 0600); err != nil {
				t.Fatal(err)
			}
			j := &bilingualJob{ctx: context.Background(), work: dir}
			prepared := map[string]any{"totalPages": 1, "pages": []any{map[string]any{"page": tc.page, "paragraphs": []any{map[string]any{"id": tc.id, "page": tc.page}}}}}
			raw, _ := json.Marshal(prepared)
			if err := json.Unmarshal(raw, &j.prepared); err != nil {
				t.Fatal(err)
			}
			got := bilingualPublicError((&Server{}).bilingualProcessor(j, []string{"--stage", tc.stage}))
			if tc.preserved && got != known {
				t.Fatalf("lost verified overflow diagnostic: %q", got)
			}
			if !tc.preserved && got != "PDF 排版失败：请检查文字方向、字体、段落区域或版面；可缩小页码范围重试" {
				t.Fatalf("unsafe stderr became public: %q", got)
			}
		})
	}
}
