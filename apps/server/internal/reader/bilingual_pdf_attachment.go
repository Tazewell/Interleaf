package reader

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

func (s *Server) attachBilingualPDF(w http.ResponseWriter, r *http.Request) {
	// Deletion holds importMu while joining the job owner. The owner never takes
	// importMu; this handler runs outside the owner's document task.
	j := s.bilingualJob(r)
	if j == nil {
		fail(w, 404, "导出任务不存在或已过期")
		return
	}
	d, e := func() (Document, error) {
		s.importMu.Lock()
		defer s.importMu.Unlock()
		j.mu.Lock()
		defer j.mu.Unlock()
		if e := s.validateBilingualSource(j); e != nil {
			j.cancel()
			return Document{}, bilingualFailure(e.Error())
		}
		if j.state.Status != "ready" {
			return Document{}, bilingualFailure("PDF 尚未成功生成")
		}
		return s.attachBilingualPDFDocument(j)
	}()
	if e != nil {
		fail(w, 409, "挂入文献失败："+bilingualPublicError(e))
		return
	}
	respond(w, 200, d)
}
func (s *Server) attachBilingualPDFDocument(j *bilingualJob) (Document, error) {
	if j.paperID == "" {
		return Document{}, bilingualFailure("原文未关联文献，请先关联后重新导出")
	}
	hash, e := bilingualHash(filepath.Join(j.work, "output.pdf"))
	if e != nil {
		return Document{}, e
	}
	tx, e := s.Store.DB.Begin()
	if e != nil {
		return Document{}, e
	}
	defer tx.Rollback()
	p, e := readPaper(tx, j.paperID)
	if e != nil || p.DeletedAt != "" {
		return Document{}, bilingualFailure("原文所属文献已删除")
	}
	var sourceOwner, sourceDeleted string
	e = tx.QueryRow(`SELECT COALESCE((SELECT paper_id FROM paper_attachments WHERE document_id=d.id),''),deleted_at FROM documents d WHERE id=?`, j.documentID).Scan(&sourceOwner, &sourceDeleted)
	if e != nil || sourceDeleted != "" || sourceOwner != p.ID {
		return Document{}, bilingualFailure("原文已删除或所属文献已变化")
	}
	var owner, role, deleted string
	e = tx.QueryRow(`SELECT COALESCE(a.paper_id,''),COALESCE(a.role,''),d.deleted_at FROM documents d LEFT JOIN paper_attachments a ON a.document_id=d.id WHERE d.id=?`, hash).Scan(&owner, &role, &deleted)
	exists := e == nil
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return Document{}, e
	}
	if exists && (deleted != "" || owner != "" && (owner != p.ID || role != "translation")) {
		return Document{}, bilingualFailure("相同内容已属于其他文献或附件角色，请先处理冲突")
	}
	target := s.Store.File(Document{ID: hash, Type: "pdf"})
	createdFile := false
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		// O_EXCL preserves any content-addressed file that existed before this call.
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return Document{}, err
		}
		createdFile = true
		in, err := os.Open(filepath.Join(j.work, "output.pdf"))
		if err == nil {
			_, err = io.Copy(out, in)
			in.Close()
		}
		closeErr := out.Close()
		if err != nil || closeErr != nil {
			os.Remove(target)
			return Document{}, bilingualFailure("附件文件写入失败")
		}
	} else if err != nil {
		return Document{}, err
	}
	committed := false
	defer func() {
		if createdFile && !committed {
			os.Remove(target)
		}
	}()
	if got, err := bilingualHash(target); err != nil || got != hash {
		return Document{}, bilingualFailure("附件文件与内容地址不匹配")
	}
	if !exists {
		info, err := os.Stat(target)
		if err != nil {
			return Document{}, err
		}
		// Insert as books to avoid paper_document_insert making an orphan paper;
		// binding precedes the library projection, all inside this transaction.
		_, e = tx.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library,category,category_source,classification_status) VALUES(?,'pdf',?,?,?, ?,?,'books','paper','manual','done')`, hash, p.Title, p.Author, info.Size(), now(), now())
		if e != nil {
			return Document{}, e
		}
	}
	if owner == "" {
		_, e = tx.Exec(`INSERT INTO paper_attachments(document_id,paper_id,role) VALUES(?,?,'translation')`, hash, p.ID)
		if e != nil {
			return Document{}, e
		}
	}
	_, e = tx.Exec(`UPDATE documents SET library='papers' WHERE id=?`, hash)
	if e != nil {
		return Document{}, e
	}
	if e = syncPaperAttachments(tx, p.ID); e != nil {
		return Document{}, e
	}
	// importMu serializes reader deletion/merge. Recheck actual bytes immediately
	// before commit as external source-file changes do not take that lock.
	source := s.Store.File(Document{ID: j.documentID, Type: "pdf"})
	if got, err := bilingualHash(source); err != nil || got != j.originalHash || j.ctx.Err() != nil {
		return Document{}, bilingualFailure("原文已变化或任务已取消")
	}
	raw, err := limitedBilingualRead(filepath.Join(s.analysisDir(j.documentID), "manifest.json"), 32<<20)
	if err != nil || sourceKey(string(raw)) != j.layoutHash {
		return Document{}, bilingualFailure("版面已变化")
	}
	if e = tx.Commit(); e != nil {
		return Document{}, e
	}
	committed = true
	return s.Store.Document(hash)
}
