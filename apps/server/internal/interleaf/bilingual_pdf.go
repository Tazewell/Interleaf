package interleaf

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const bilingualPDFTTL = 30 * time.Minute
const bilingualPDFVersion = "native-bilingual-pdf-v1:noto-sans-sc-v1"
const bilingualFileLimit int64 = 512 << 20
const bilingualTargetLimit = 32 << 20

type bilingualOptions struct {
	Layout string `json:"layout"`
	From   *int   `json:"fromPage,omitempty"`
	To     *int   `json:"toPage,omitempty"`
}
type bilingualStartRequest struct {
	TranslateMissing  bool  `json:"translateMissing"`
	KeepOriginalPages []int `json:"keepOriginalPages"`
}
type bilingualPreflight struct {
	Pages             int      `json:"pages"`
	OutputPages       int      `json:"outputPages"`
	MissingParagraphs int      `json:"missingParagraphs"`
	NoTextPages       []int    `json:"noTextPages"`
	APIConfigured     bool     `json:"apiConfigured"`
	Warnings          []string `json:"warnings"`
}
type bilingualStatus struct {
	ID        string              `json:"id"`
	Status    string              `json:"status"`
	Stage     string              `json:"stage"`
	Done      int                 `json:"done"`
	Total     int                 `json:"total"`
	Preflight *bilingualPreflight `json:"preflight,omitempty"`
	Error     string              `json:"error,omitempty"`
}
type nativeParagraph struct {
	ID             string `json:"id"`
	BlockID        string `json:"blockId"`
	Page           int    `json:"page"`
	Source         string `json:"source"`
	OriginalSource string `json:"originalSource"`
	Formulas       []struct {
		Token string `json:"token"`
	} `json:"formulas"`
}
type nativePrepared struct {
	Version        int    `json:"version"`
	OriginalSHA256 string `json:"originalSha256"`
	Revision       string `json:"revision"`
	TotalPages     int    `json:"totalPages"`
	Pages          []struct {
		Page       int               `json:"page"`
		Paragraphs []nativeParagraph `json:"paragraphs"`
	} `json:"pages"`
	NoTextPages []int    `json:"noTextPages"`
	Warnings    []string `json:"warnings"`
}
type bilingualJob struct {
	mu           sync.Mutex
	state        bilingualStatus
	documentID   string
	paperID      string
	work         string
	originalHash string
	layoutHash   string
	options      bilingualOptions
	config       nativeAIStored
	prepared     nativePrepared
	reading      []TranslationBlock
	targets      map[string]string
	conn         APIConnection
	completion   completionRequest
	apiError     error
	start        chan bilingualStartRequest
	ctx          context.Context
	cancel       context.CancelFunc
	done         chan struct{}
}

