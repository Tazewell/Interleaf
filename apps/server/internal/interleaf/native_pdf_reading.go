package interleaf

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const nativeReadingVersion = bilingualPDFVersion + ":reading-v7:side-by-side:keep-original"
const nativeReadingTerminalLimit = 16
const nativeReadingSideBySide = "side-by-side"
const nativeReadingTranslationOnly = "translation-only"

func nativeReadingLayout(layout string) string {
	if layout == "" {
		return nativeReadingSideBySide
	}
	return layout
}
func nativeReadingRenderer(layout string) string {
	if layout == nativeReadingTranslationOnly {
		return nativeReadingVersion + ":translation-only:v1"
	}
	return nativeReadingVersion
}
func validNativeReadingGeometry(p nativeReadingPage, layout string) bool {
	if nativeReadingLayout(layout) == nativeReadingTranslationOnly {
		return p.OutputWidth == p.Width && p.TranslationOffsetX == 0
	}
	return nativeReadingLayout(layout) == nativeReadingSideBySide && p.OutputWidth == 2*p.Width+12 && p.TranslationOffsetX == p.Width+12
}

type nativeReadingReport struct {
	Pages      []nativeReadingPage `json:"pages"`
	Translated int                 `json:"translatedParagraphs"`
	Original   int                 `json:"originalParagraphs"`
	Warnings   []string            `json:"warnings"`
}
type nativeReadingPage struct {
	Page               int                      `json:"page"`
	Width              float64                  `json:"width"`
	Height             float64                  `json:"height"`
	OutputWidth        float64                  `json:"outputWidth"`
	TranslationOffsetX float64                  `json:"translationOffsetX"`
	Paragraphs         []nativeReadingParagraph `json:"paragraphs"`
}
type nativeReadingParagraph struct {
	ID         string `json:"id"`
	BlockID    string `json:"blockId"`
	SourceHash string `json:"sourceHash"`
	Bounds     struct {
		X      float64 `json:"x"`
		Y      float64 `json:"y"`
		Width  float64 `json:"width"`
		Height float64 `json:"height"`
	} `json:"bounds"`
	Translated bool   `json:"translated"`
	Target     string `json:"target,omitempty"`
}
type nativeReadingManifest struct {
	nativeReadingReport
	Engine              string `json:"engine,omitempty"`
	Layout              string `json:"layout,omitempty"`
	Version             int    `json:"version"`
	DocumentID          string `json:"documentId"`
	CacheKey            string `json:"cacheKey"`
	OriginalSHA256      string `json:"originalSha256"`
	LayoutRevision      string `json:"layoutRevision"`
	TranslationRevision string `json:"translationRevision"`
	RendererVersion     string `json:"rendererVersion"`
	PDFSHA256           string `json:"pdfSha256"`
	PDFBytes            int    `json:"pdfBytes"`
	ReportSHA256        string `json:"reportSha256"`
}
type nativeReadingStatus struct {
	ID       string                 `json:"id"`
	CacheKey string                 `json:"cacheKey"`
	Status   string                 `json:"status"`
	Stage    string                 `json:"stage"`
	Done     int                    `json:"done"`
	Total    int                    `json:"total"`
	Error    string                 `json:"error,omitempty"`
	Metadata *nativeReadingManifest `json:"metadata,omitempty"`
	Progress *nativeReadingProgress `json:"progress,omitempty"`
}
type nativeReadingJob struct {
	mu         sync.Mutex
	state      nativeReadingStatus
	documentID string
	layout     string
	engine     string
	source     *bilingualJob
	cancel     context.CancelFunc
	done       chan struct{}
	finishedAt time.Time
	progress   babeldocReadingProgress
}

