package reader

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
)

const researchToolBytes = 64 << 10

type researchToolset struct {
	server       *Server
	scope        researchScope
	mu           sync.Mutex
	vision       bool
	passageBytes int
}

func (s *Server) researchTools(ctx context.Context, runID string) (nativeToolset, error) {
	scope, err := readResearchRunScope(ctx, s.Store.DB, runID)
	if err != nil {
		return nil, err
	}
	return &researchToolset{server: s, scope: scope}, nil
}
func (t *researchToolset) Definitions(vision bool) []any {
	t.mu.Lock()
	t.vision = vision
	t.mu.Unlock()
	property := func(typ string) any { return map[string]any{"type": typ} }
	defs := []any{}
	add := func(name, description string, props map[string]any, required ...string) {
		if required == nil {
			required = []string{}
		}
		defs = append(defs, map[string]any{"type": "function", "function": map[string]any{"name": name, "description": description, "parameters": map[string]any{"type": "object", "properties": props, "required": required, "additionalProperties": false}}})
	}
	add("list_papers", "List only papers in this immutable research snapshot. Follow nextCursor.", map[string]any{"cursor": property("string")})
	add("get_paper_outline", "Locate sections; an outline is not read evidence.", map[string]any{"paperId": property("string"), "cursor": property("string")}, "paperId")
	add("search_papers", "Search original text fairly across scoped papers. Results are navigation, not evidence. Follow nextCursor.", map[string]any{"paperId": property("string"), "query": property("string"), "limit": property("integer"), "cursor": property("string")}, "query")
	props := map[string]any{"paperId": property("string"), "blockId": property("string"), "sectionId": property("string"), "full": property("boolean"), "fromPage": property("integer"), "toPage": property("integer"), "before": property("integer"), "after": property("integer"), "cursor": property("string")}
	add("read_paper_passage", "Read original passages from exactly one paper; choose blockId, sectionId, PDF page range, or full. Follow nextCursor. Cite the opaque sourceId.", props, "paperId")
	if vision {
		add("read_paper_pages", "View original PDF pages; this does not count as reading extracted passages.", map[string]any{"paperId": property("string"), "pages": map[string]any{"type": "array", "items": property("integer"), "minItems": 1, "maxItems": 8}}, "paperId", "pages")
	}
	return defs
}
func (t *researchToolset) Check(ctx context.Context) error {
	current, err := readResearchRunScope(ctx, t.server.Store.DB, t.scope.Run.ID)
	if err != nil {
		return err
	}
	if current.Snapshot.ID != t.scope.Snapshot.ID || current.Snapshot.Revision != t.scope.Snapshot.Revision {
		return errResearchScopeChanged
	}
	if current.Run.Status != "running" {
		return generationError(ErrorCanceled, "研究任务已停止")
	}
	return ctx.Err()
}
func (t *researchToolset) ValidateAnswer(ctx context.Context, text string) error {
	// Cards validate JSON fact fields separately. Free-form research answers use
	// [opaque-id] references; bare per-document S1 citations are never trusted.
	refs := []string{}
	for _, part := range strings.Split(text, "[")[1:] {
		end := strings.IndexByte(part, ']')
		if end < 0 {
			continue
		}
		ref := part[:end]
		if len(ref) == 32 || strings.HasPrefix(ref, "S") {
			refs = append(refs, ref)
		}
	}
	return t.server.validateResearchSources(ctx, t.scope.Run.ID, refs)
}

type researchCursor struct {
	Scope, Selector string
	Offset          int
}

