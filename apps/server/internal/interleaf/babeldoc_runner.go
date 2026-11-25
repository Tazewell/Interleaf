package interleaf

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const babeldocExecutableEnv = "INTERLEAF_BABELDOC_EXECUTABLE"

type babeldocEngine struct {
	executable string
	revision   string
}

func resolveBabelDOCEngine() (babeldocEngine, error) {
	executable := os.Getenv(babeldocExecutableEnv)
	if executable == "" {
		executable = "pdf2zh_next"
	} else if !filepath.IsAbs(executable) {
		return babeldocEngine{}, bilingualFailure("请为版式翻译引擎设置绝对可执行文件路径")
	}
	resolved, err := exec.LookPath(executable)
	if err != nil || !filepath.IsAbs(resolved) || runtime.GOOS == "windows" && !strings.EqualFold(filepath.Ext(resolved), ".exe") {
		return babeldocEngine{}, bilingualFailure("未找到本机 pdf2zh_next 版式翻译引擎")
	}
	target, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		return babeldocEngine{}, bilingualFailure("无法读取版式翻译引擎")
	}
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		return babeldocEngine{}, bilingualFailure("无法读取版式翻译引擎")
	}
	revision := sourceKey(fmt.Sprintf("pdf2zh-next-cli-1\x00%s\x00%d\x00%d\x00%s",
		target, info.Size(), info.ModTime().UnixNano(), babeldocPackageRevision(target)))
	return babeldocEngine{executable: resolved, revision: revision}, nil
}

// Venv launchers do not change when their Python packages are upgraded in place.
func babeldocPackageRevision(executable string) string {
	root := filepath.Dir(filepath.Dir(executable))
	candidates := []string{filepath.Join(root, "Lib", "site-packages")}
	lib := filepath.Join(root, "lib")
	entries, _ := os.ReadDir(lib)
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), "python") {
			candidates = append(candidates, filepath.Join(lib, entry.Name(), "site-packages"))
		}
	}
	var revision strings.Builder
	for _, path := range candidates {
		packages, _ := os.ReadDir(path)
		for _, pkg := range packages {
			name := pkg.Name()
			if !pkg.IsDir() || !strings.HasSuffix(name, ".dist-info") ||
				(!strings.HasPrefix(name, "babeldoc-") && !strings.HasPrefix(name, "pdf2zh_next-")) {
				continue
			}
			meta, err := limitedBilingualRead(filepath.Join(path, name, "METADATA"), 1<<20)
			if err == nil {
				fmt.Fprintf(&revision, "%s\x00%s\x00", name, sourceKey(string(meta)))
			}
		}
	}
	return revision.String()
}

// translate runs the local engine in work, which contains the frozen original.pdf.
// The caller owns work and removes its intermediate files after the job.
func (e babeldocEngine) translate(ctx context.Context, work string, conn APIConnection, model, prompt string, report func(babeldocProgressSample)) ([]byte, error) {
	endpoint := resolveAPIEndpoint(conn)
	model = strings.TrimSpace(model)
	base := strings.TrimSuffix(endpoint.Base, "/chat/completions")
	if endpoint.Protocol != "openai" || model == "" || validateAPIURL(base) != nil {
		return nil, bilingualFailure("版式翻译需要可用的 OpenAI 兼容连接和翻译模型")
	}
	key := strings.TrimSpace(conn.Key)
	if key == "" {
		u, _ := url.Parse(base)
		switch u.Hostname() {
		case "localhost", "127.0.0.1", "::1":
			// The engine requires a nonempty key even for a keyless local server.
			key = "interleaf-local"
		default:
			return nil, bilingualFailure("请为版式翻译配置 API 密钥")
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return nil, bilingualFailure("无法定位版式翻译引擎的缓存目录")
	}
	// Both pdf2zh_next configuration and BabelDOC assets resolve paths beneath
	// Python's home directory. Keep the engine home independent of operator
	// settings and reuse downloaded assets between jobs.
	home := filepath.Join(cache, "Interleaf", "BabelDOC", e.revision)
	if err := os.MkdirAll(home, 0700); err != nil {
		return nil, bilingualFailure("无法准备版式翻译引擎的缓存目录")
	}
	output := filepath.Join(work, "output")
	if err := os.Mkdir(output, 0700); err != nil {
		return nil, bilingualFailure("无法准备版式翻译输出目录")
	}
	cmd := exec.CommandContext(ctx, e.executable,
		"--openai", "--lang-in", "en", "--lang-out", "zh", "--output", output,
		"--no-dual", "--watermark-output-mode", "no_watermark", "--ignore-cache",
		filepath.Join(work, "original.pdf"))
	cmd.Dir = work
	cmd.WaitDelay = 3 * time.Second
	configureBabelDOCCommand(cmd)
	for _, entry := range cmd.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		name = strings.ToUpper(name)
		// The child only needs the selected model's credentials. The
		// Interleaf environment grants access to the library server.
		if !strings.HasPrefix(name, "PDF2ZH_") && !strings.HasPrefix(name, "OPENAI_") &&
			!strings.HasPrefix(name, "PYTHON") && !strings.HasPrefix(name, "INTERLEAF_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env,
		"HOME="+home, "USERPROFILE="+home,
		"TMPDIR="+work, "TMP="+work, "TEMP="+work,
		"PYTHONNOUSERSITE=1",
		"PDF2ZH_OPENAI_BASE_URL="+base,
		"PDF2ZH_OPENAI_API_KEY="+key,
		"PDF2ZH_OPENAI_MODEL="+model,
		"PDF2ZH_CUSTOM_SYSTEM_PROMPT="+prompt,
	)
	if report != nil {
		// Force Rich to advance its terminal display on the pipe, including on
		// Windows. The reader discards all but known phase names and counters.
		cmd.Env = append(cmd.Env, "TTY_COMPATIBLE=1", "TTY_INTERACTIVE=1", "TERM=xterm-256color",
			"COLUMNS=160", "LINES=60", "NO_COLOR=1", "PYTHONIOENCODING=utf-8")
		cmd.Stdout = &babeldocProgressConsole{report: report}
	}
	// Never put raw console text in job state or logs. It can include private
	// provider responses, files, and keys. Stderr goes to the null device.
	runErr := cmd.Run()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if runErr != nil {
		return nil, bilingualFailure("版式翻译引擎运行失败，请检查独立 Python 环境中的 pdf2zh_next、模型和 API 设置")
	}
	translated := filepath.Join(output, "original.no_watermark.zh.mono.pdf")
	// A PDF-level failure may leave the CLI with status zero. Require its
	// canonical mono result in this fresh work directory before publishing.
	info, err := os.Lstat(translated)
	if err != nil || !info.Mode().IsRegular() {
		return nil, bilingualFailure("版式翻译未生成单语 PDF，请检查模型和 API 设置")
	}
	data, err := limitedBilingualRead(translated, bilingualFileLimit)
	if err != nil || !bytes.HasPrefix(data, []byte("%PDF-")) || !bytes.HasSuffix(bytes.TrimSpace(data), []byte("%%EOF")) {
		return nil, bilingualFailure("版式翻译未生成有效 PDF，或文件超过大小上限")
	}
	return data, nil
}
