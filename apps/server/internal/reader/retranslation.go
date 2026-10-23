package reader

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"slices"
)

// Task choices and layout progress are persisted. Connections, capabilities
// and secrets come from the configured provider when the job runs or resumes.
type translationRunOptions struct {
	// One full layout parse per explicit restart; retries resume the same run.
	LayoutRun   string `json:"layoutRun,omitempty"`
	LayoutReady bool   `json:"layoutReady,omitempty"`
	Provider    string `json:"provider"`
	Model       string `json:"model"`
	Effort      string `json:"effort"`
	Prompt      string `json:"prompt"`
}

func snapshotTranslationOptions(c NativeAIConfig) translationRunOptions {
	o := translationRunOptions{Provider: "api", Model: c.Models[taskTranslation], Effort: c.Efforts[taskTranslation]}
	if c.TranslationPrompt != nil {
		o.Prompt = *c.TranslationPrompt
	}
	return o
}
func (o *translationRunOptions) apply(c NativeAIConfig) NativeAIConfig {
	if o == nil {
		return c
	}
	c.Models = maps.Clone(c.Models)
	c.Efforts = maps.Clone(c.Efforts)
	if c.Models == nil {
		c.Models = map[modelTask]string{}
	}
	if c.Efforts == nil {
		c.Efforts = map[modelTask]string{}
	}
	// Old CLI choices cannot silently become a paid API model after migration.
	if o.Provider != "" && o.Provider != "api" {
		c.NeedsConfiguration = "请重新选择 API 翻译模型"
		return c
	}
	c.Models[taskTranslation] = o.Model
	c.Efforts[taskTranslation] = o.Effort
	c.TranslationPrompt = &o.Prompt
	return c
}

func (s *Server) retranslationOptions(p *Processing) (*translationRunOptions, error) {
	if !p.Retranslating {
		return nil, nil
	}
	var body string
	if err := s.Store.DB.QueryRow("SELECT options FROM translation_restarts WHERE document_id=?", p.DocumentID).Scan(&body); err != nil {
		return nil, err
	}
	var options translationRunOptions
	if err := json.Unmarshal([]byte(body), &options); err != nil {
		return nil, err
	}
	return &options, nil
}

