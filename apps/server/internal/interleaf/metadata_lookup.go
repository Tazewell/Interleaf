package interleaf

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"

	"interleaf.local/server/internal/scholar"
)

func (s *Server) scholarClient() *scholar.Client {
	s.scholarMu.Lock()
	defer s.scholarMu.Unlock()
	if s.scholar == nil {
		s.scholar = scholar.New(maxImportBytes)
	}
	return s.scholar
}

func fromScholar(m scholar.Metadata) PaperMetadata {
	out := PaperMetadata{ItemType: m.ItemType, Date: m.Date, Venue: m.Venue, Volume: m.Volume, Issue: m.Issue, Pages: m.Pages, Publisher: m.Publisher, DOI: m.DOI, ArXiv: m.ArXiv, ISBN: m.ISBN, URL: m.URL, Abstract: m.Abstract}
	for _, c := range m.Creators {
		out.Creators = append(out.Creators, Creator{Given: c.Given, Family: c.Family, Name: c.Name})
	}
	return out
}

// applyFound merges found metadata into a document unless the user edited the
// same fields. The write is conditional so a concurrent manual edit wins.
func (s *Server) applyFound(id string, found PaperMetadata, title, source, lookup string) (Document, error) {
	for range 3 {
		d, err := s.Store.Document(id)
		if err != nil {
			return d, err
		}
		before, _ := json.Marshal(d.Metadata)
		m := d.Metadata
		if m.Sources == nil {
			m.Sources = map[string]string{}
		}
		changed := m.Merge(found, source)
		nextTitle := d.Title
		if title = strings.TrimSpace(title); title != "" && m.Sources["title"] != "manual" && (source == "lookup" || m.Sources["title"] == "") {
			if t, e := cleanText(title, 300, false); e == nil && t != "" {
				nextTitle, m.Sources["title"] = t, source
			}
		}
		author := d.Author
		for _, key := range changed {
			if key == "creators" {
				author = CreatorNames(m.Creators)
			}
		}
		if lookup != "" {
			m.Lookup, m.LookedUpAt = lookup, now()
		}
		after, _ := json.Marshal(m)
		result, err := s.Store.DB.Exec("UPDATE documents SET title=?,author=?,metadata=? WHERE id=? AND metadata=?", nextTitle, author, string(after), id, string(before))
		if err != nil {
			return d, err
		}
		if n, _ := result.RowsAffected(); n == 1 {
			return s.Store.Document(id)
		}
	}
	return Document{}, errors.New("论文信息正在被修改，请重试")
}

// firstPagesText returns text from the first two parsed pages, where papers
// print their DOI or arXiv stamp.
func (s *Server) firstPagesText(id string) (string, layoutManifest) {
	m, err := s.readLayout(id)
	if err != nil {
		return "", m
	}
	var b strings.Builder
	for _, block := range m.Blocks {
		if block.Page <= 2 && b.Len() < 12000 {
			b.WriteString(block.Text)
			b.WriteByte('\n')
		}
	}
	return b.String(), m
}

// fileTitle accepts a PDF's own title only when it looks like a real title.
func fileTitle(m layoutManifest) string {
	for _, key := range []string{"Title", "XMPTitle"} {
		raw, _ := m.Metadata[key].(string)
		title, err := cleanText(strings.Join(strings.Fields(raw), " "), 300, false)
		// Chinese, Japanese and Korean titles need no spaces between words.
		cjk := 0
		for _, r := range title {
			if unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) {
				cjk++
			}
		}
		if err != nil || (cjk < 4 && (len([]rune(title)) < 8 || !strings.Contains(title, " "))) {
			continue
		}
		lower := strings.ToLower(title)
		if strings.HasPrefix(lower, "microsoft word") || strings.HasPrefix(lower, "untitled") ||
			strings.HasSuffix(lower, ".doc") || strings.HasSuffix(lower, ".docx") ||
			strings.HasSuffix(lower, ".tex") || strings.HasSuffix(lower, ".pdf") {
			continue
		}
		return title
	}
	return ""
}

