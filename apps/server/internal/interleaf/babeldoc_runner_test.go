package interleaf

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestBabelDOCExecutableRevisionIncludesInstalledDependencies(t *testing.T) {
	root := t.TempDir()
	bin, site := filepath.Join(root, "bin"), filepath.Join(root, "lib", "python3.12", "site-packages")
	if runtime.GOOS == "windows" {
		bin, site = filepath.Join(root, "Scripts"), filepath.Join(root, "Lib", "site-packages")
	}
	executable := filepath.Join(bin, "pdf2zh_next.exe")
	dist := filepath.Join(site, "babeldoc-0.7.1.dist-info")
	for _, dir := range []string{bin, dist} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(executable, []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "METADATA"), []byte("Version: 0.7.1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(babeldocExecutableEnv, executable)
	before, err := resolveBabelDOCEngine()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(dist, filepath.Join(site, "babeldoc-0.7.2.dist-info")); err != nil {
		t.Fatal(err)
	}
	after, err := resolveBabelDOCEngine()
	if err != nil {
		t.Fatal(err)
	}
	if before.revision == after.revision {
		t.Fatal("changing the installed engine dependency did not invalidate the old cache")
	}
}

func setupBabelDOCExecutable(t *testing.T, body string) (babeldocEngine, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("test fixture is a POSIX executable")
	}
	executable := filepath.Join(t.TempDir(), "pdf2zh_next")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nset -eu\n"+body), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("INTERLEAF_BABELDOC_EXECUTABLE", executable)
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	connection, err := resolveBabelDOCEngine()
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	if err := os.WriteFile(filepath.Join(work, "original.pdf"), []byte("%PDF-1.7 test input"), 0600); err != nil {
		t.Fatal(err)
	}
	return connection, work
}

func TestBabelDOCUsesOnlyTheSelectedConnectionAndMonoOutput(t *testing.T) {
	engine, work := setupBabelDOCExecutable(t, `
[ "$PDF2ZH_OPENAI_BASE_URL" = "http://127.0.0.1:1234/custom/v1" ]
[ "$PDF2ZH_OPENAI_API_KEY" = "fixture-key" ]
[ "$PDF2ZH_OPENAI_MODEL" = "model with spaces" ]
[ -z "${PDF2ZH_TERM_OPENAI_API_KEY:-}" ]
[ -z "${PDF2ZH_GUI:-}" ]
[ -z "${OPENAI_API_KEY:-}" ]
[ -z "${INTERLEAF_TOKEN:-}" ]
[ ! -e "$HOME/.config/pdf2zh/config.v3.toml" ]
[ "$PDF2ZH_CUSTOM_SYSTEM_PROMPT" = "Use precise terms." ]
[ $# -eq 12 ]
[ "$1 $2 $3 $4 $5" = "--openai --lang-in en --lang-out zh" ]
[ "$6" = "--output" ] && [ "$7" = "$PWD/output" ]
[ "$8 $9 ${10} ${11}" = "--no-dual --watermark-output-mode no_watermark --ignore-cache" ]
[ "${12}" = "$PWD/original.pdf" ] && [ -f "${12}" ]
printf '%%PDF-1.7 translation\n%%%%EOF\n' > "$7/original.no_watermark.zh.mono.pdf"
`)
	t.Setenv("PDF2ZH_TERM_OPENAI_API_KEY", "unexpected-operator-key")
	t.Setenv("PDF2ZH_GUI", "true")
	t.Setenv("OPENAI_API_KEY", "unexpected-operator-key")
	t.Setenv("INTERLEAF_TOKEN", "private-library-capability")
	operatorHome := t.TempDir()
	t.Setenv("HOME", operatorHome)
	configDir := filepath.Join(operatorHome, ".config", "pdf2zh")
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "config.v3.toml"), []byte("[basic]\ngui = true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	connection := APIConnection{Protocol: "openai", URL: "http://127.0.0.1:1234/custom/v1/chat/completions", Key: "fixture-key", Model: "wrong model"}
	result, err := engine.translate(t.Context(), work, connection, "model with spaces", "Use precise terms.")
	if err != nil {
		t.Fatal(err)
	}
	if string(result) != "%PDF-1.7 translation\n%%EOF\n" {
		t.Fatalf("unexpected output: %q", result)
	}
}

func TestBabelDOCRejectsIncompleteOrFailedOutput(t *testing.T) {
	tests := map[string]string{
		"missing after exit zero": "exit 0",
		"malformed":               `printf 'not a PDF' > "$7/original.no_watermark.zh.mono.pdf"`,
		"oversize":                `truncate -s 537000000 "$7/original.no_watermark.zh.mono.pdf"`,
		"unexpected symlink":      `ln -s "$PWD/original.pdf" "$7/original.no_watermark.zh.mono.pdf"`,
		"nonzero exit":            `printf '%%PDF-1.7 translation\n%%%%EOF\n' > "$7/original.no_watermark.zh.mono.pdf"; printf '%s' "$PDF2ZH_OPENAI_API_KEY" >&2; exit 4`,
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			engine, work := setupBabelDOCExecutable(t, body)
			conn := APIConnection{Protocol: "openai", URL: "http://localhost:1234/v1", Key: "fixture-key"}
			result, err := engine.translate(t.Context(), work, conn, "chosen-model", "")
			if err == nil || len(result) > 0 || strings.Contains(err.Error(), conn.Key) {
				t.Fatalf("expected safe output failure, got %v and %d bytes", err, len(result))
			}
		})
	}
}

func TestBabelDOCStopsOnCanceledContext(t *testing.T) {
	engine, work := setupBabelDOCExecutable(t, "sleep 30")
	conn := APIConnection{Protocol: "openai", URL: "http://127.0.0.1:1234/v1"}
	ctx, cancel := context.WithTimeout(t.Context(), 80*time.Millisecond)
	defer cancel()
	start := time.Now()
	if result, err := engine.translate(ctx, work, conn, "chosen-model", ""); err == nil || len(result) > 0 {
		t.Fatalf("expected canceled translation, got %v and %d bytes", err, len(result))
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("BabelDOC did not stop after cancellation")
	}
}

func TestBabelDOCRejectsRelativeExecutable(t *testing.T) {
	t.Setenv("INTERLEAF_BABELDOC_EXECUTABLE", "."+string(filepath.Separator)+"pdf2zh_next")
	if _, err := resolveBabelDOCEngine(); err == nil {
		t.Fatal("accepted a relative executable path")
	}
}
