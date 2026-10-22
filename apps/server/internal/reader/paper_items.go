package reader

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type PaperAttachment struct {
	DocumentID string `json:"documentId"`
	Role       string `json:"role"`
	Title      string `json:"title"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
}
type PaperItem struct {
	ID                string            `json:"id"`
	Title             string            `json:"title"`
	Author            string            `json:"author"`
	Metadata          PaperMetadata     `json:"metadata"`
	Tags              []string          `json:"tags"`
	Folders           []string          `json:"folders"`
	Favorite          bool              `json:"favorite"`
	CreatedAt         string            `json:"createdAt"`
	DeletedAt         string            `json:"deletedAt,omitempty"`
	PrimaryDocumentID string            `json:"primaryDocumentId"`
	CitationKey       string            `json:"citationKey"`
	Attachments       []PaperAttachment `json:"attachments"`
}
type paperQuery interface {
	QueryRow(string, ...any) *sql.Row
	Query(string, ...any) (*sql.Rows, error)
}

func readPaper(q paperQuery, id string) (PaperItem, error) {
	var p PaperItem
	var metadata, tags, folders string
	err := q.QueryRow(`SELECT id,title,author,metadata,tags,folders,favorite,created_at,deleted_at,primary_document_id,citation_key FROM paper_items WHERE id=COALESCE((SELECT target_id FROM paper_redirects WHERE id=?),?)`, id, id).Scan(&p.ID, &p.Title, &p.Author, &metadata, &tags, &folders, &p.Favorite, &p.CreatedAt, &p.DeletedAt, &p.PrimaryDocumentID, &p.CitationKey)
	if err != nil {
		return p, err
	}
	for _, v := range []struct {
		raw   string
		value any
	}{{metadata, &p.Metadata}, {tags, &p.Tags}, {folders, &p.Folders}} {
		if err = json.Unmarshal([]byte(v.raw), v.value); err != nil {
			return p, err
		}
	}
	p.Attachments = []PaperAttachment{}
	rows, err := q.Query(`SELECT d.id,a.role,d.title,d.type,d.size FROM paper_attachments a JOIN documents d ON d.id=a.document_id WHERE a.paper_id=? ORDER BY d.id`, p.ID)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	for rows.Next() {
		var a PaperAttachment
		if err = rows.Scan(&a.DocumentID, &a.Role, &a.Title, &a.Type, &a.Size); err != nil {
			return p, err
		}
		p.Attachments = append(p.Attachments, a)
	}
	return p, rows.Err()
}
func (s *Store) PaperItem(id string) (PaperItem, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return PaperItem{}, err
	}
	defer tx.Rollback()
	p, err := readPaper(tx, id)
	if err != nil {
		return p, err
	}
	return p, tx.Commit()
}
func (s *Store) PaperItems() ([]PaperItem, error) { return s.paperItems(false) }
func (s *Store) paperItems(trash bool) ([]PaperItem, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT id FROM paper_items WHERE (deleted_at!='')=? ORDER BY created_at,id`, trash)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := []PaperItem{}
	for _, id := range ids {
		p, err := readPaper(tx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, tx.Commit()
}

var errPaperConflict = errors.New("文献冲突")

func paperConflict(message string) error { return fmt.Errorf("%w: %s", errPaperConflict, message) }
func paperError(w http.ResponseWriter, err error) {
	status := 400
	if errors.Is(err, sql.ErrNoRows) {
		status = 404
	} else if errors.Is(err, errPaperConflict) {
		status = 409
	}
	fail(w, status, err.Error())
}

type PaperPatch struct {
	Title             *string                    `json:"title"`
	Author            *string                    `json:"author"`
	Metadata          map[string]json.RawMessage `json:"metadata"`
	Tags              json.RawMessage            `json:"tags"`
	Folders           json.RawMessage            `json:"folders"`
	Favorite          *bool                      `json:"favorite"`
	PrimaryDocumentID *string                    `json:"primaryDocumentId"`
	CitationKey       *string                    `json:"citationKey"`
}

func applyPaperPatch(tx *sql.Tx, p *PaperItem, v PaperPatch) error {
	var err error
	if v.Title != nil {
		p.Title, err = cleanText(*v.Title, 300, false)
		if err != nil || p.Title == "" {
			return errors.New("标题须为 1–300 个字符")
		}
		if p.Metadata.Sources == nil {
			p.Metadata.Sources = map[string]string{}
		}
		p.Metadata.Sources["title"] = "manual"
	}
	if v.Author != nil {
		p.Author, err = cleanText(*v.Author, 200, false)
		if err != nil {
			return err
		}
	}
	if err = p.Metadata.ApplyManual(v.Metadata); err != nil {
		return err
	}
	if _, ok := v.Metadata["creators"]; ok && v.Author == nil {
		p.Author = CreatorNames(p.Metadata.Creators)
	}
	if v.Tags != nil {
		p.Tags, err = normalizeTags(v.Tags)
		if err != nil {
			return err
		}
	}
	if v.Folders != nil {
		p.Folders, err = normalizeTags(v.Folders)
		if err != nil {
			return err
		}
	}
	if v.Favorite != nil {
		p.Favorite = *v.Favorite
	}
	if v.PrimaryDocumentID != nil {
		found := *v.PrimaryDocumentID == "" && len(p.Attachments) == 0
		for _, a := range p.Attachments {
			found = found || a.DocumentID == *v.PrimaryDocumentID
		}
		if !found {
			return errors.New("主附件必须属于当前文献")
		}
		p.PrimaryDocumentID = *v.PrimaryDocumentID
	}
	if v.CitationKey != nil && *v.CitationKey != p.CitationKey {
		if err = reserveCitationKey(tx, p.ID, *v.CitationKey); err != nil {
			return err
		}
		p.CitationKey = *v.CitationKey
	}
	return nil
}
func savePaper(tx *sql.Tx, p PaperItem) error {
	m, _ := json.Marshal(p.Metadata)
	tags, _ := json.Marshal(p.Tags)
	folders, _ := json.Marshal(p.Folders)
	_, err := tx.Exec(`UPDATE paper_items SET title=?,author=?,metadata=?,tags=?,folders=?,favorite=?,primary_document_id=?,citation_key=? WHERE id=?`, p.Title, p.Author, string(m), string(tags), string(folders), p.Favorite, p.PrimaryDocumentID, p.CitationKey, p.ID)
	return err
}
func (s *Store) CreatePaperItem(v PaperPatch) (PaperItem, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return PaperItem{}, err
	}
	defer tx.Rollback()
	p := PaperItem{ID: id(), CreatedAt: now(), Tags: []string{}, Folders: []string{}, Attachments: []PaperAttachment{}}
	if v.Title == nil {
		return p, errors.New("请输入标题")
	}
	if err = applyPaperPatch(tx, &p, v); err != nil {
		return p, err
	}
	if _, err = tx.Exec(`INSERT INTO paper_items(id,title,created_at) VALUES(?,?,?)`, p.ID, p.Title, p.CreatedAt); err != nil {
		return p, err
	}
	if err = savePaper(tx, p); err != nil {
		return p, err
	}
	return p, tx.Commit()
}
func (s *Store) UpdatePaperItem(id string, v PaperPatch) (PaperItem, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return PaperItem{}, err
	}
	defer tx.Rollback()
	p, err := readPaper(tx, id)
	if err != nil {
		return p, err
	}
	if err = applyPaperPatch(tx, &p, v); err != nil {
		return p, err
	}
	if err = savePaper(tx, p); err != nil {
		return p, err
	}
	p, err = readPaper(tx, p.ID)
	if err != nil {
		return p, err
	}
	return p, tx.Commit()
}
func (s *Server) registerPaperRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/papers", func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Store.paperItems(r.URL.Query().Get("trash") == "true")
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, p)
	})
	mux.HandleFunc("POST /api/papers", func(w http.ResponseWriter, r *http.Request) {
		var v PaperPatch
		if !decode(w, r, &v) {
			return
		}
		p, err := s.Store.CreatePaperItem(v)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 201, p)
	})
	mux.HandleFunc("GET /api/papers/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Store.PaperItem(r.PathValue("id"))
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, p)
	})
	mux.HandleFunc("PATCH /api/papers/{id}", func(w http.ResponseWriter, r *http.Request) {
		var v PaperPatch
		if !decode(w, r, &v) {
			return
		}
		p, err := s.Store.UpdatePaperItem(r.PathValue("id"), v)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, p)
	})
	mux.HandleFunc("POST /api/papers/citation-keys", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			IDs []string `json:"ids"`
		}
		if !decode(w, r, &v) {
			return
		}
		p, err := s.Store.EnsureCitationKeys(v.IDs)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, p)
	})
	mux.HandleFunc("PUT /api/papers/{id}/attachments/{documentId}", s.paperAttachment)
	mux.HandleFunc("DELETE /api/papers/{id}/attachments/{documentId}", s.paperAttachment)
	mux.HandleFunc("POST /api/papers/{id}/merge", s.mergePaper)
	mux.HandleFunc("POST /api/papers/{id}/trash", s.paperTrash)
	mux.HandleFunc("POST /api/papers/{id}/restore", s.paperTrash)
	mux.HandleFunc("DELETE /api/papers/{id}", s.deletePaper)
}
func (s *Server) paperAttachment(w http.ResponseWriter, r *http.Request) {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	var v struct {
		Role    string `json:"role"`
		Primary bool   `json:"primary"`
	}
	if r.Method == "PUT" && !decode(w, r, &v) {
		return
	}
	if v.Role == "" {
		v.Role = "original"
	}
	if v.Role != "original" && v.Role != "translation" && v.Role != "supplement" && v.Role != "other" {
		paperError(w, errors.New("无效附件角色"))
		return
	}
	tx, err := s.Store.DB.Begin()
	if err != nil {
		paperError(w, err)
		return
	}
	defer tx.Rollback()
	p, err := readPaper(tx, r.PathValue("id"))
	if err != nil {
		paperError(w, err)
		return
	}
	docID := r.PathValue("documentId")
	var owner, typ, deleted string
	err = tx.QueryRow(`SELECT type,deleted_at,COALESCE((SELECT paper_id FROM paper_attachments WHERE document_id=documents.id),'') FROM documents WHERE id=?`, docID).Scan(&typ, &deleted, &owner)
	if err != nil {
		paperError(w, err)
		return
	}
	if owner != "" && owner != p.ID {
		paperError(w, paperConflict("附件已属于其他文献，请先解除关联或合并"))
		return
	}
	if r.Method == "DELETE" {
		if owner != p.ID {
			paperError(w, sql.ErrNoRows)
			return
		}
		_, err = tx.Exec(`DELETE FROM paper_attachments WHERE document_id=?`, docID)
		if err == nil {
			_, err = tx.Exec(`DELETE FROM paper_detached_documents WHERE document_id=?`, docID)
		}
		if err == nil {
			_, err = tx.Exec(`UPDATE documents SET library='books' WHERE id=?`, docID)
		}
	} else {
		if typ != "pdf" && typ != "epub" {
			paperError(w, errors.New("仅支持 PDF / EPUB 附件"))
			return
		}
		if p.DeletedAt != "" || deleted != "" {
			paperError(w, paperConflict("请先恢复文献和附件"))
			return
		}
		_, err = tx.Exec(`INSERT INTO paper_attachments(document_id,paper_id,role) VALUES(?,?,?) ON CONFLICT(document_id) DO UPDATE SET role=excluded.role`, docID, p.ID, v.Role)
		if err == nil {
			_, err = tx.Exec(`UPDATE documents SET library='papers' WHERE id=?`, docID)
		}
		if err == nil && (v.Primary || p.PrimaryDocumentID == "") {
			_, err = tx.Exec(`UPDATE paper_items SET primary_document_id=? WHERE id=?`, docID, p.ID)
		}
		if err == nil {
			err = syncPaperAttachments(tx, p.ID)
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		paperError(w, err)
		return
	}
	p, err = s.Store.PaperItem(p.ID)
	if err != nil {
		paperError(w, err)
		return
	}
	respond(w, 200, p)
}

// Permanent file deletion always goes through purgeDocument, which cancels and
// joins document work before removing reader records and library-owned files.
func (s *Server) deletePaper(w http.ResponseWriter, r *http.Request) {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	p, err := s.Store.PaperItem(r.PathValue("id"))
	if err != nil {
		paperError(w, err)
		return
	}
	if len(p.Attachments) > 0 && p.DeletedAt == "" {
		paperError(w, paperConflict("请先将文献移到回收站，或解除附件关联"))
		return
	}
	for _, a := range p.Attachments {
		if status, message := s.purgeDocument(r.Context(), a.DocumentID); message != "" {
			fail(w, status, message)
			return
		}
	}
	if _, err = s.Store.DB.Exec(`DELETE FROM paper_items WHERE id=?`, p.ID); err != nil {
		paperError(w, err)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) paperTrash(w http.ResponseWriter, r *http.Request) {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	p, err := s.Store.PaperItem(r.PathValue("id"))
	if err != nil {
		paperError(w, err)
		return
	}
	restore := strings.HasSuffix(r.URL.Path, "/restore")
	for _, a := range p.Attachments {
		if restore {
			_, err = s.restore(a.DocumentID)
			if err != nil {
				paperError(w, err)
				return
			}
		} else {
			_, status, message := s.moveToTrash(r.Context(), a.DocumentID)
			if status != 0 {
				fail(w, status, message)
				return
			}
		}
	}
	deleted := ""
	if !restore {
		deleted = now()
	}
	_, err = s.Store.DB.Exec(`UPDATE paper_items SET deleted_at=? WHERE id=?`, deleted, p.ID)
	if err != nil {
		paperError(w, err)
		return
	}
	p, err = s.Store.PaperItem(p.ID)
	if err != nil {
		paperError(w, err)
		return
	}
	respond(w, 200, p)
}

type PaperMerge struct {
	IDs                   []string         `json:"ids"`
	CitationKey           string           `json:"citationKey"`
	ConfirmCitationChange bool             `json:"confirmCitationChange"`
	Patch                 *PaperMergePatch `json:"patch,omitempty"`
}

// Explicit conflict selections share the merge transaction. Citation keys and
// attachment membership cannot be changed through this metadata-only patch.
type PaperMergePatch struct {
	Title    *string                    `json:"title"`
	Author   *string                    `json:"author"`
	Metadata map[string]json.RawMessage `json:"metadata"`
}

func (s *Server) mergePaper(w http.ResponseWriter, r *http.Request) {
	var v PaperMerge
	if !decode(w, r, &v) {
		return
	}
	s.importMu.Lock()
	defer s.importMu.Unlock()
	p, err := s.Store.MergePaperItems(r.PathValue("id"), v)
	if err != nil {
		paperError(w, err)
		return
	}
	respond(w, 200, p)
}

// MergePaperItems preserves document-local reading data. Missing bibliographic
// fields are filled; conflicting values retain the explicitly selected target.
func (s *Store) MergePaperItems(id string, v PaperMerge) (PaperItem, error) {
	if len(v.IDs) == 0 || len(v.IDs) > 1000 {
		return PaperItem{}, errors.New("请选择 1–1000 篇待合并文献")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return PaperItem{}, err
	}
	defer tx.Rollback()
	p, err := readPaper(tx, id)
	if err != nil {
		return p, err
	}
	refreshAuthor := p.Author == "" || p.Author == CreatorNames(p.Metadata.Creators)
	sources := []PaperItem{}
	seen := map[string]bool{p.ID: true}
	keys := map[string]string{}
	if p.CitationKey != "" {
		keys[strings.ToLower(p.CitationKey)] = p.CitationKey
	}
	for _, id := range v.IDs {
		source, e := readPaper(tx, id)
		if e != nil {
			return p, e
		}
		if seen[source.ID] {
			return p, errors.New("合并列表重复或包含目标文献")
		}
		seen[source.ID] = true
		if p.DeletedAt != "" || source.DeletedAt != "" {
			return p, paperConflict("请先恢复文献")
		}
		sources = append(sources, source)
		if source.CitationKey != "" {
			keys[strings.ToLower(source.CitationKey)] = source.CitationKey
		}
	}
	if len(keys) > 1 && (!v.ConfirmCitationChange || keys[strings.ToLower(v.CitationKey)] == "") {
		return p, paperConflict("请选择保留的引用键并确认已有引用的影响")
	}
	chosen := p.CitationKey
	if len(keys) == 1 && chosen == "" {
		for _, k := range keys {
			chosen = k
		}
	}
	if v.CitationKey != "" {
		chosen = keys[strings.ToLower(v.CitationKey)]
		if chosen == "" {
			return p, errors.New("请选择这些文献已有的引用键")
		}
	}
	for _, source := range sources {
		if err = mergePaperBibliography(tx, p.ID, source.ID); err != nil {
			return p, err
		}
		p.Metadata.FillFrom(source.Metadata)
		p.Tags = append(p.Tags, source.Tags...)
		p.Folders = append(p.Folders, source.Folders...)
		p.Favorite = p.Favorite || source.Favorite
		if _, err = tx.Exec(`UPDATE paper_attachments SET paper_id=? WHERE paper_id=?`, p.ID, source.ID); err != nil {
			return p, err
		}
		if _, err = tx.Exec(`UPDATE paper_detached_documents SET paper_id=? WHERE paper_id=?`, p.ID, source.ID); err != nil {
			return p, err
		}
		if _, err = tx.Exec(`UPDATE paper_redirects SET target_id=? WHERE target_id=?`, p.ID, source.ID); err != nil {
			return p, err
		}
		if _, err = tx.Exec(`DELETE FROM paper_items WHERE id=?`, source.ID); err != nil {
			return p, err
		}
		if _, err = tx.Exec(`INSERT INTO paper_redirects(id,target_id) VALUES(?,?)`, source.ID, p.ID); err != nil {
			return p, err
		}
	}
	if chosen != "" {
		if _, err = tx.Exec(`UPDATE paper_citation_keys SET paper_id=? WHERE key=?`, p.ID, chosen); err != nil {
			return p, err
		}
	}
	for _, labels := range []*[]string{&p.Tags, &p.Folders} {
		raw, _ := json.Marshal(*labels)
		*labels, err = normalizeTags(raw)
		if err != nil {
			return p, err
		}
	}
	if refreshAuthor && len(p.Metadata.Creators) > 0 {
		p.Author = CreatorNames(p.Metadata.Creators)
	}
	p.CitationKey = chosen
	if v.Patch != nil {
		author := v.Patch.Author
		if !refreshAuthor && author == nil {
			// Selecting creators in a merge does not select the independent
			// display author. Keep it explicit to avoid PATCH's derivation.
			author = &p.Author
		}
		if err = applyPaperPatch(tx, &p, PaperPatch{Title: v.Patch.Title, Author: author, Metadata: v.Patch.Metadata}); err != nil {
			return p, err
		}
	}
	if p.PrimaryDocumentID == "" {
		if err = tx.QueryRow(`SELECT COALESCE(min(document_id),'') FROM paper_attachments WHERE paper_id=?`, p.ID).Scan(&p.PrimaryDocumentID); err != nil {
			return p, err
		}
	}
	if err = savePaper(tx, p); err != nil {
		return p, err
	}
	if err = syncPaperAttachments(tx, p.ID); err != nil {
		return p, err
	}
	p, err = readPaper(tx, p.ID)
	if err != nil {
		return p, err
	}
	return p, tx.Commit()
}