// embeddedPaperMetadata keeps names as written in the PDF. A comma may be a
// separator within a name, so only split an Info author field on semicolons.
func embeddedPaperMetadata(m layoutManifest) PaperMetadata {
	doi, _ := m.Metadata["DOI"].(string)
	venue, _ := m.Metadata["PublicationName"].(string)
	found := PaperMetadata{DOI: doi, Venue: venue}
	addCreator := func(raw string) {
		name, err := cleanText(strings.Join(strings.Fields(raw), " "), 200, false)
		if err == nil && name != "" && len(found.Creators) < 200 {
			found.Creators = append(found.Creators, Creator{Name: name})
		}
	}
	names, _ := m.Metadata["XMPCreators"].([]any)
	for _, value := range names {
		if name, ok := value.(string); ok {
			addCreator(name)
		}
	}
	if len(found.Creators) == 0 {
		author, _ := m.Metadata["Author"].(string)
		for name := range strings.SplitSeq(author, ";") {
			addCreator(name)
		}
	}
	return found
}

var errNoIdentifier = errors.New("没有找到 DOI、PMID 或 arXiv 编号，可以在详情中核对标题或填写 DOI 后重试")

type metadataTitleLookup uint8

const (
	withoutTitle metadataTitleLookup = iota
	withEmbeddedTitle
	withCurrentTitle
)

// lookupDocument finds metadata from the paper's identifiers, its first pages
// or a title match if enabled by the caller.
func (s *Server) lookupDocument(ctx context.Context, id string, titleMode metadataTitleLookup) (Document, error) {
	d, err := s.Store.Document(id)
	if err != nil {
		return d, err
	}
	text, layout := s.firstPagesText(id)
	title := fileTitle(layout)
	embedded := embeddedPaperMetadata(layout)
	if title != "" || embedded.DOI != "" || embedded.Venue != "" || len(embedded.Creators) > 0 {
		d, err = s.applyFound(id, embedded, title, "file", "")
		if err != nil {
			return d, err
		}
	}
	ids := scholar.Identifiers{DOI: d.Metadata.DOI, ArXiv: d.Metadata.ArXiv}
	if ids.DOI == "" && ids.ArXiv == "" {
		ids = scholar.Detect(text)
	}
	if ids == (scholar.Identifiers{}) {
		switch titleMode {
		case withEmbeddedTitle:
			ids.Title, ids.ExactTitle = title, title != ""
		case withCurrentTitle:
			ids.Title = d.Title
		}
		if ids.Title == "" {
			return d, errNoIdentifier
		}
	}
	found, err := s.scholarClient().Lookup(ctx, ids)
	if err != nil {
		return d, err
	}
	return s.applyFound(id, fromScholar(found), found.Title, "lookup", "done")
}

func lookupMessage(err error) string {
	var e scholar.Error
	if errors.As(err, &e) {
		return e.Message
	}
	if errors.Is(err, errNoIdentifier) {
		return err.Error()
	}
	return "查找论文信息失败，请检查网络后重试"
}

func (s *Server) lookupMetadata(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	d, err = s.lookupDocument(ctx, d.ID, withCurrentTitle)
	if err != nil {
		status := 502
		if errors.Is(err, errNoIdentifier) || errors.Is(err, scholar.ErrNotFound) {
			status = 404
		}
		fail(w, status, lookupMessage(err))
		return
	}
	respond(w, 200, d)
}

