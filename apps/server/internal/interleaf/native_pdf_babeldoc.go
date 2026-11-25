package interleaf

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const nativeReadingBabelDOC = "babeldoc"
const babeldocReadingKeyPrefix = "babeldoc-"
const babeldocLegacyReadingVersion = "babeldoc-reading:mono:v1"
const babeldocReadingVersion = "babeldoc-reading:mono:v2"

type babeldocReadingConfig struct {
	engine     babeldocEngine
	connection APIConnection
	model      string
	prompt     string
	renderer   string
	retry      bool
}

func (v *nativeReadingSnapshot) engine() string {
	if v.babeldoc != nil {
		return nativeReadingBabelDOC
	}
	return ""
}

func (v *nativeReadingSnapshot) renderer() string {
	if v.babeldoc != nil {
		return v.babeldoc.renderer
	}
	return nativeReadingRenderer(v.layoutMode)
}

func (s *Server) nativeReadingSnapshotForEngine(documentID, layout, engine string) (*nativeReadingSnapshot, error) {
	if engine == nativeReadingBabelDOC {
		return s.babeldocReadingSnapshot(documentID)
	}
	return s.nativeReadingSnapshot(documentID, layout)
}

func (s *Server) babeldocReadingSnapshot(documentID string) (*nativeReadingSnapshot, error) {
	engine, err := resolveBabelDOCEngine()
	if err != nil {
		return nil, err
	}
	s.configMu.Lock()
	stored, err := s.readNativeAIConfig()
	s.configMu.Unlock()
	if err != nil || stored.Config.NeedsConfiguration != "" || stored.Connection.URL == "" {
		return nil, bilingualFailure("请先在 AI 设置中配置用于 BabelDOC 的翻译连接与模型")
	}
	if stored.Connection.Protocol != "openai" || validateAPIURL(stored.Connection.URL) != nil {
		return nil, bilingualFailure("BabelDOC 原版式需要使用 OpenAI 兼容的翻译连接")
	}
	model := strings.TrimSpace(stored.Config.Models[taskTranslation])
	if model == "" {
		return nil, bilingualFailure("请先在 AI 设置中选择翻译模型")
	}
	config := &babeldocReadingConfig{engine: engine, connection: stored.Connection, model: model, renderer: babeldocReadingVersion}
	if stored.Config.TranslationPrompt != nil {
		config.prompt = *stored.Config.TranslationPrompt
	}

	doc, original, err := s.nativeReadingSource(documentID)
	if err != nil {
		return nil, err
	}
	options, err := json.Marshal([]string{nativeConfigPrint(config.connection, model), config.prompt})
	if err != nil {
		return nil, err
	}
	v := &nativeReadingSnapshot{
		layoutMode: nativeReadingTranslationOnly,
		documentID: doc.ID, paperID: doc.PaperID, original: original,
		originalHash: sourceKey(string(original)), layoutHash: engine.revision,
		translationHash: sourceKey(string(options)), babeldoc: config,
	}
	v.key = v.babeldocCacheKey()
	return v, nil
}

func (v *nativeReadingSnapshot) babeldocCacheKey() string {
	return babeldocReadingKeyPrefix + sourceKey(v.originalHash+":"+v.layoutHash+":"+v.translationHash+":"+v.renderer())
}

func (s *Server) runBabelDOCReading(j *nativeReadingJob, v *nativeReadingSnapshot) error {
	b := j.source
	cfg := v.babeldoc
	if !cfg.retry {
		legacy := *v
		legacyConfig := *cfg
		legacyConfig.renderer = babeldocLegacyReadingVersion
		legacy.babeldoc = &legacyConfig
		legacy.key = legacy.babeldocCacheKey()
		if m, pdf, err := s.readNativeReading(&legacy); err == nil {
			// Reuse eligible files entirely locally. An untranslated legacy file
			// stays in place, and only an explicit retry skips this check.
			return s.publishCheckedBabelDOCReading(j, v, m.nativeReadingReport, pdf)
		}
	}
	work := filepath.Join(b.work, "babeldoc")
	if err := os.Mkdir(work, 0700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(work, "original.pdf"), v.original, 0600); err != nil {
		return err
	}
	j.mu.Lock()
	j.state.Status, j.state.Stage = "running", "layout"
	j.mu.Unlock()
	pdf, err := cfg.engine.translate(b.ctx, work, cfg.connection, cfg.model, cfg.prompt, func(sample babeldocProgressSample) {
		j.mu.Lock()
		j.progress.record(time.Now(), sample)
		j.mu.Unlock()
	})
	if err != nil {
		return err
	}
	report, err := babeldocReadingReport(b.ctx, v.original, pdf)
	if err != nil {
		return bilingualFailure("BabelDOC 译文无法验证为与原文逐页对齐的 PDF，请重试或切换排版")
	}
	if err = os.RemoveAll(work); err != nil {
		return err
	}
	return s.publishCheckedBabelDOCReading(j, v, report, pdf)
}

func (s *Server) publishCheckedBabelDOCReading(j *nativeReadingJob, v *nativeReadingSnapshot, report nativeReadingReport, pdf []byte) error {
	j.mu.Lock()
	j.state.Status, j.state.Stage = "running", "layout"
	j.progress.phase = "saving"
	j.progress.remainingTo = time.Time{}
	j.mu.Unlock()
	if err := checkBabelDOCReadingContent(j.source.ctx, j.source.work, v.original, pdf, len(report.Pages)); err != nil {
		if errors.Is(err, errBabelDOCUntranslated) {
			return bilingualFailure("原版翻译失败：生成的 PDF 大部分仍是原文")
		}
		return err
	}
	return s.publishNativeReading(j, v, report, pdf)
}

func validateBabelDOCReadingReport(report nativeReadingReport) error {
	invalid := errors.New("BabelDOC 阅读缓存的版面报告无效")
	if len(report.Pages) == 0 || len(report.Pages) > babeldocMaxPages || report.Warnings == nil || report.Translated != 0 || report.Original != 0 {
		return invalid
	}
	for i, p := range report.Pages {
		if p.Page != i+1 || !finiteNativeReadingNumber(p.Width) || !finiteNativeReadingNumber(p.Height) ||
			p.Width <= 0 || p.Height <= 0 || p.Width > 14400 || p.Height > 14400 ||
			!validNativeReadingGeometry(p, nativeReadingTranslationOnly) || p.Paragraphs == nil || len(p.Paragraphs) != 0 {
			return invalid
		}
	}
	return nil
}