func (t *researchToolset) cursor(selector string, offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(jsonText(researchCursor{t.scope.Snapshot.Revision, sourceKey(selector), offset})))
}
func (t *researchToolset) offset(cursor, selector string) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil || len(raw) > 1024 {
		return 0, fmt.Errorf("invalid cursor")
	}
	var c researchCursor
	if json.Unmarshal(raw, &c) != nil || c.Scope != t.scope.Snapshot.Revision || c.Selector != sourceKey(selector) || c.Offset < 0 {
		return 0, fmt.Errorf("invalid cursor")
	}
	return c.Offset, nil
}
func researchInvalid() (nativeToolResult, error) {
	return nativeToolResult{Content: json.RawMessage(`{"error":"invalid_arguments"}`)}, nil
}
func researchResult(items []any, next string, coverage any) (nativeToolResult, error) {
	raw, err := json.Marshal(map[string]any{"items": items, "nextCursor": next, "readCoverage": coverage})
	if err == nil && len(raw) > researchToolBytes {
		err = generationError(ErrorLimit, "研究工具回包超过限制")
	}
	return nativeToolResult{Content: raw}, err
}
func researchItemFits(items []any, item any) bool {
	return len(jsonText(append(append([]any{}, items...), item))) < 48<<10
}
func researchPassages(st *researchReadState) []documentPassage {
	if st.Corpus != nil {
		return st.Corpus.Passages
	}
	if st.Member.Coverage != "abstract" {
		return nil
	}
	c := &documentCorpus{}
	addCorpusPassage(c, "abstract", "摘要", st.Paper.Metadata.Abstract, map[string]any{"type": "abstract"}, "abstract")
	for i := range c.Passages {
		c.Passages[i].ID = "abstract-" + strconv.Itoa(i+1)
	}
	return c.Passages
}
func modelResearchEvidence(ev ResearchEvidence) any {
	return map[string]any{"sourceId": ev.ID, "paperId": ev.PaperID, "documentId": ev.DocumentID, "text": ev.Excerpt, "location": ev.Location, "revision": ev.Revision, "contentHash": ev.ContentHash}
}
func (t *researchToolset) Call(ctx context.Context, name string, args json.RawMessage) (nativeToolResult, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := t.Check(ctx); err != nil {
		return nativeToolResult{}, err
	}
	switch name {
	case "list_papers":
		var q struct {
			Cursor string `json:"cursor"`
		}
		if strictToolArguments(args, &q) != nil {
			return researchInvalid()
		}
		start, err := t.offset(q.Cursor, name)
		if err != nil || start > len(t.scope.Snapshot.Members) {
			return researchInvalid()
		}
		items := []any{}
		next := ""
		for i := start; i < len(t.scope.Snapshot.Members); i++ {
			m := t.scope.Snapshot.Members[i]
			if !researchItemFits(items, m) {
				next = t.cursor(name, i)
				break
			}
			items = append(items, m)
		}
		return researchResult(items, next, nil)
	case "search_papers":
		return t.search(ctx, args)
	case "get_paper_outline":
		var q struct {
			PaperID string `json:"paperId"`
			Cursor  string `json:"cursor"`
		}
		if strictToolArguments(args, &q) != nil {
			return researchInvalid()
		}
		m, err := t.scope.member(q.PaperID)
		if err != nil {
			return researchInvalid()
		}
		st, err := t.server.prepareResearchRead(ctx, m)
		if err != nil {
			return nativeToolResult{}, err
		}
		defer st.Finish()
		selector := name + ":" + m.PaperID
		start, err := t.offset(q.Cursor, selector)
		passages := researchPassages(st)
		if err != nil || start > len(passages) {
			return researchInvalid()
		}
		items := []any{}
		seen := map[string]bool{}
		next := ""
		for i := start; i < len(passages); i++ {
			p := passages[i]
			if seen[p.Section] {
				continue
			}
			item := map[string]any{"sectionId": p.Section, "title": documentExcerpt(p.Label, 200), "firstBlockId": p.ID, "location": p.Location}
			if len(items) >= 40 || !researchItemFits(items, item) {
				next = t.cursor(selector, i)
				break
			}
			seen[p.Section] = true
			items = append(items, item)
		}
		err = t.server.commitResearchRead(st.Context, t.scope, []*researchReadState{st}, true, func(*sql.Tx) error { return nil })
		if err != nil {
			return nativeToolResult{}, err
		}
		return researchResult(items, next, nil)
	case "read_paper_passage":
		return t.readPassage(ctx, args)
	case "read_paper_pages":
		return t.readPages(ctx, args)
	default:
		return nativeToolResult{Content: json.RawMessage(`{"error":"unknown_tool"}`)}, nil
	}
}
func (t *researchToolset) readPassage(ctx context.Context, args json.RawMessage) (nativeToolResult, error) {
	var q struct {
		PaperID string `json:"paperId"`
		documentReadRequest
	}
	if strictToolArguments(args, &q) != nil {
		return researchInvalid()
	}
	m, err := t.scope.member(q.PaperID)
	if err != nil {
		return researchInvalid()
	}
	st, err := t.server.prepareResearchRead(ctx, m)
	if err != nil {
		return nativeToolResult{}, err
	}
	defer st.Finish()
	c := st.Corpus
	if c == nil {
		c = &documentCorpus{Passages: researchPassages(st)}
	}
	if q.FromPage > 0 && (st.Corpus == nil || st.Document.Type != "pdf") {
		return researchInvalid()
	}
	selection := q.documentReadRequest
	selection.Cursor = ""
	indices, ok := documentReadIndices(c, selection)
	if !ok {
		return researchInvalid()
	}
	if q.Cursor != "" {
		offset := -1
		for i, index := range indices {
			if c.Passages[index].ID == q.Cursor {
				offset = i
				break
			}
		}
		if offset < 0 {
			return researchInvalid()
		}
		indices = indices[offset:]
	}
	items := []any{}
	evidence := []ResearchEvidence{}
	next := ""
	for _, i := range indices {
		ev := researchPassageEvidence(t.scope, m, c.Passages[i])
		item := modelResearchEvidence(ev)
		limit := t.passageBytes
		if limit <= 0 {
			// Locations also occur in this reply's exact read ranges.
			limit = 24 << 10
		}
		if len(jsonText(append(append([]any{}, items...), item))) > limit {
			next = c.Passages[i].ID
			break
		}
		items = append(items, item)
		evidence = append(evidence, ev)
	}
	if len(items) == 0 {
		return nativeToolResult{}, generationError(ErrorLimit, "下一段原文超过工具回包限制")
	}
	prior, err := t.priorEvidence(st.Context, st)
	if err != nil {
		return nativeToolResult{}, err
	}
	coverage := researchCoverageFor(st, evidence)
	cumulative := researchCoverageFor(st, append(prior, evidence...))
	coverage.ReadUnits = cumulative.ReadUnits
	// Build and bound the complete reply before publishing any read evidence.
	result, err := researchResult(items, next, map[string]any{"totalUnits": coverage.TotalUnits, "readUnits": coverage.ReadUnits, "ranges": coverage.Ranges, "rangeScope": "reply", "readUnitsScope": "run"})
	if err != nil {
		return nativeToolResult{}, err
	}
	var reply map[string]any
	_ = json.Unmarshal(result.Content, &reply)
	if st.Corpus != nil {
		missing, warnings := []string{}, []string{}
		for _, value := range st.Corpus.Coverage.Missing[:min(20, len(st.Corpus.Coverage.Missing))] {
			missing = append(missing, documentExcerpt(value, 160))
		}
		for _, value := range st.Corpus.Coverage.Warnings[:min(20, len(st.Corpus.Coverage.Warnings))] {
			warnings = append(warnings, documentExcerpt(value, 160))
		}
		reply["sourceCoverage"] = map[string]any{"status": st.Corpus.Coverage.Status, "totalUnits": st.Corpus.Coverage.TotalUnits, "searchableUnits": st.Corpus.Coverage.SearchableUnits, "missingRanges": missing, "missingRangesTotal": len(st.Corpus.Coverage.Missing), "warnings": warnings}
	}
	result.Content = json.RawMessage(jsonText(reply))
	if len(result.Content) > researchToolBytes {
		return nativeToolResult{}, generationError(ErrorLimit, "研究工具回包超过限制")
	}
	err = t.server.commitResearchRead(st.Context, t.scope, []*researchReadState{st}, true, func(tx *sql.Tx) error {
		for _, ev := range evidence {
			if e := writeResearchEvidence(st.Context, tx, ev); e != nil {
				return e
			}
		}
		return nil
	})
	return result, err
}
func (t *researchToolset) priorEvidence(ctx context.Context, st *researchReadState) ([]ResearchEvidence, error) {
	rows, err := t.server.Store.DB.QueryContext(ctx, `SELECT body FROM research_evidence WHERE run_id=? AND snapshot_id=? AND paper_id=? AND availability='valid' ORDER BY rowid`, t.scope.Run.ID, t.scope.Snapshot.ID, st.Member.PaperID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	evidence := []ResearchEvidence{}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var ev ResearchEvidence
		if json.Unmarshal([]byte(raw), &ev) != nil || !researchEvidenceMatches(ev, t.scope, st) {
			return nil, errResearchScopeChanged
		}
		evidence = append(evidence, ev)
	}
	return evidence, rows.Err()
}
func (t *researchToolset) search(ctx context.Context, args json.RawMessage) (nativeToolResult, error) {
	var q struct {
		PaperID string `json:"paperId"`
		Query   string `json:"query"`
		Limit   int    `json:"limit"`
		Cursor  string `json:"cursor"`
	}
	if strictToolArguments(args, &q) != nil || len(q.Query) > 512 || strings.TrimSpace(q.Query) == "" || q.Limit < 0 || q.Limit > 20 {
		return researchInvalid()
	}
	if q.Limit == 0 {
		q.Limit = 10
	}
	members := t.scope.Snapshot.Members
	if q.PaperID != "" {
		m, e := t.scope.member(q.PaperID)
		if e != nil {
			return researchInvalid()
		}
		members = []ResearchMember{m}
	}
	selector := "search:" + q.PaperID + ":" + q.Query
	start, err := t.offset(q.Cursor, selector)
	if err != nil {
		return researchInvalid()
	}
	terms := strings.Fields(strings.TrimSpace(q.Query))
	if len(terms) > 8 {
		terms = terms[:8]
	}
	for i, v := range terms {
		terms[i] = `"` + strings.ReplaceAll(v, `"`, `""`) + `"`
	}
	matches := [][]any{}
	for _, m := range members {
		if m.Coverage != "fulltext" && m.Coverage != "abstract" {
			continue
		}
		st, e := t.server.prepareResearchRead(ctx, m)
		if e != nil {
			return nativeToolResult{}, e
		}
		found, e := func() ([]any, error) {
			defer st.Finish()
			passages := researchPassages(st)
			ranked := []documentPassage{}
			seen := map[string]bool{}
			for _, p := range passages {
				if strings.Contains(strings.ToLower(p.Text), strings.ToLower(q.Query)) {
					ranked = append(ranked, p)
					seen[p.ID] = true
				}
			}
			if st.Corpus != nil {
				rows, e := t.server.Store.DB.QueryContext(st.Context, `SELECT block_id FROM document_passages_fts WHERE document_id=? AND revision=? AND document_passages_fts MATCH ? ORDER BY bm25(document_passages_fts),rowid`, m.DocumentID, m.CorpusRevision, strings.Join(terms, " OR "))
				if e != nil {
					return nil, e
				}
				ids := []string{}
				for rows.Next() {
					var v string
					if e = rows.Scan(&v); e != nil {
						rows.Close()
						return nil, e
					}
					ids = append(ids, v)
				}
				e = rows.Err()
				rows.Close()
				if e != nil {
					return nil, e
				}
				byID := map[string]documentPassage{}
				for _, p := range passages {
					byID[p.ID] = p
				}
				for _, v := range ids {
					if p, ok := byID[v]; ok && !seen[v] {
						ranked = append(ranked, p)
						seen[v] = true
					}
				}
			}
			out := []any{}
			for _, p := range ranked {
				out = append(out, map[string]any{"paperId": m.PaperID, "blockId": p.ID, "excerpt": documentExcerpt(p.Text, 650), "location": p.Location})
			}
			e := t.server.commitResearchRead(st.Context, t.scope, []*researchReadState{st}, true, func(*sql.Tx) error { return nil })
			return out, e
		}()
		if e != nil {
			return nativeToolResult{}, e
		}
		matches = append(matches, found)
	}
	// Round-robin by paper: a large first paper cannot crowd out the scope.
	items := []any{}
	ordinal := 0
	next := ""
	for rank := 0; ; rank++ {
		anyMatch := false
		for _, paper := range matches {
			if rank >= len(paper) {
				continue
			}
			anyMatch = true
			if ordinal >= start {
				if len(items) >= q.Limit || !researchItemFits(items, paper[rank]) {
					next = t.cursor(selector, ordinal)
					return researchResult(items, next, nil)
				}
				items = append(items, paper[rank])
			}
			ordinal++
		}
		if !anyMatch {
			break
		}
	}
	if start > ordinal {
		return researchInvalid()
	}
	return researchResult(items, next, nil)
}
func (t *researchToolset) readPages(ctx context.Context, args json.RawMessage) (nativeToolResult, error) {
	var q struct {
		PaperID string `json:"paperId"`
		Pages   []int  `json:"pages"`
	}
	if strictToolArguments(args, &q) != nil || len(q.Pages) < 1 || len(q.Pages) > 8 || !t.vision {
		return researchInvalid()
	}
	m, err := t.scope.member(q.PaperID)
	if err != nil {
		return researchInvalid()
	}
	st, err := t.server.prepareResearchRead(ctx, m)
	if err != nil {
		return nativeToolResult{}, err
	}
	defer st.Finish()
	if st.Corpus == nil || st.Document.Type != "pdf" {
		return researchInvalid()
	}
	pages := []int{}
	seen := map[int]bool{}
	for _, p := range q.Pages {
		if p < 1 || p > st.Corpus.Coverage.TotalUnits {
			return researchInvalid()
		}
		if !seen[p] {
			pages = append(pages, p)
			seen[p] = true
		}
	}
	images, err := t.server.renderDocumentPages(st.Context, st.Corpus, pages)
	if err != nil {
		return nativeToolResult{}, err
	}
	items := []any{}
	evidence := []ResearchEvidence{}
	native := []nativeToolImage{}
	for _, img := range images {
		data, actual, e := t.server.cachedPageImage(m.DocumentID, m.CorpusRevision, img.Page)
		if e != nil || actual.Hash != img.Hash {
			return nativeToolResult{}, errResearchScopeChanged
		}
		ev := ResearchEvidence{ID: id(), TopicID: t.scope.Run.TopicID, SnapshotID: t.scope.Snapshot.ID, RunID: t.scope.Run.ID, PaperID: m.PaperID, DocumentID: m.DocumentID, Kind: "local-page", Revision: m.CorpusRevision, ContentHash: img.Hash, Location: json.RawMessage(fmt.Sprintf(`{"type":"pdf","page":%d}`, img.Page)), Excerpt: fmt.Sprintf("PDF 第 %d 页图像", img.Page), ReadAt: now(), Availability: "valid"}
		evidence = append(evidence, ev)
		items = append(items, modelResearchEvidence(ev))
		native = append(native, nativeToolImage{SourceID: ev.ID, MIME: "image/png", Label: ev.Excerpt, Data: data, Hash: img.Hash, Bytes: len(data)})
	}
	result, err := researchResult(items, "", map[string]any{"viewedPages": pages, "readPassages": 0})
	if err != nil {
		return nativeToolResult{}, err
	}
	err = t.server.commitResearchRead(st.Context, t.scope, []*researchReadState{st}, true, func(tx *sql.Tx) error {
		for _, ev := range evidence {
			if e := writeResearchEvidence(st.Context, tx, ev); e != nil {
				return e
			}
		}
		return nil
	})
	result.Images = native
	return result, err
}
func (t *researchToolset) ImageData(ctx context.Context, image nativeToolImage) ([]byte, error) {
	ev, err := t.server.resolveResearchSource(ctx, image.SourceID)
	if err != nil {
		return nil, err
	}
	if ev.RunID != t.scope.Run.ID || ev.Kind != "local-page" || ev.ContentHash != image.Hash {
		return nil, errResearchScopeChanged
	}
	var loc struct {
		Page int `json:"page"`
	}
	_ = json.Unmarshal(ev.Location, &loc)
	task, finish, err := t.server.beginDocumentTask(ctx, ev.DocumentID)
	if err != nil {
		return nil, err
	}
	defer finish()
	data, actual, err := t.server.cachedPageImage(ev.DocumentID, ev.Revision, loc.Page)
	if err != nil || actual.Hash != ev.ContentHash {
		return nil, errResearchScopeChanged
	}
	if err = task.Err(); err != nil {
		return nil, err
	}
	return data, nil
}