// resolveDocument imports a paper from an arXiv ID, DOI, link or title.
func (s *Server) resolveDocument(w http.ResponseWriter, r *http.Request) {
	var v struct {
		Ref           string `json:"ref"`
		Library       string `json:"library"`
		AllowLarge    bool   `json:"allowLarge"`
		Folder        string `json:"folder"`
		SmartCategory string `json:"smartCategory"`
	}
	if !decode(w, r, &v) {
		return
	}
	if v.Library == "" {
		v.Library = "papers"
	}
	if !validLibrary(v.Library) {
		fail(w, 400, "未知书库")
		return
	}
	if _, err := s.importCategoryTags(v.Library, v.Folder, v.SmartCategory); err != nil {
		fail(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	result, err := s.scholarClient().Resolve(ctx, v.Ref)
	if err != nil {
		status := 502
		if errors.Is(err, scholar.ErrNotFound) {
			status = 404
		}
		var e scholar.Error
		if errors.As(err, &e) && status == 502 {
			status = 400
		}
		fail(w, status, lookupMessage(err))
		return
	}
	temp, err := os.CreateTemp(s.Store.Root, "import-*")
	if err != nil {
		fail(w, 500, "无法保存文件")
		return
	}
	defer os.Remove(temp.Name())
	_, err = temp.Write(result.PDF)
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		fail(w, 500, "无法保存文件")
		return
	}
	d, status, err := s.importFileToCategory(ctx, temp.Name(), result.Filename, v.Library, v.AllowLarge, v.Folder, v.SmartCategory)
	var imp importError
	if errors.As(err, &imp) && imp.code != "" {
		respond(w, status, map[string]any{"error": imp.message, "code": imp.code, "pages": imp.pages})
		return
	}
	if err != nil {
		fail(w, status, err.Error())
		return
	}
	if d.Library == "papers" {
		m := result.Metadata
		// A raw PDF link can download a file without providing bibliographic data.
		lookup := ""
		if m.Title != "" || m.DOI != "" || m.ArXiv != "" || m.Venue != "" {
			lookup = "done"
		}
		if updated, e := s.applyFound(d.ID, fromScholar(m), m.Title, "lookup", lookup); e == nil {
			d = updated
		}
	}
	respond(w, status, d)
}

func (s *Server) metadataLookupOptions() (enabled bool, titleMode metadataTitleLookup) {
	var value string
	if s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='preferences:library'").Scan(&value) != nil {
		return true, withoutTitle
	}
	var prefs struct {
		Papers struct {
			AutoLookup        *bool `json:"autoLookup"`
			AutoLookupByTitle bool  `json:"autoLookupByTitle"`
		} `json:"papers"`
	}
	if json.Unmarshal([]byte(value), &prefs) != nil {
		return true, withoutTitle
	}
	if prefs.Papers.AutoLookup != nil && !*prefs.Papers.AutoLookup {
		return false, withoutTitle
	}
	if prefs.Papers.AutoLookupByTitle {
		return true, withEmbeddedTitle
	}
	return true, withoutTitle
}

// metadataWorker looks up papers imported from files once their first pages are
// parsed. It sends only identifiers unless the user opts in to title matching.
func (s *Server) metadataWorker(ctx context.Context) {
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		enabled, titleMode := s.metadataLookupOptions()
		if !enabled {
			continue
		}
		rows, err := s.Store.DB.Query(`SELECT d.id FROM documents d LEFT JOIN document_processing p ON p.document_id=d.id
   WHERE d.library='papers' AND d.deleted_at='' AND json_extract(d.metadata,'$.lookup')='pending'
   AND (p.document_id IS NULL OR p.phase!='learning' OR p.status='failed')
   ORDER BY d.created_at`)
		if err != nil {
			continue
		}
		var pending []string
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				pending = append(pending, id)
			}
		}
		rows.Close()
		for _, id := range pending {
			if ctx.Err() != nil || s.lookupPendingMetadata(ctx, id, titleMode) {
				break
			}
		}
	}
}

// Return true only when a lookup was attempted. Unparsed files retain pending
// without blocking later papers; an explicit identifier needs no PDF layout.
func (s *Server) lookupPendingMetadata(ctx context.Context, id string, titleMode metadataTitleLookup) bool {
	work, finish, err := s.beginDocumentTask(ctx, id)
	if err != nil {
		return false
	}
	defer finish()
	d, err := s.Store.Document(id)
	if err != nil || d.Metadata.Lookup != "pending" {
		return false
	}
	if d.Metadata.DOI == "" && d.Metadata.ArXiv == "" {
		if _, err := s.readLayout(id); err != nil {
			return false
		}
	}
	lookupCtx, cancel := context.WithTimeout(work, time.Minute)
	_, err = s.lookupDocument(lookupCtx, id, titleMode)
	cancel()
	if ctx.Err() != nil || work.Err() != nil {
		return true
	}
	state := "done"
	switch {
	case errors.Is(err, errNoIdentifier) || errors.Is(err, scholar.ErrNotFound):
		state = "notFound"
	case err != nil:
		state = "failed"
	}
	if err != nil {
		_, _ = s.applyFound(id, PaperMetadata{}, "", "lookup", state)
	}
	return true
}