func (s *Server) registerBilingualPDFRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/documents/{id}/bilingual-pdf", s.createBilingualPDF)
	m.HandleFunc("GET /api/documents/{id}/bilingual-pdf/{job}", s.bilingualPDFStatus)
	m.HandleFunc("POST /api/documents/{id}/bilingual-pdf/{job}/start", s.startBilingualPDF)
	m.HandleFunc("DELETE /api/documents/{id}/bilingual-pdf/{job}", s.cancelBilingualPDF)
	m.HandleFunc("GET /api/documents/{id}/bilingual-pdf/{job}/file", s.bilingualPDFFile)
	m.HandleFunc("POST /api/documents/{id}/bilingual-pdf/{job}/attachment", s.attachBilingualPDF)
}
func limitedBilingualRead(path string, limit int64) ([]byte, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("导出文件超过大小上限或不是普通文件")
	}
	b, e := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(b)) > limit {
		return nil, errors.New("导出文件超过大小上限")
	}
	return b, e
}
func bilingualHash(path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := sha256.New()
	n, e := io.Copy(h, io.LimitReader(f, bilingualFileLimit+1))
	if e != nil || n > bilingualFileLimit {
		return "", errors.New("原文不可读或超过大小上限")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func (s *Server) initBilingualPDF() error {
	root := filepath.Join(s.Store.Root, "export-temp", "bilingual-pdf")
	for _, path := range []string{filepath.Dir(root), root} {
		if e := os.MkdirAll(path, 0700); e != nil {
			return e
		}
		info, e := os.Lstat(path)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("导出临时目录不是普通目录")
		}
	}
	entries, e := os.ReadDir(root)
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "session-") {
			continue
		}
		if _, e := strconv.ParseUint(strings.TrimPrefix(entry.Name(), "session-"), 10, 64); e != nil {
			continue
		}
		if e = os.RemoveAll(filepath.Join(root, entry.Name())); e != nil {
			return e
		}
	}
	s.bilingualRoot, e = os.MkdirTemp(root, "session-")
	return e
}
func (s *Server) validateBilingualSource(j *bilingualJob) error {
	if j.ctx.Err() != nil {
		return errors.New("导出任务已取消或过期")
	}
	d, e := s.Store.Document(j.documentID)
	if e != nil || d.DeletedAt != "" || d.Type != "pdf" {
		return errors.New("原文已删除或不再可用")
	}
	if j.paperID != "" {
		p, e := s.Store.PaperItem(j.paperID)
		if e != nil || p.DeletedAt != "" || p.ID != d.PaperID {
			return errors.New("原文所属文献已变化或删除")
		}
	}
	h, e := bilingualHash(s.Store.File(d))
	if e != nil || h != j.originalHash {
		return errors.New("原文已变化，请重新创建导出任务")
	}
	b, e := limitedBilingualRead(filepath.Join(s.analysisDir(d.ID), "manifest.json"), 32<<20)
	if e != nil || sourceKey(string(b)) != j.layoutHash {
		return errors.New("版面已变化，请重新创建导出任务")
	}
	return nil
}
func (s *Server) createBilingualPDF(w http.ResponseWriter, r *http.Request) {
	var options bilingualOptions
	if !decode(w, r, &options) {
		return
	}
	state, status, err := s.newBilingualPDF(r, options)
	if err != nil {
		fail(w, status, err.Error())
		return
	}
	respond(w, 202, state)
}
func (s *Server) newBilingualPDF(r *http.Request, options bilingualOptions) (bilingualStatus, int, error) {
	if options.Layout != "side-by-side" && options.Layout != "alternating" || options.From != nil && *options.From < 1 || options.To != nil && *options.To < 1 {
		return bilingualStatus{}, 400, errors.New("请选择有效的布局和页码范围")
	}
	d, e := s.Store.Document(r.PathValue("id"))
	if e != nil {
		return bilingualStatus{}, 404, errors.New("文档不存在")
	}
	if d.Type != "pdf" || d.DeletedAt != "" {
		return bilingualStatus{}, 400, errors.New("仅支持未删除的 PDF")
	}
	s.bilingualMu.Lock()
	defer s.bilingualMu.Unlock()
	if len(s.bilingualJobs) >= 2 {
		return bilingualStatus{}, 409, errors.New("最多同时保留两个导出任务，请取消已有任务后重试")
	}
	parent, deadline := context.WithTimeout(context.Background(), bilingualPDFTTL)
	ctx, finish, e := s.beginDocumentTask(parent, d.ID)
	if e != nil {
		deadline()
		return bilingualStatus{}, 409, errors.New("文档正在删除或应用正在关闭")
	}
	accepted := false
	var work string
	defer func() {
		if !accepted {
			deadline()
			if work != "" {
				os.RemoveAll(work)
			}
			finish()
		}
	}()
	raw, e := limitedBilingualRead(filepath.Join(s.analysisDir(d.ID), "manifest.json"), 32<<20)
	var m struct {
		layoutManifest
		SchemaVersion int    `json:"schemaVersion"`
		InputSHA256   string `json:"inputSHA256"`
	}
	if e != nil || json.Unmarshal(raw, &m) != nil || m.SchemaVersion != 1 || m.Pages < 1 {
		return bilingualStatus{}, 409, errors.New("请先完成 PDF 版面解析后再导出")
	}
	from, to := 1, m.Pages
	if options.From != nil {
		from = *options.From
	}
	if options.To != nil {
		to = *options.To
	}
	if from > to || to > m.Pages {
		return bilingualStatus{}, 400, errors.New("页码范围超出 PDF")
	}
	for p := from; p <= to; p++ {
		if len(m.ParsedPages) > 0 && !slices.Contains(m.ParsedPages, p) || slices.Contains(m.IncompletePages, p) {
			return bilingualStatus{}, 409, errors.New("所选页尚未完成版面解析，请解析后重试")
		}
	}
	if s.bilingualRoot == "" {
		e = s.initBilingualPDF()
	}
	if e != nil {
		return bilingualStatus{}, 500, errors.New("无法创建导出临时目录")
	}
	work, e = os.MkdirTemp(s.bilingualRoot, "job-")
	if e != nil {
		return bilingualStatus{}, 500, errors.New("无法创建导出任务目录")
	}
	// Read and copy once, then verify the live file again before accepting.
	input, e := os.Open(s.Store.File(d))
	if e != nil {
		return bilingualStatus{}, 409, errors.New("原文不可读")
	}
	output, e := os.OpenFile(filepath.Join(work, "original.pdf"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		input.Close()
		return bilingualStatus{}, 500, errors.New("无法冻结原文")
	}
	hash := sha256.New()
	n, e := io.Copy(io.MultiWriter(output, hash), io.LimitReader(input, bilingualFileLimit+1))
	input.Close()
	closeErr := output.Close()
	if e != nil || closeErr != nil || n > bilingualFileLimit {
		return bilingualStatus{}, 400, errors.New("原文不可读或超过导出大小上限")
	}
	originalHash := hex.EncodeToString(hash.Sum(nil))
	if m.InputSHA256 != originalHash {
		return bilingualStatus{}, 409, errors.New("版面与原文不匹配，请重新解析")
	}
	if e = os.WriteFile(filepath.Join(work, "layout.json"), raw, 0600); e != nil {
		return bilingualStatus{}, 500, errors.New("无法冻结版面")
	}
	reading, e := s.visibleTranslations(d.ID, m.layoutManifest)
	if e != nil {
		return bilingualStatus{}, 500, errors.New("无法读取已有译文")
	}
	s.configMu.Lock()
	frozen, configErr := s.readNativeAIConfig()
	s.configMu.Unlock()
	if configErr != nil {
		return bilingualStatus{}, 500, configErr
	}
	j := &bilingualJob{state: bilingualStatus{ID: id(), Status: "preparing", Stage: "prepare"}, documentID: d.ID, paperID: d.PaperID, work: work, originalHash: originalHash, layoutHash: sourceKey(string(raw)), options: options, config: frozen, reading: reading, targets: map[string]string{}, start: make(chan bilingualStartRequest, 1), ctx: ctx, cancel: deadline, done: make(chan struct{})}
	if e = s.validateBilingualSource(j); e != nil {
		return bilingualStatus{}, 409, errors.New(e.Error())
	}
	if s.bilingualJobs == nil {
		s.bilingualJobs = map[string]*bilingualJob{}
	}
	s.bilingualJobs[j.state.ID] = j
	accepted = true
	initial := j.state
	go func() {
		defer close(j.done)
		defer finish()
		defer deadline()
		defer func() {
			j.mu.Lock()
			os.RemoveAll(j.work)
			j.mu.Unlock()
			s.bilingualMu.Lock()
			delete(s.bilingualJobs, j.state.ID)
			s.bilingualMu.Unlock()
		}()
		s.runBilingualPDF(j)
	}()
	return initial, 202, nil
}
func (s *Server) bilingualJob(r *http.Request) *bilingualJob {
	s.bilingualMu.Lock()
	defer s.bilingualMu.Unlock()
	j := s.bilingualJobs[r.PathValue("job")]
	if j != nil && j.documentID == r.PathValue("id") {
		return j
	}
	return nil
}
func (s *Server) bilingualPDFStatus(w http.ResponseWriter, r *http.Request) {
	j := s.bilingualJob(r)
	if j == nil {
		fail(w, 404, "导出任务不存在或已过期")
		return
	}
	j.mu.Lock()
	e := s.validateBilingualSource(j)
	state := j.state
	j.mu.Unlock()
	if e != nil {
		j.cancel()
		fail(w, 409, e.Error())
		return
	}
	respond(w, 200, state)
}
func (s *Server) startBilingualPDF(w http.ResponseWriter, r *http.Request) {
	var input struct {
		TranslateMissing  *bool  `json:"translateMissing"`
		KeepOriginalPages *[]int `json:"keepOriginalPages"`
	}
	if !decode(w, r, &input) {
		return
	}
	if input.TranslateMissing == nil || input.KeepOriginalPages == nil {
		fail(w, 400, "请明确指定是否翻译缺失段落及保留原文页列表")
		return
	}
	start := bilingualStartRequest{TranslateMissing: *input.TranslateMissing, KeepOriginalPages: *input.KeepOriginalPages}
	j := s.bilingualJob(r)
	if j == nil {
		fail(w, 404, "导出任务不存在或已过期")
		return
	}
	state, status, e := s.confirmBilingualPDF(j, start)
	if e != nil {
		fail(w, status, e.Error())
		return
	}
	respond(w, 202, state)
}
func (s *Server) confirmBilingualPDF(j *bilingualJob, start bilingualStartRequest) (bilingualStatus, int, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	bad := func(status int, message string) (bilingualStatus, int, error) {
		return bilingualStatus{}, status, errors.New(message)
	}
	if e := s.validateBilingualSource(j); e != nil {
		j.cancel()
		return bad(409, e.Error())
	}
	if j.state.Status != "awaiting-confirmation" {
		return bad(409, "任务不在等待确认阶段")
	}
	seen := map[int]bool{}
	for _, p := range start.KeepOriginalPages {
		if seen[p] || !slices.ContainsFunc(j.prepared.Pages, func(v struct {
			Page       int               `json:"page"`
			Paragraphs []nativeParagraph `json:"paragraphs"`
		}) bool {
			return v.Page == p
		}) {
			return bad(400, "保留原文页码无效或重复")
		}
		seen[p] = true
	}
	for _, p := range j.prepared.NoTextPages {
		if !seen[p] {
			return bad(400, "无文字页须明确选择保留原文")
		}
	}
	missing := 0
	for _, page := range j.prepared.Pages {
		if seen[page.Page] {
			continue
		}
		for _, p := range page.Paragraphs {
			if j.targets[p.ID] == "" {
				missing++
			}
		}
	}
	if missing > 0 && !start.TranslateMissing {
		return bad(400, "所选页缺少译文，请明确启用 API 翻译或保留原文")
	}
	if missing > 0 && j.apiError != nil {
		return bad(400, "缺少可用 API 配置，请在设置中填写 API 地址与翻译模型后重新创建任务")
	}
	j.state.Status, j.state.Stage = "translating", "translating"
	j.state.Done, j.state.Total = 0, missing
	j.start <- start
	return j.state, 202, nil
}
func (s *Server) cancelBilingualPDF(w http.ResponseWriter, r *http.Request) {
	j := s.bilingualJob(r)
	if j != nil {
		j.cancel()
		<-j.done
	}
	w.WriteHeader(204)
}
func (s *Server) bilingualPDFFile(w http.ResponseWriter, r *http.Request) {
	j := s.bilingualJob(r)
	if j == nil {
		fail(w, 404, "导出任务不存在或已过期")
		return
	}
	j.mu.Lock()
	if e := s.validateBilingualSource(j); e != nil {
		j.mu.Unlock()
		j.cancel()
		fail(w, 409, e.Error())
		return
	}
	if j.state.Status != "ready" {
		j.mu.Unlock()
		fail(w, 409, "PDF 尚未成功生成")
		return
	}
	// A slow download must not hold the owner mutex or block delete/close joins.
	data, e := limitedBilingualRead(filepath.Join(j.work, "output.pdf"), bilingualFileLimit)
	j.mu.Unlock()
	if e != nil {
		fail(w, 500, "导出文件不可读")
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", `attachment; filename="bilingual.pdf"`)
	http.ServeContent(w, r, "bilingual.pdf", time.Time{}, bytes.NewReader(data))
}
func (s *Server) runBilingualPDF(j *bilingualJob) {
	err := s.prepareBilingualPDF(j)
	if err == nil {
		select {
		case <-j.ctx.Done():
			return
		case start := <-j.start:
			err = s.renderBilingualPDF(j, start)
		}
	}
	if err != nil {
		j.mu.Lock()
		j.state.Status = "failed"
		j.state.Error = bilingualPublicError(err)
		j.mu.Unlock()
	}
	<-j.ctx.Done()
}
func bilingualPublicError(err error) string {
	// Provider and operating-system errors can echo keys, paths or model text.
	var e *bilingualError
	if errors.As(err, &e) {
		return e.message
	}
	return "双语 PDF 导出失败，请检查 API 配置、原文和版面后重试"
}

type bilingualError struct{ message string }

func (e *bilingualError) Error() string     { return e.message }
func bilingualFailure(message string) error { return &bilingualError{message} }
func (s *Server) prepareBilingualPDF(j *bilingualJob) error {
	args := []string{"--stage", "prepare", "--input", filepath.Join(j.work, "original.pdf"), "--layout", filepath.Join(j.work, "layout.json"), "--prepared", filepath.Join(j.work, "prepared.json")}
	if j.options.From != nil {
		args = append(args, "--from", strconv.Itoa(*j.options.From))
	}
	if j.options.To != nil {
		args = append(args, "--to", strconv.Itoa(*j.options.To))
	}
	if e := s.bilingualProcessor(j, args); e != nil {
		return e
	}
	raw, e := limitedBilingualRead(filepath.Join(j.work, "prepared.json"), 32<<20)
	if e != nil {
		return e
	}
	if e = json.Unmarshal(raw, &j.prepared); e != nil || j.prepared.Version != 1 || j.prepared.OriginalSHA256 != j.originalHash || j.prepared.Revision != j.layoutHash {
		return bilingualFailure("准备数据与冻结原文不匹配")
	}
	from, to := 1, j.prepared.TotalPages
	if j.options.From != nil {
		from = *j.options.From
	}
	if j.options.To != nil {
		to = *j.options.To
	}
	if len(j.prepared.Pages) != to-from+1 {
		return bilingualFailure("准备数据缺少所选页")
	}
	reading := map[string]TranslationBlock{}
	for _, t := range j.reading {
		reading[t.BlockID+":"+t.SourceHash] = t
	}
	missing, targetBytes := 0, 0
	ids := map[string]bool{}
	for i, page := range j.prepared.Pages {
		if page.Page != from+i {
			return bilingualFailure("准备页码无效")
		}
		for _, p := range page.Paragraphs {
			if p.ID == "" || ids[p.ID] || p.Page != page.Page || strings.TrimSpace(p.Source) == "" {
				return bilingualFailure("准备段落数据无效")
			}
			ids[p.ID] = true
			if target := reuseBilingualTranslation(p, []TranslationBlock{reading[p.BlockID+":"+translationHash(p.OriginalSource)]}); target != "" {
				targetBytes += len(p.ID) + len(target)
				if targetBytes > bilingualTargetLimit {
					return bilingualFailure("导出译文总量超过上限，请缩小页码范围")
				}
				j.targets[p.ID] = target
			} else {
				missing++
			}
		}
	}
	j.conn, j.completion, j.apiError = s.resolveBilingualAPI(j.ctx, j.config)
	if e = s.validateBilingualSource(j); e != nil {
		return e
	}
	outputPages := len(j.prepared.Pages)
	if j.options.Layout == "alternating" {
		outputPages *= 2
	}
	j.mu.Lock()
	j.state.Preflight = &bilingualPreflight{Pages: len(j.prepared.Pages), OutputPages: outputPages, MissingParagraphs: missing, NoTextPages: append([]int{}, j.prepared.NoTextPages...), APIConfigured: j.apiError == nil, Warnings: append([]string{}, j.prepared.Warnings...)}
	j.state.Status, j.state.Stage = "awaiting-confirmation", "prepare"
	j.mu.Unlock()
	return nil
}
func (s *Server) renderBilingualPDF(j *bilingualJob, start bilingualStartRequest) error {
	missing := []nativeParagraph{}
	for _, page := range j.prepared.Pages {
		if slices.Contains(start.KeepOriginalPages, page.Page) {
			continue
		}
		for _, p := range page.Paragraphs {
			if j.targets[p.ID] == "" {
				missing = append(missing, p)
			}
		}
	}
	if len(missing) > 0 {
		if e := translateBilingualParagraphs(j.ctx, j.conn, j.completion, missing, j.targets, func(done int) { j.mu.Lock(); j.state.Done, j.state.Total = done, len(missing); j.mu.Unlock() }); e != nil {
			return e
		}
	}
	raw, e := json.Marshal(j.targets)
	if e != nil {
		return e
	}
	if e = os.WriteFile(filepath.Join(j.work, "targets.json"), raw, 0600); e != nil {
		return e
	}
	// Hash the full immutable export snapshot, including complete reused/final targets.
	snapshot, _ := json.Marshal(struct {
		Original, Layout, Exporter string
		Options                    bilingualOptions
		Start                      bilingualStartRequest
		Targets                    map[string]string
	}{j.originalHash, j.layoutHash, bilingualPDFVersion, j.options, start, j.targets})
	if e = os.WriteFile(filepath.Join(j.work, "snapshot.sha256"), []byte(sourceKey(string(snapshot))), 0600); e != nil {
		return e
	}
	j.mu.Lock()
	j.state.Stage = "layout"
	j.state.Status = "running"
	j.state.Done, j.state.Total = 0, len(j.prepared.Pages)
	j.mu.Unlock()
	args := []string{"--stage", "render", "--input", filepath.Join(j.work, "original.pdf"), "--prepared", filepath.Join(j.work, "prepared.json"), "--targets", filepath.Join(j.work, "targets.json"), "--output", filepath.Join(j.work, "output.pdf"), "--mode", j.options.Layout}
	if len(start.KeepOriginalPages) > 0 {
		pages := []string{}
		for _, p := range start.KeepOriginalPages {
			pages = append(pages, strconv.Itoa(p))
		}
		args = append(args, "--keep-original", strings.Join(pages, ","))
	}
	if e = s.bilingualProcessor(j, args); e != nil {
		return e
	}
	f, e := os.Open(filepath.Join(j.work, "output.pdf"))
	if e != nil {
		return e
	}
	header := make([]byte, 5)
	_, e = io.ReadFull(f, header)
	info, statErr := f.Stat()
	f.Close()
	if e != nil || statErr != nil || string(header) != "%PDF-" || info.Size() > bilingualFileLimit {
		return bilingualFailure("导出程序未生成有效 PDF")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if e = s.validateBilingualSource(j); e != nil {
		return e
	}
	j.state.Status, j.state.Stage = "ready", "ready"
	j.state.Done, j.state.Total = len(j.prepared.Pages), len(j.prepared.Pages)
	return nil
}

type boundedBilingualOutput struct{ b []byte }

func (b *boundedBilingualOutput) Write(p []byte) (int, error) {
	n := len(p)
	if len(b.b) < 8192 {
		b.b = append(b.b, p[:min(n, 8192-len(b.b))]...)
	}
	return n, nil
}

type bilingualProgress struct {
	job     *bilingualJob
	pending []byte
	cancel  context.CancelFunc
}

func (p *bilingualProgress) Write(data []byte) (int, error) {
	n := len(data)
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		part := data
		if end >= 0 {
			part = data[:end]
		}
		if len(p.pending)+len(part) > 16<<10 {
			p.cancel()
			return 0, errors.New("PDF 导出进度超出上限")
		}
		p.pending = append(p.pending, part...)
		if end < 0 {
			break
		}
		data = data[end+1:]
		var event struct {
			Stage string `json:"stage"`
			Done  int    `json:"done"`
			Total int    `json:"total"`
		}
		if json.Unmarshal(p.pending, &event) == nil && (event.Stage == "prepare" || event.Stage == "layout" || event.Stage == "composing") && event.Done >= 0 && event.Total >= event.Done && event.Total <= 1_000_000 {
			p.job.mu.Lock()
			p.job.state.Stage, p.job.state.Done, p.job.state.Total = event.Stage, event.Done, event.Total
			p.job.mu.Unlock()
		}
		p.pending = p.pending[:0]
	}
	return n, nil
}
func (s *Server) bilingualProcessor(j *bilingualJob, args []string) error {
	node, processor := os.Getenv("INTERLEAF_NODE"), os.Getenv("INTERLEAF_PROCESSOR")
	if node == "" || processor == "" {
		return bilingualFailure("PDF 导出程序不可用，请重新构建 Interleaf")
	}
	child, cancel := context.WithCancel(j.ctx)
	defer cancel()
	cmd := exec.CommandContext(child, node, append([]string{filepath.Join(filepath.Dir(processor), "bilingual-pdf-cli.mjs")}, args...)...)
	cmd.Dir = j.work
	cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
	cmd.WaitDelay = 3 * time.Second
	stderr := &boundedBilingualOutput{}
	cmd.Stderr = stderr
	cmd.Stdout = &bilingualProgress{job: j, cancel: cancel}
	// Run owns the pipe readers so WaitDelay also bounds inherited stdout/stderr.
	e := cmd.Run()
	if j.ctx.Err() != nil {
		return j.ctx.Err()
	}
	if e != nil {
		// Never publish arbitrary child stderr: it may contain paths or secrets.
		// Only rebuild the fixed overflow diagnostic for a known prepared paragraph.
		if len(args) >= 2 && args[0] == "--stage" && args[1] == "render" && len(stderr.b) < 8192 {
			for _, page := range j.prepared.Pages {
				if page.Page < 1 || page.Page > j.prepared.TotalPages {
					continue
				}
				for _, p := range page.Paragraphs {
					if p.Page != page.Page || len(p.ID) == 0 || len(p.ID) > 240 || strings.ContainsFunc(p.ID, func(c rune) bool {
						return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-')
					}) {
						continue
					}
					message := fmt.Sprintf("第 %d 页段落 %s 排版溢出（最小字号 9 pt）", page.Page, p.ID)
					if strings.TrimSpace(string(stderr.b)) == message {
						return bilingualFailure(message)
					}
				}
			}
		}
		return bilingualFailure("PDF 排版失败：请检查文字方向、字体、段落区域或版面；可缩小页码范围重试")
	}
	return nil
}
