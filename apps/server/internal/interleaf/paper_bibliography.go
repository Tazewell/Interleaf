package interleaf

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"interleaf.local/server/internal/bibliography"
)

type PaperBibliographyDecision struct {
	Index       int    `json:"index"`
	Action      string `json:"action"`
	PaperID     string `json:"paperId,omitempty"`
	CitationKey string `json:"citationKey,omitempty"`
}
type PaperBibliographyImport struct {
	Text                  string                      `json:"text"`
	Decisions             []PaperBibliographyDecision `json:"decisions"`
	ConfirmCitationChange bool                        `json:"confirmCitationChange"`
}
type PaperBibliographyPreviewEntry struct {
	Index     int      `json:"index"`
	Key       string   `json:"key"`
	Title     string   `json:"title"`
	MatchedID string   `json:"matchedId,omitempty"`
	Warnings  []string `json:"warnings"`
}
type PaperBibliographyPreview struct {
	Entries []PaperBibliographyPreviewEntry `json:"entries"`
	Errors  []string                        `json:"errors,omitempty"`
}

func (s *Server) registerPaperBibliographyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/papers/bibliography/preview", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Text string `json:"text"`
		}
		if !decode(w, r, &v) {
			return
		}
		p, err := s.Store.PreviewBibliography(v.Text)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, p)
	})
	mux.HandleFunc("POST /api/papers/bibliography/import", func(w http.ResponseWriter, r *http.Request) {
		var v PaperBibliographyImport
		if !decode(w, r, &v) {
			return
		}
		p, err := s.Store.ImportBibliography(v)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, p)
	})
	mux.HandleFunc("POST /api/papers/bibliography/export", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			IDs  []string `json:"ids"`
			Mode string   `json:"mode"`
		}
		if !decode(w, r, &v) {
			return
		}
		text, err := s.Store.Bibliography(v.IDs, v.Mode)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, map[string]string{"text": text})
	})
}

func bibUnknown(e bibliography.Entry) []string {
	known := map[string]bool{"title": true, "author": true, "year": true, "month": true, "day": true, "crossref": true, "type": true, "eprinttype": true}
	for _, f := range bibMetadataFields {
		known[f.Bib] = true
	}
	out := []string{}
	for _, f := range e.Fields {
		if !known[f.Name] {
			out = append(out, f.Name)
		}
	}
	return out
}
func (s *Store) PreviewBibliography(text string) (PaperBibliographyPreview, error) {
	out := PaperBibliographyPreview{Entries: []PaperBibliographyPreviewEntry{}}
	db, err := bibliography.Parse(text)
	if err != nil {
		out.Errors = []string{err.Error()}
		return out, nil
	}
	papers, err := s.PaperItems()
	if err != nil {
		return out, err
	}
	keys := map[string]bool{}
	for _, e := range db.Entries {
		keys[strings.ToLower(e.Key)] = true
	}
	seen := map[string]bool{}
	for index, e := range db.Entries {
		mapped, err := bibMapped(db, e)
		p := PaperBibliographyPreviewEntry{Index: index, Key: e.Key, Title: mapped.Title, Warnings: []string{}}
		if err != nil {
			p.Warnings = append(p.Warnings, err.Error())
		}
		if !citationKeyPattern.MatchString(e.Key) {
			p.Warnings = append(p.Warnings, "引用键不符合兼容规则，请显式改键或跳过")
		}
		if seen[strings.ToLower(e.Key)] {
			p.Warnings = append(p.Warnings, "文件中引用键重复，请显式处理")
		}
		seen[strings.ToLower(e.Key)] = true
		matches := []string{}
		for _, old := range papers {
			if (mapped.Metadata.DOI != "" && strings.EqualFold(mapped.Metadata.DOI, old.Metadata.DOI)) || (mapped.Metadata.ArXiv != "" && strings.EqualFold(mapped.Metadata.ArXiv, old.Metadata.ArXiv)) {
				matches = append(matches, old.ID)
			}
			if strings.EqualFold(old.CitationKey, e.Key) {
				p.Warnings = append(p.Warnings, "引用键已属于文献 "+old.ID+"，请选择合并、改键或跳过")
			}
			if mapped.Metadata.DOI == "" && mapped.Metadata.ArXiv == "" && strings.EqualFold(strings.TrimSpace(old.Title), strings.TrimSpace(mapped.Title)) {
				p.Warnings = append(p.Warnings, "标题相同的候选文献："+old.ID)
			}
		}
		if len(matches) == 1 {
			p.MatchedID = matches[0]
		} else if len(matches) > 1 {
			p.Warnings = append(p.Warnings, "标识符匹配多个文献，请选择明确的合并目标："+strings.Join(matches, ", "))
		}
		if fields := bibUnknown(e); len(fields) > 0 {
			p.Warnings = append(p.Warnings, "保留未映射字段："+strings.Join(fields, ", "))
		}
		parent, e2 := db.Value(e, "crossref")
		if e2 != nil {
			p.Warnings = append(p.Warnings, e2.Error())
		} else if parent != "" && !keys[strings.ToLower(parent)] {
			found := false
			for _, old := range papers {
				found = found || strings.EqualFold(old.CitationKey, parent)
			}
			if !found {
				p.Warnings = append(p.Warnings, "缺少 crossref 依赖："+parent)
			}
		}
		out.Entries = append(out.Entries, p)
	}
	return out, nil
}