// Child progress has its own lock because it is also used by PDF exports.
// Terminal reading state is authoritative even when the child's final event
// still describes a composing pass with a different page total.
func (j *nativeReadingJob) snapshotLocked() nativeReadingStatus {
	state := j.state
	if !j.progress.startedAt.IsZero() {
		now := j.finishedAt
		if now.IsZero() {
			now = time.Now()
		}
		state.Progress = j.progress.snapshot(now, state.Status)
	}
	if j.source != nil && (state.Status == "preparing" || state.Status == "running") {
		j.source.mu.Lock()
		progress := j.source.state
		j.source.mu.Unlock()
		if progress.Stage != "" {
			state.Stage, state.Done, state.Total = progress.Stage, progress.Done, progress.Total
		}
	}
	return state
}
func (j *nativeReadingJob) snapshot() nativeReadingStatus {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.snapshotLocked()
}
func (j *nativeReadingJob) cancelWork() {
	j.mu.Lock()
	cancel := j.cancel
	j.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Persistent cache files are independent of this small, temporary status map.
// Expire statuses on the next job request/completion, without retaining a timer
// per result. The caller holds nativeReadingMu; active work is never evicted.
func (s *Server) pruneNativeReadingJobsLocked() {
	type terminal struct {
		id       string
		finished time.Time
	}
	var completed []terminal
	cutoff := time.Now().Add(-bilingualPDFTTL)
	for id, j := range s.nativeReadingJobs {
		j.mu.Lock()
		finished := j.finishedAt
		j.mu.Unlock()
		if !finished.IsZero() && finished.Before(cutoff) {
			delete(s.nativeReadingJobs, id)
		} else if !finished.IsZero() {
			completed = append(completed, terminal{id, finished})
		}
	}
	slices.SortFunc(completed, func(a, b terminal) int { return a.finished.Compare(b.finished) })
	for _, old := range completed[:max(0, len(completed)-nativeReadingTerminalLimit)] {
		delete(s.nativeReadingJobs, old.id)
	}
}
func (s *Server) evictNativeReadingJobs(documentID string) {
	s.nativeReadingMu.Lock()
	defer s.nativeReadingMu.Unlock()
	for id, j := range s.nativeReadingJobs {
		if documentID == "" || j.documentID == documentID {
			delete(s.nativeReadingJobs, id)
		}
	}
}
func (s *Server) finishNativeReadingJob(j *nativeReadingJob, err error) {
	j.mu.Lock()
	if err != nil && j.state.Status != "ready" {
		j.state = j.snapshotLocked()
		j.state.Status = "failed"
		j.state.Error = "原版式对照生成失败；请检查已有译文与版面，或返回原页阅读"
		var public *bilingualError
		if errors.As(err, &public) {
			j.state.Error = public.message
		}
	}
	// Drop frozen paragraphs, translations, targets, and context as soon as the
	// worker exits. Ready polling reloads verified metadata from the disk cache.
	j.source, j.cancel, j.state.Metadata = nil, nil, nil
	j.finishedAt = time.Now()
	j.mu.Unlock()
	s.nativeReadingMu.Lock()
	s.pruneNativeReadingJobsLocked()
	s.nativeReadingMu.Unlock()
}

type nativeReadingSnapshot struct {
	layoutMode                                                          string
	documentID, paperID, originalHash, layoutHash, translationHash, key string
	original, layout                                                    []byte
	manifest                                                            layoutManifest
	reading                                                             []TranslationBlock
	babeldoc                                                            *babeldocReadingConfig
}

func (s *Server) nativeReadingSource(documentID string) (Document, []byte, error) {
	d, e := s.Store.Document(documentID)
	if e != nil || d.DeletedAt != "" || d.Type != "pdf" {
		return Document{}, nil, errors.New("PDF 文档不存在或已删除")
	}
	if d.PaperID != "" {
		p, e := s.Store.PaperItem(d.PaperID)
		if e != nil || p.DeletedAt != "" {
			return Document{}, nil, errors.New("所属文献已删除")
		}
	}
	original, e := limitedBilingualRead(s.Store.File(d), bilingualFileLimit)
	return d, original, e
}

func (s *Server) nativeReadingSnapshot(documentID string, layouts ...string) (*nativeReadingSnapshot, error) {
	d, original, e := s.nativeReadingSource(documentID)
	if e != nil {
		return nil, e
	}
	raw, e := limitedBilingualRead(filepath.Join(s.analysisDir(d.ID), "manifest.json"), 32<<20)
	if e != nil {
		return nil, e
	}
	var m struct {
		layoutManifest
		SchemaVersion int    `json:"schemaVersion"`
		InputSHA256   string `json:"inputSHA256"`
	}
	if json.Unmarshal(raw, &m) != nil || m.SchemaVersion != 1 || m.Pages < 1 || m.InputSHA256 != sourceKey(string(original)) {
		return nil, errors.New("请先完成与原文匹配的 PDF 版面解析")
	}
	for p := 1; p <= m.Pages; p++ {
		if len(m.ParsedPages) > 0 && !slices.Contains(m.ParsedPages, p) || slices.Contains(m.IncompletePages, p) {
			return nil, errors.New("请先完成所有页面解析")
		}
	}
	reading, e := s.visibleTranslations(d.ID, m.layoutManifest)
	if e != nil {
		return nil, e
	}
	// Only visible complete content affects output. Ignore transient error/progress fields.
	stable := []TranslationBlock{}
	for _, t := range reading {
		if t.Status == "complete" {
			t.Error = ""
			stable = append(stable, t)
		}
	}
	slices.SortFunc(stable, func(a, b TranslationBlock) int {
		return strings.Compare(a.BlockID+":"+a.SourceHash, b.BlockID+":"+b.SourceHash)
	})
	data, _ := json.Marshal(stable)
	v := &nativeReadingSnapshot{documentID: d.ID, paperID: d.PaperID, original: original, layout: raw, manifest: m.layoutManifest, reading: stable, originalHash: sourceKey(string(original)), layoutHash: sourceKey(string(raw)), translationHash: sourceKey(string(data))}
	layout := nativeReadingSideBySide
	if len(layouts) > 0 {
		layout = nativeReadingLayout(layouts[0])
	}
	if layout != nativeReadingSideBySide && layout != nativeReadingTranslationOnly {
		return nil, errors.New("invalid reading layout")
	}
	v.setLayout(layout)
	return v, nil
}
func (v *nativeReadingSnapshot) setLayout(layout string) {
	v.layoutMode = nativeReadingLayout(layout)
	v.key = sourceKey(v.originalHash + ":" + v.layoutHash + ":" + v.translationHash + ":" + nativeReadingRenderer(v.layoutMode))
}

// Identify the requested cache from a fresh source snapshot, never untrusted metadata.
func (s *Server) nativeReadingSnapshotForKey(documentID, key string) (*nativeReadingSnapshot, error) {
	if suffix, ok := strings.CutPrefix(key, babeldocReadingKeyPrefix); ok && nativeReadingSHA256(suffix) {
		return s.babeldocReadingSnapshot(documentID)
	}
	v, e := s.nativeReadingSnapshot(documentID)
	if e != nil {
		return nil, e
	}
	if v.key == key {
		return v, nil
	}
	v.setLayout(nativeReadingTranslationOnly)
	if v.key != key {
		return nil, errors.New("stale reading cache")
	}
	return v, nil
}
func (s *Server) registerNativePDFReadingRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/documents/{id}/native-pdf-reading", s.createNativeReading)
	m.HandleFunc("GET /api/documents/{id}/native-pdf-reading/{job}", s.nativeReadingStatus)
	m.HandleFunc("DELETE /api/documents/{id}/native-pdf-reading/{job}", s.cancelNativeReading)
	m.HandleFunc("GET /api/documents/{id}/native-pdf-reading/cache/{key}/metadata", s.nativeReadingMetadata)
	m.HandleFunc("GET /api/documents/{id}/native-pdf-reading/cache/{key}/file", s.nativeReadingFile)
	m.HandleFunc("GET /pub/{cap}/{id}/native-pdf-reading/{key}/file", func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.PathValue("cap")), []byte(s.Token)) != 1 {
			fail(w, 401, "无效的访问凭证")
			return
		}
		s.nativeReadingFile(w, r)
	})
}
func (s *Server) nativeReadingDir(doc, key string) string {
	return filepath.Join(s.analysisDir(doc), "native-pdf-reading", key)
}
func (s *Server) readNativeReading(v *nativeReadingSnapshot) (*nativeReadingManifest, []byte, error) {
	dir := s.nativeReadingDir(v.documentID, v.key)
	raw, e := limitedBilingualRead(filepath.Join(dir, "metadata.json"), 32<<20)
	if e != nil {
		return nil, nil, e
	}
	// Omission is the only legacy default; explicit null/empty/unknown layouts are invalid.
	var identity struct {
		Layout json.RawMessage `json:"layout"`
		Engine json.RawMessage `json:"engine"`
	}
	if json.Unmarshal(raw, &identity) != nil {
		return nil, nil, errors.New("阅读缓存布局无效")
	}
	if len(identity.Layout) > 0 {
		var layout string
		if json.Unmarshal(identity.Layout, &layout) != nil || (layout != nativeReadingSideBySide && layout != nativeReadingTranslationOnly) {
			return nil, nil, errors.New("阅读缓存布局无效")
		}
	}
	if len(identity.Engine) > 0 {
		var engine string
		if json.Unmarshal(identity.Engine, &engine) != nil || engine != nativeReadingBabelDOC {
			return nil, nil, errors.New("阅读缓存引擎无效")
		}
	}
	var m nativeReadingManifest
	if json.Unmarshal(raw, &m) != nil || m.Version != 1 || m.DocumentID != v.documentID || m.CacheKey != v.key || m.OriginalSHA256 != v.originalHash || m.LayoutRevision != v.layoutHash || m.TranslationRevision != v.translationHash || m.RendererVersion != v.renderer() || m.Engine != v.engine() || nativeReadingLayout(m.Layout) != nativeReadingLayout(v.layoutMode) {
		return nil, nil, errors.New("阅读缓存修订无效")
	}
	if e := validateCachedNativeReadingReport(m.nativeReadingReport, v); e != nil {
		return nil, nil, e
	}
	if !nativeReadingSHA256(m.ReportSHA256) || m.ReportSHA256 != nativeReadingReportHash(m.nativeReadingReport) {
		return nil, nil, errors.New("阅读缓存报告校验失败")
	}
	pdf, e := limitedBilingualRead(filepath.Join(dir, "reading.pdf"), bilingualFileLimit)
	if e != nil || !bytes.HasPrefix(pdf, []byte("%PDF-")) || len(pdf) != m.PDFBytes || sourceKey(string(pdf)) != m.PDFSHA256 {
		return nil, nil, errors.New("阅读缓存文件缺失或损坏")
	}
	return &m, pdf, nil
}
func (s *Server) createNativeReading(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Layout json.RawMessage `json:"layout"`
		Engine json.RawMessage `json:"engine"`
		Retry  json.RawMessage `json:"retry"`
	}
	if !decode(w, r, &body) {
		return
	}
	layout := nativeReadingSideBySide
	if len(body.Layout) > 0 {
		if json.Unmarshal(body.Layout, &layout) != nil || string(body.Layout) == "null" || (layout != nativeReadingSideBySide && layout != nativeReadingTranslationOnly) {
			fail(w, 400, "无效的阅读布局")
			return
		}
	}
	var engine string
	if len(body.Engine) > 0 {
		if json.Unmarshal(body.Engine, &engine) != nil || engine != nativeReadingBabelDOC || layout != nativeReadingTranslationOnly {
			fail(w, 400, "无效的原版式翻译引擎或布局")
			return
		}
	}
	var retry bool
	if len(body.Retry) > 0 && (engine != nativeReadingBabelDOC || string(body.Retry) == "null" || json.Unmarshal(body.Retry, &retry) != nil) {
		fail(w, 400, "无效的原版式翻译重试请求")
		return
	}
	ctx, finish, e := s.beginDocumentTask(context.Background(), r.PathValue("id"))
	if e != nil {
		fail(w, 409, "文档不可用")
		return
	}
	accepted := false
	defer func() {
		if !accepted {
			finish()
		}
	}()
	s.nativeReadingMu.Lock()
	defer s.nativeReadingMu.Unlock()
	s.pruneNativeReadingJobsLocked()
	v, e := s.nativeReadingSnapshotForEngine(r.PathValue("id"), layout, engine)
	if e != nil {
		var public *bilingualError
		message := "请先完成原文和版面解析后重试"
		if engine == nativeReadingBabelDOC {
			message = "无法读取用于 BabelDOC 翻译的 PDF"
			if errors.As(e, &public) {
				message = public.message
			}
		}
		fail(w, 409, message)
		return
	}
	if m, _, e := s.readNativeReading(v); e == nil {
		respond(w, 200, nativeReadingStatus{ID: v.key, CacheKey: v.key, Status: "ready", Stage: "ready", Done: len(m.Pages), Total: len(m.Pages), Metadata: m})
		return
	}
	for _, j := range s.nativeReadingJobs {
		j.mu.Lock()
		state := j.snapshotLocked()
		active := j.documentID == v.documentID && state.CacheKey == v.key && (state.Status == "preparing" || state.Status == "running")
		j.mu.Unlock()
		if active {
			respond(w, 202, state)
			return
		}
	}
	root := filepath.Join(s.analysisDir(v.documentID), "native-pdf-reading")
	if os.MkdirAll(root, 0700) != nil {
		fail(w, 500, "无法创建阅读缓存")
		return
	}
	work, e := os.MkdirTemp(root, "work-")
	if e != nil {
		fail(w, 500, "无法创建阅读任务")
		return
	}
	child, cancel := context.WithTimeout(ctx, bilingualPDFTTL)
	source := &bilingualJob{documentID: v.documentID, paperID: v.paperID, work: work, originalHash: v.originalHash, layoutHash: v.layoutHash, reading: v.reading, ctx: child, targets: map[string]string{}}
	j := &nativeReadingJob{state: nativeReadingStatus{ID: id(), CacheKey: v.key, Status: "preparing", Stage: "prepare"}, documentID: v.documentID, layout: v.layoutMode, engine: engine, source: source, cancel: cancel, done: make(chan struct{})}
	if v.babeldoc != nil {
		v.babeldoc.retry = retry
		j.progress.start(time.Now())
	}
	if s.nativeReadingJobs == nil {
		s.nativeReadingJobs = map[string]*nativeReadingJob{}
	}
	s.nativeReadingJobs[j.state.ID] = j
	initial := j.snapshotLocked()
	accepted = true
	go func() {
		defer finish()
		defer close(j.done)
		defer cancel()
		defer os.RemoveAll(work)
		s.finishNativeReadingJob(j, s.runNativeReading(j, v))
	}()
	respond(w, 202, initial)
}
func (s *Server) runNativeReading(j *nativeReadingJob, v *nativeReadingSnapshot) error {
	if v.babeldoc != nil {
		return s.runBabelDOCReading(j, v)
	}
	b := j.source
	for name, data := range map[string][]byte{"original.pdf": v.original, "layout.json": v.layout} {
		if e := os.WriteFile(filepath.Join(b.work, name), data, 0600); e != nil {
			return e
		}
	}
	args := []string{"--stage", "prepare", "--input", filepath.Join(b.work, "original.pdf"), "--layout", filepath.Join(b.work, "layout.json"), "--prepared", filepath.Join(b.work, "prepared.json"), "--reading", "true"}
	if e := s.bilingualProcessor(b, args); e != nil {
		return e
	}
	raw, e := limitedBilingualRead(filepath.Join(b.work, "prepared.json"), 32<<20)
	if e != nil {
		return e
	}
	if json.Unmarshal(raw, &b.prepared) != nil || b.prepared.Version != 1 || b.prepared.OriginalSHA256 != v.originalHash || b.prepared.Revision != v.layoutHash || len(b.prepared.Pages) != v.manifest.Pages {
		return errors.New("invalid prepared PDF")
	}
	blocks := make(map[string]PDFBlock, len(v.manifest.Blocks))
	for _, block := range v.manifest.Blocks {
		blocks[block.ID] = block
	}
	saved := make(map[string]TranslationBlock, len(b.reading))
	for _, translation := range b.reading {
		saved[translation.BlockID] = translation
	}
	savedHashes := map[string]string{}
	ids := map[string]bool{}
	for i, page := range b.prepared.Pages {
		if page.Page != i+1 {
			return errors.New("invalid page")
		}
		for _, p := range page.Paragraphs {
			if p.ID == "" || ids[p.ID] || p.Page != page.Page {
				return errors.New("invalid paragraph")
			}
			ids[p.ID] = true
			block, ok := blocks[p.BlockID]
			if !ok || block.Page != p.Page {
				return errors.New("invalid reading block")
			}
			translation := saved[p.BlockID]
			if target := reuseNativeReadingTranslation(p, translationSource(block), translation); target != "" {
				b.targets[p.ID] = target
				savedHashes[p.ID] = translation.SourceHash
			}
		}
	}
	if len(b.targets) == 0 {
		return bilingualFailure("没有可安全复用的译文，请先在译文视图完成翻译，或返回原页阅读")
	}
	raw, _ = json.Marshal(b.targets)
	if len(raw) > bilingualTargetLimit {
		return errors.New("targets too large")
	}
	if e = os.WriteFile(filepath.Join(b.work, "targets.json"), raw, 0600); e != nil {
		return e
	}
	j.mu.Lock()
	j.state.Status = "running"
	j.state.Stage = "layout"
	j.state.Done, j.state.Total = 0, len(b.prepared.Pages)
	b.mu.Lock()
	b.state.Stage, b.state.Done, b.state.Total = "layout", 0, len(b.prepared.Pages)
	b.mu.Unlock()
	j.mu.Unlock()
	args = []string{"--stage", "render", "--input", filepath.Join(b.work, "original.pdf"), "--prepared", filepath.Join(b.work, "prepared.json"), "--targets", filepath.Join(b.work, "targets.json"), "--output", filepath.Join(b.work, "output.pdf"), "--mode", nativeReadingLayout(v.layoutMode), "--reading", "true", "--reading-metadata", filepath.Join(b.work, "report.json")}
	if e = s.bilingualProcessor(b, args); e != nil {
		return e
	}
	raw, e = limitedBilingualRead(filepath.Join(b.work, "report.json"), 32<<20)
	if e != nil {
		return e
	}
	var report nativeReadingReport
	if json.Unmarshal(raw, &report) != nil {
		return errors.New("invalid reading report")
	}
	if e = validateNativeReadingReport(report, b, v.layoutMode); e != nil {
		return e
	}
	// The processor reports the PDF extraction's identity. After validating it,
	// bind displayed translations to the saved block so annotations can match it.
	for _, page := range report.Pages {
		for i, paragraph := range page.Paragraphs {
			if paragraph.Translated {
				page.Paragraphs[i].SourceHash = savedHashes[paragraph.ID]
			}
		}
	}
	pdf, e := limitedBilingualRead(filepath.Join(b.work, "output.pdf"), bilingualFileLimit)
	if e != nil || !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		return errors.New("invalid PDF")
	}
	// Publish only the derived PDF and completion marker, not frozen source/targets.
	for _, name := range []string{"original.pdf", "layout.json", "prepared.json", "targets.json", "output.pdf", "report.json"} {
		if e = os.Remove(filepath.Join(b.work, name)); e != nil {
			return e
		}
	}
	return s.publishNativeReading(j, v, report, pdf)
}