func (s *Server) translationPrevious(documentID string) (map[string]bool, error) {
	rows, err := s.Store.DB.Query("SELECT block_id,source_hash FROM translation_previous WHERE document_id=?", documentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	previous := map[string]bool{}
	for rows.Next() {
		var block, hash string
		if err := rows.Scan(&block, &hash); err != nil {
			return nil, err
		}
		previous[block+":"+hash] = true
	}
	return previous, rows.Err()
}

func (s *Server) requestRetranslation(w http.ResponseWriter, r *http.Request) {
	ctx, finish, err := s.beginDocumentTask(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不可用")
		return
	}
	defer finish()
	r = r.WithContext(ctx)
	lock := s.annotationRecoveryLock(r.PathValue("id"))
	if !lock.TryLock() {
		fail(w, 409, "正在检查批注，请稍后重新翻译")
		return
	}
	defer lock.Unlock()
	config, configErr := s.nativeAIConfig()
	if configErr != nil || s.currentGenerationServiceContext(r.Context(), taskTranslation).ValidateInput(AIInput{}, false) != nil {
		fail(w, 409, "请先配置并检测翻译模型")
		return
	}
	s.processingControlMu.Lock()
	defer s.processingControlMu.Unlock()
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || d.DeletedAt != "" {
		fail(w, 404, "文档不存在")
		return
	}
	if d.Type != "pdf" || d.Library == "books" {
		fail(w, 400, "全文重译仅适用于论文；图书请按章节翻译")
		return
	}
	m, err := s.readTranslationSource(d.ID)
	if err != nil {
		fail(w, 409, "正文仍在解析中")
		return
	}
	s.processingMu.Lock()
	p, err := s.Store.processing(d.ID)
	if err != nil || p.Status != "complete" {
		s.processingMu.Unlock()
		fail(w, 409, "请等待当前翻译完成后再重新翻译")
		return
	}
	if s.blockedProcessing == nil {
		s.blockedProcessing = map[string]bool{}
	}
	s.blockedProcessing[d.ID] = true
	task := s.activeProcessing[d.ID]
	if task != nil {
		task.cancel()
	}
	s.processingMu.Unlock()
	if task != nil {
		<-task.done
	}
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	defer delete(s.blockedProcessing, d.ID)
	// Joining prevents a previous worker's delayed results from replacing this run.
	if ctx.Err() != nil {
		fail(w, 409, "重新翻译已取消")
		return
	}
	p, err = s.Store.processing(d.ID)
	if err == nil {
		err = s.queueRetranslation(p, m, snapshotTranslationOptions(config))
	}
	if err != nil {
		fail(w, 409, "无法开始重新翻译："+err.Error())
		return
	}
	p, err = s.Store.processing(d.ID)
	if err != nil {
		fail(w, 500, "无法读取翻译任务")
		return
	}
	respond(w, 200, p)
}

func (s *Server) queueRetranslation(p Processing, m translationInput, options translationRunOptions) error {
	options.LayoutRun, options.LayoutReady = id(), false
	items, err := s.translations(p.DocumentID, m)
	if err != nil {
		return err
	}
	previousItems := slices.Clone(items)
	text := map[string]bool{}
	for _, paragraph := range m.translationParagraphs() {
		text[paragraph.BlockID+":"+paragraph.SourceHash] = true
	}
	count := 0
	for i := range items {
		if text[items[i].BlockID+":"+items[i].SourceHash] && items[i].Status == "complete" {
			items[i].Status = "pending"
			items[i].Sentences = []TranslationSentence{}
			items[i].Error = ""
			count++
		}
	}
	if count == 0 {
		return errors.New("没有已完成的正文译文")
	}
	s.translationMu.Lock()
	defer s.translationMu.Unlock()
	s.Store.processingWriteMu.Lock()
	defer s.Store.processingWriteMu.Unlock()
	tx, err := s.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = captureAnnotationAnchors(tx, p.DocumentID, previousItems); err != nil {
		return err
	}
	for _, item := range items {
		if !text[item.BlockID+":"+item.SourceHash] || item.Status != "pending" {
			continue
		}
		if _, err = tx.Exec(`INSERT INTO translation_previous(document_id,block_id,source_hash,body)
SELECT document_id,block_id,source_hash,body FROM translations WHERE document_id=? AND block_id=? AND source_hash=? AND status='complete'
ON CONFLICT(document_id,block_id,source_hash) DO UPDATE SET body=excluded.body`, p.DocumentID, item.BlockID, item.SourceHash); err != nil {
			return err
		}
		body, err := json.Marshal(item)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE translations SET status='pending',body=? WHERE document_id=? AND block_id=? AND source_hash=?", string(body), p.DocumentID, item.BlockID, item.SourceHash); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("INSERT INTO translation_restarts(document_id,options) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET options=excluded.options", p.DocumentID, jsonText(options)); err != nil {
		return err
	}
	p.Enabled, p.Retranslating = true, true
	p.AutoTranslateMaxPages, p.ManualTranslation = nil, false
	p.Phase, p.Status, p.Detail = "translating", "queued", "等待重新解析版面"
	p.CompletedAt, p.Warning = "", ""
	p.TranslationsDone, p.TranslationsTotal = translationCounts(items)
	p.Translating = &ProcessingStage{Status: "queued", Detail: "等待重新解析版面"}
	p.UpdatedAt = now()
	if _, err = tx.Exec("UPDATE document_processing SET phase=?,status=?,body=? WHERE document_id=?", p.Phase, p.Status, jsonText(p), p.DocumentID); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO annotation_recovery(document_id,checked) VALUES(?,0) ON CONFLICT(document_id) DO UPDATE SET checked=0", p.DocumentID); err != nil {
		return err
	}
	return tx.Commit()
}