type bibImportPlan struct {
	paper  PaperItem
	record paperBibRecord
	create bool
	index  int
	parent string
}

// Validate the entire decision set, key ownership, targets and expressions
// before writing; all accepted entries and their raw sources commit together.
func (s *Store) ImportBibliography(v PaperBibliographyImport) ([]PaperItem, error) {
	db, err := bibliography.Parse(v.Text)
	if err != nil {
		return nil, err
	}
	for _, expression := range db.Preambles {
		if _, err = db.Value(bibliography.Entry{Fields: []bibliography.Field{{Name: "preamble", Value: expression}}}, "preamble"); err != nil {
			return nil, err
		}
	}
	if len(db.Entries) == 0 || len(db.Entries) > 10000 {
		return nil, errors.New("请选择 1–10000 条参考文献")
	}
	if len(v.Decisions) != len(db.Entries) {
		return nil, errors.New("每个导入条目都须明确选择创建、合并或跳过")
	}
	decisions := make([]PaperBibliographyDecision, len(db.Entries))
	seen := map[int]bool{}
	for _, d := range v.Decisions {
		if d.Index < 0 || d.Index >= len(db.Entries) || seen[d.Index] {
			return nil, errors.New("导入决定索引无效或重复")
		}
		if d.Action != "create" && d.Action != "merge" && d.Action != "skip" {
			return nil, errors.New("无效导入操作")
		}
		if d.Action == "merge" && d.PaperID == "" {
			return nil, errors.New("合并必须指定文献")
		}
		if d.Action != "merge" && d.PaperID != "" {
			return nil, errors.New("仅合并操作可以指定目标文献")
		}
		decisions[d.Index] = d
		seen[d.Index] = true
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	plans := []bibImportPlan{}
	targets := map[string]bool{}
	newKeys := map[string]bool{}
	originals := map[string][]string{}
	for index, e := range db.Entries {
		d := decisions[index]
		if d.Action == "skip" {
			continue
		}
		incoming, err := bibMapped(db, e)
		if err != nil {
			return nil, err
		}
		plan := bibImportPlan{index: index, create: d.Action == "create", record: paperBibRecord{Entry: e, Context: bibliography.Database{Strings: db.Strings, Preambles: db.Preambles}, Baseline: incoming}}
		if plan.create {
			plan.paper = PaperItem{ID: id(), CreatedAt: now(), Tags: []string{}, Folders: []string{}, Attachments: []PaperAttachment{}}
		} else {
			plan.paper, err = readPaper(tx, d.PaperID)
			if err != nil {
				return nil, err
			}
			if plan.paper.DeletedAt != "" {
				return nil, paperConflict("请先恢复合并目标")
			}
			if targets[plan.paper.ID] {
				return nil, paperConflict("一个导入批次不能多次写入同一文献，请分开确认")
			}
			old, hasRaw, err := readPaperBib(tx, plan.paper.ID)
			if err != nil {
				return nil, err
			}
			if hasRaw {
				context, err := bibCombineContexts(old.Context, plan.record.Context)
				if err != nil {
					return nil, err
				}
				// Retain fields absent from the newer file, including unknown fields.
				entry := plan.record.Entry
				for _, f := range old.Entry.Fields {
					if bibGet(entry, f.Name) == "" {
						entry.Fields = append(entry.Fields, f)
					}
				}
				plan.record.Entry, plan.record.Context = entry, context
				plan.record.Baseline, err = bibMapped(context, entry)
				if err != nil {
					return nil, err
				}
				incoming = plan.record.Baseline
				oldParent, _ := old.Context.Value(old.Entry, "crossref")
				newParent, _ := context.Value(entry, "crossref")
				if oldParent == newParent {
					plan.record.ParentID = old.ParentID
				}
			}
		}
		targets[plan.paper.ID] = true
		chosen := e.Key
		if !plan.create && plan.paper.CitationKey != "" {
			chosen = plan.paper.CitationKey
		}
		if d.CitationKey != "" {
			chosen = d.CitationKey
		}
		if !citationKeyPattern.MatchString(chosen) {
			return nil, errors.New("导入引用键不符合兼容规则，请显式改键或跳过")
		}
		if !plan.create && plan.paper.CitationKey != "" && chosen != plan.paper.CitationKey && !v.ConfirmCitationChange {
			return nil, paperConflict("改键会影响已有 LaTeX 引用，请明确确认")
		}
		if newKeys[strings.ToLower(chosen)] {
			return nil, paperConflict("导入决定仍有重复引用键")
		}
		newKeys[strings.ToLower(chosen)] = true
		var owner string
		err = tx.QueryRow(`SELECT paper_id FROM paper_citation_keys WHERE key=? COLLATE NOCASE`, chosen).Scan(&owner)
		if err == nil && owner != plan.paper.ID {
			return nil, paperConflict("引用键已使用，请明确合并、改键或跳过")
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		plan.paper.CitationKey = chosen
		bibFill(&plan.paper, incoming)
		if err = bibValidateEprint(plan.paper, plan.record); err != nil {
			return nil, err
		}
		plan.parent, err = plan.record.Context.Value(plan.record.Entry, "crossref")
		if err != nil {
			return nil, err
		}
		original := strings.ToLower(e.Key)
		originals[original] = append(originals[original], plan.paper.ID)
		plans = append(plans, plan)
	}
	// Resolve crossrefs to identities so future key changes cannot break them.
	for i := range plans {
		plan := &plans[i]
		if plan.parent == "" {
			continue
		}
		parents := originals[strings.ToLower(plan.parent)]
		if len(parents) > 1 {
			return nil, paperConflict("crossref 引用的原始键重复，请跳过重复项或先修改 crossref：" + plan.parent)
		}
		parentID := ""
		if len(parents) == 1 {
			parentID = parents[0]
		}
		if parentID == "" && plan.record.ParentID != "" {
			parent, err := readPaper(tx, plan.record.ParentID)
			if err != nil || parent.DeletedAt != "" {
				return nil, paperConflict("缺少 crossref 依赖：" + plan.parent)
			}
			parentID = parent.ID
		}
		if parentID == "" {
			err = tx.QueryRow(`SELECT id FROM paper_items WHERE citation_key=? COLLATE NOCASE AND deleted_at=''`, plan.parent).Scan(&parentID)
			if errors.Is(err, sql.ErrNoRows) {
				return nil, paperConflict("缺少 crossref 依赖：" + plan.parent)
			}
			if err != nil {
				return nil, err
			}
		}
		plan.record.ParentID = parentID
	}
	for _, plan := range plans {
		if err = reserveCitationKey(tx, plan.paper.ID, plan.paper.CitationKey); err != nil {
			return nil, err
		}
		if plan.create {
			if _, err = tx.Exec(`INSERT INTO paper_items(id,title,created_at) VALUES(?,?,?)`, plan.paper.ID, plan.paper.Title, plan.paper.CreatedAt); err != nil {
				return nil, err
			}
		}
		if err = savePaper(tx, plan.paper); err != nil {
			return nil, err
		}
		if err = savePaperBib(tx, plan.paper.ID, plan.record); err != nil {
			return nil, err
		}
	}
	ids := []string{}
	out := []PaperItem{}
	for _, plan := range plans {
		ids = append(ids, plan.paper.ID)
		out = append(out, plan.paper)
	}
	// Dependency cycles across this batch and existing imports roll back everything.
	if _, err = bibCollect(tx, ids); err != nil {
		return nil, err
	}
	if len(plans) > 0 {
		if _, err = tx.Exec(`INSERT INTO paper_bibliography_imports(id,text) VALUES(?,?)`, id(), v.Text); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// Separate imports retain their own context. Combining incompatible global
// BibTeX macro definitions requires user resolution instead of silent shadowing.
func bibCombineContexts(a, b bibliography.Database) (bibliography.Database, error) {
	out := bibliography.Database{Strings: append([]bibliography.Field{}, a.Strings...), Preambles: append([]string{}, a.Preambles...)}
	for _, f := range b.Strings {
		found := false
		for _, old := range out.Strings {
			if strings.EqualFold(f.Name, old.Name) {
				if f.Value != old.Value {
					return out, paperConflict(fmt.Sprintf("字符串宏 %s 在不同导入文件中定义不同，请重命名宏后重新导入，或分别导出", f.Name))
				}
				found = true
			}
		}
		if !found {
			out.Strings = append(out.Strings, f)
		}
	}
	for _, p := range b.Preambles {
		found := false
		for _, old := range out.Preambles {
			found = found || p == old
		}
		if !found {
			out.Preambles = append(out.Preambles, p)
		}
	}
	return out, nil
}