func (s *Server) publishNativeReading(j *nativeReadingJob, v *nativeReadingSnapshot, report nativeReadingReport, pdf []byte) error {
	if err := validateCachedNativeReadingReport(report, v); err != nil {
		return err
	}
	m := nativeReadingManifest{
		nativeReadingReport: report,
		Engine:              v.engine(), Layout: v.layoutMode, Version: 1,
		DocumentID: v.documentID, CacheKey: v.key, OriginalSHA256: v.originalHash,
		LayoutRevision: v.layoutHash, TranslationRevision: v.translationHash,
		RendererVersion: v.renderer(), PDFSHA256: sourceKey(string(pdf)), PDFBytes: len(pdf),
		ReportSHA256: nativeReadingReportHash(report),
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	b := j.source
	if err = os.WriteFile(filepath.Join(b.work, "reading.pdf"), pdf, 0600); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(b.work, "metadata.json"), raw, 0600); err != nil {
		return err
	}
	s.nativeReadingMu.Lock()
	defer s.nativeReadingMu.Unlock()
	current, err := s.nativeReadingSnapshotForEngine(v.documentID, v.layoutMode, v.engine())
	if err != nil || current.key != v.key || b.ctx.Err() != nil {
		return errors.New("stale reading task")
	}
	dir := s.nativeReadingDir(v.documentID, v.key)
	// Only a verified, complete directory becomes visible. Metadata is the completion marker.
	if err = os.RemoveAll(dir); err != nil {
		return err
	}
	if err = os.Rename(b.work, dir); err != nil {
		return err
	}
	j.mu.Lock()
	j.state.Status = "ready"
	j.state.Stage = "ready"
	j.state.Done, j.state.Total = len(report.Pages), len(report.Pages)
	j.mu.Unlock()
	return nil
}
func validateNativeReadingReport(report nativeReadingReport, b *bilingualJob, layouts ...string) error {
	layout := nativeReadingSideBySide
	if len(layouts) > 0 {
		layout = layouts[0]
	}
	if len(report.Pages) != len(b.prepared.Pages) {
		return errors.New("missing reading pages")
	}
	translated, original := 0, 0
	for i, p := range report.Pages {
		if p.Page != i+1 || p.Width <= 0 || p.Height <= 0 || !validNativeReadingGeometry(p, layout) || len(p.Paragraphs) != len(b.prepared.Pages[i].Paragraphs) {
			return errors.New("invalid reading geometry")
		}
		for k, q := range p.Paragraphs {
			source := b.prepared.Pages[i].Paragraphs[k]
			if q.ID != source.ID || q.BlockID != source.BlockID || q.SourceHash != translationHash(source.OriginalSource) || q.Bounds.Width <= 0 || q.Bounds.Height <= 0 {
				return errors.New("invalid reading paragraph")
			}
			if q.Translated {
				if q.Target == "" || q.Target != b.targets[q.ID] {
					return errors.New("unexpected reading target")
				}
				translated++
			} else {
				if q.Target != "" {
					return errors.New("retained target")
				}
				original++
			}
		}
	}
	if translated != report.Translated || original != report.Original {
		return errors.New("invalid reading counts")
	}
	return nil
}
func (s *Server) nativeReadingJob(r *http.Request) *nativeReadingJob {
	s.nativeReadingMu.Lock()
	defer s.nativeReadingMu.Unlock()
	s.pruneNativeReadingJobsLocked()
	j := s.nativeReadingJobs[r.PathValue("job")]
	if j != nil && j.documentID == r.PathValue("id") {
		return j
	}
	return nil
}
func (s *Server) nativeReadingStatus(w http.ResponseWriter, r *http.Request) {
	j := s.nativeReadingJob(r)
	if j == nil {
		fail(w, 404, "阅读任务不存在")
		return
	}
	_, finish, e := s.beginDocumentTask(r.Context(), r.PathValue("id"))
	if e != nil {
		fail(w, 409, "文档已变化")
		return
	}
	defer finish()
	state := j.snapshot()
	v, e := s.nativeReadingSnapshotForEngine(r.PathValue("id"), j.layout, j.engine)
	if e != nil || v.key != state.CacheKey {
		j.cancelWork()
		fail(w, 409, "原文或译文已变化，请重新生成")
		return
	}
	state = j.snapshot()
	if state.Status == "ready" {
		m, _, e := s.readNativeReading(v)
		if e != nil {
			fail(w, 409, "阅读缓存缺失或损坏，请重新生成")
			return
		}
		state.Metadata = m
	}
	respond(w, 200, state)
}
func (s *Server) cancelNativeReading(w http.ResponseWriter, r *http.Request) {
	if j := s.nativeReadingJob(r); j != nil {
		j.cancelWork()
		<-j.done
		s.nativeReadingMu.Lock()
		delete(s.nativeReadingJobs, r.PathValue("job"))
		s.nativeReadingMu.Unlock()
	}
	w.WriteHeader(204)
}
func (s *Server) nativeReadingCache(w http.ResponseWriter, r *http.Request, file bool) {
	_, finish, e := s.beginDocumentTask(r.Context(), r.PathValue("id"))
	if e != nil {
		fail(w, 409, "文档已变化或删除")
		return
	}
	var once sync.Once
	release := func() { once.Do(finish) }
	defer release()
	v, e := s.nativeReadingSnapshotForKey(r.PathValue("id"), r.PathValue("key"))
	if e != nil || v.key != r.PathValue("key") {
		fail(w, 409, "原文或译文已变化，请重新生成")
		return
	}
	m, pdf, e := s.readNativeReading(v)
	if e != nil {
		fail(w, 409, "阅读缓存缺失或损坏，请重新生成")
		return
	}
	// File bytes are frozen in memory; slow clients must not retain a document task.
	release()
	w.Header().Set("Cache-Control", "no-store")
	if !file {
		respond(w, 200, m)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	http.ServeContent(w, r, "reading.pdf", time.Time{}, bytes.NewReader(pdf))
}
func (s *Server) nativeReadingMetadata(w http.ResponseWriter, r *http.Request) {
	s.nativeReadingCache(w, r, false)
}
func (s *Server) nativeReadingFile(w http.ResponseWriter, r *http.Request) {
	s.nativeReadingCache(w, r, true)
}

// The renderer report is part of cache integrity, including retained original
// paragraphs whose extracted source text need not equal the layout OCR text.
func nativeReadingReportHash(report nativeReadingReport) string {
	raw, _ := json.Marshal(report)
	return sourceKey(string(raw))
}
func validateCachedNativeReadingReport(report nativeReadingReport, v *nativeReadingSnapshot) error {
	if v.babeldoc != nil {
		return validateBabelDOCReadingReport(report)
	}
	invalid := func() error { return errors.New("阅读缓存报告结构或译文身份无效") }
	if report.Pages == nil || len(report.Pages) != v.manifest.Pages || report.Warnings == nil || report.Translated < 0 || report.Original < 0 {
		return invalid()
	}
	blocks := make(map[string]PDFBlock, len(v.manifest.Blocks))
	for _, b := range v.manifest.Blocks {
		blocks[b.ID] = b
	}
	reading := make(map[string]TranslationBlock, len(v.reading))
	for _, t := range v.reading {
		reading[t.BlockID+":"+t.SourceHash] = t
	}
	ids := map[string]bool{}
	translated, original := 0, 0
	for i, p := range report.Pages {
		if p.Page != i+1 || !finiteNativeReadingNumber(p.Width) || !finiteNativeReadingNumber(p.Height) || p.Width <= 0 || p.Height <= 0 || p.Width > 14400 || p.Height > 14400 || !validNativeReadingGeometry(p, v.layoutMode) || p.Paragraphs == nil {
			return invalid()
		}
		for _, q := range p.Paragraphs {
			b, ok := blocks[q.BlockID]
			bounds := q.Bounds
			if !ok || b.Page != p.Page || q.ID == "" || ids[q.ID] || !nativeReadingSHA256(q.SourceHash) || !finiteNativeReadingNumber(bounds.X) || !finiteNativeReadingNumber(bounds.Y) || !finiteNativeReadingNumber(bounds.Width) || !finiteNativeReadingNumber(bounds.Height) || bounds.X < 0 || bounds.Y < 0 || bounds.Width <= 0 || bounds.Height <= 0 || bounds.X+bounds.Width > p.Width+0.01 || bounds.Y+bounds.Height > p.Height+0.01 {
				return invalid()
			}
			ids[q.ID] = true
			if !q.Translated {
				if q.Target != "" {
					return invalid()
				}
				original++
				continue
			}
			t, ok := reading[q.BlockID+":"+q.SourceHash]
			source := translationSource(b)
			prepared := nativeParagraph{BlockID: q.BlockID, Source: source, OriginalSource: source}
			if !ok || reuseNativeReadingTranslation(prepared, source, t) != q.Target || q.Target == "" {
				return invalid()
			}
			translated++
		}
	}
	if translated != report.Translated || original != report.Original {
		return invalid()
	}
	return nil
}
func finiteNativeReadingNumber(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }
func nativeReadingSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, e := hex.DecodeString(s)
	return e == nil && strings.ToLower(s) == s
}
