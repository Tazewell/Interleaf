package interleaf

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type BibliographyExportRequest struct {
	Folder          string `json:"folder"`
	IncludeChildren bool   `json:"includeChildren"`
	Mode            string `json:"mode"`
	Path            string `json:"path"`
	Takeover        bool   `json:"takeover"`
}
type BibliographyExport struct {
	ID              string `json:"id"`
	Folder          string `json:"folder"`
	IncludeChildren bool   `json:"includeChildren"`
	Mode            string `json:"mode"`
	Path            string `json:"path"`
	LastExportedAt  string `json:"lastExportedAt"`
	Error           string `json:"error"`
	Paused          bool   `json:"paused"`
	Fingerprint     string `json:"-"`
	ParentID        string `json:"-"`
}

func (s *Store) migrateBibliographyExports() error {
	_, err := s.DB.Exec(`CREATE TABLE IF NOT EXISTS bibliography_exports(id TEXT PRIMARY KEY,folder TEXT NOT NULL,include_children INTEGER NOT NULL,mode TEXT NOT NULL,path TEXT NOT NULL UNIQUE,last_exported_at TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',paused INTEGER NOT NULL DEFAULT 0,fingerprint TEXT NOT NULL,parent_id TEXT NOT NULL);`)
	return err
}

const exportColumns = `id,folder,include_children,mode,path,last_exported_at,error,paused,fingerprint,parent_id`

func scanBibliographyExport(row rowScanner) (BibliographyExport, error) {
	var e BibliographyExport
	err := row.Scan(&e.ID, &e.Folder, &e.IncludeChildren, &e.Mode, &e.Path, &e.LastExportedAt, &e.Error, &e.Paused, &e.Fingerprint, &e.ParentID)
	return e, err
}
func (s *Store) BibliographyExports() ([]BibliographyExport, error) {
	rows, err := s.DB.Query(`SELECT ` + exportColumns + ` FROM bibliography_exports ORDER BY path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BibliographyExport{}
	for rows.Next() {
		e, err := scanBibliographyExport(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
func fileFingerprint(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }
func exportDirectory(path string) (*os.Root, error) {
	if !filepath.IsAbs(path) || filepath.Ext(path) != ".bib" {
		return nil, errors.New("请选择完整的 .bib 文件路径")
	}
	parent := filepath.Dir(filepath.Clean(path))
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return nil, err
	}
	if resolved != parent {
		return nil, errors.New("导出目录不能通过符号链接访问")
	}
	return os.OpenRoot(parent)
}

func exportFile(root *os.Root, name string) ([]byte, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("导出位置必须是普通文件")
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("导出文件在检查期间变化")
	}
	if info.Size() > 32<<20 {
		return nil, errors.New("导出文件超过 32 MiB")
	}
	return io.ReadAll(io.LimitReader(f, 32<<20+1))
}
func (s *Store) RegisterBibliographyExport(v BibliographyExportRequest) (BibliographyExport, error) {
	s.bibliographyExportMu.Lock()
	defer s.bibliographyExportMu.Unlock()
	if v.Mode != "bibtex" && v.Mode != "biblatex" {
		return BibliographyExport{}, errors.New("无效导出模式")
	}
	if len(v.Folder) > 1000 || strings.ContainsAny(v.Folder, "\x00\r\n") {
		return BibliographyExport{}, errors.New("无效分类")
	}
	v.Path = filepath.Clean(v.Path)
	root, err := exportDirectory(v.Path)
	if err != nil {
		return BibliographyExport{}, err
	}
	defer root.Close()
	name := filepath.Base(v.Path)
	targetInfo, err := root.Lstat(name)
	if err != nil && !os.IsNotExist(err) {
		return BibliographyExport{}, err
	}
	exports, err := s.BibliographyExports()
	if err != nil {
		return BibliographyExport{}, err
	}
	for _, existing := range exports {
		if existing.Path == v.Path {
			return BibliographyExport{}, paperConflict("此文件已有自动导出配置，请先停止原配置")
		}
		if targetInfo == nil {
			continue
		}
		ownedInfo, statErr := os.Lstat(existing.Path)
		if statErr != nil && !os.IsNotExist(statErr) {
			return BibliographyExport{}, statErr
		}
		// Compare filesystem identities, so case aliases and hard links cannot
		// acquire a second owner. Case-sensitive files remain distinct.
		if statErr == nil && os.SameFile(targetInfo, ownedInfo) {
			return BibliographyExport{}, paperConflict("此文件已有自动导出配置，请先停止原配置")
		}
	}
	parentInfo, err := root.Stat(".")
	if err != nil {
		return BibliographyExport{}, err
	}
	// Record a random marker filename, rather than unstable directory mtimes.
	marker := ".interleaf-bib-directory-" + id()
	markerFile, err := root.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return BibliographyExport{}, err
	}
	markerFile.Close()
	success := false
	defer func() {
		if !success {
			root.Remove(marker)
		}
	}()
	bytes, err := exportFile(root, name)
	fingerprint := "missing"
	if err == nil {
		if !v.Takeover {
			return BibliographyExport{}, paperConflict("文件已存在，请先确认备份并接管")
		}
		backup, err := root.OpenFile(name+".interleaf-backup-"+id(), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return BibliographyExport{}, err
		}
		if _, err = backup.Write(bytes); err == nil {
			err = backup.Sync()
		}
		closeErr := backup.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return BibliographyExport{}, err
		}
		fingerprint = fileFingerprint(bytes)
	} else if !os.IsNotExist(err) {
		return BibliographyExport{}, err
	}
	// Verify the named directory still refers to the pinned root before granting it.
	current, err := os.Stat(filepath.Dir(v.Path))
	if err != nil || !os.SameFile(parentInfo, current) {
		return BibliographyExport{}, errors.New("导出目录在选择期间变化")
	}
	e := BibliographyExport{ID: id(), Folder: strings.TrimSpace(v.Folder), IncludeChildren: v.IncludeChildren, Mode: v.Mode, Path: v.Path, Fingerprint: fingerprint, ParentID: marker}
	_, err = s.DB.Exec(`INSERT INTO bibliography_exports(`+exportColumns+`) VALUES(?,?,?,?,?,'','',0,?,?)`, e.ID, e.Folder, e.IncludeChildren, e.Mode, e.Path, e.Fingerprint, e.ParentID)
	if err != nil {
		return e, err
	}
	success = true
	e, err = s.refreshBibliographyExport(e.ID)
	return e, err
}
func (s *Store) RefreshBibliographyExport(exportID string) (BibliographyExport, error) {
	s.bibliographyExportMu.Lock()
	defer s.bibliographyExportMu.Unlock()
	return s.refreshBibliographyExport(exportID)
}
func (s *Store) refreshBibliographyExport(exportID string) (e BibliographyExport, err error) {
	e, err = scanBibliographyExport(s.DB.QueryRow(`SELECT `+exportColumns+` FROM bibliography_exports WHERE id=?`, exportID))
	if err != nil {
		return e, err
	}
	defer func() {
		if err != nil {
			e.Error = err.Error()
			_, _ = s.DB.Exec(`UPDATE bibliography_exports SET error=? WHERE id=?`, e.Error, e.ID)
		}
	}()
	if e.Paused {
		return e, errors.New("分类已删除，自动导出已暂停")
	}
	root, err := exportDirectory(e.Path)
	if err != nil {
		return e, err
	}
	defer root.Close()
	if info, e2 := root.Lstat(e.ParentID); e2 != nil || !info.Mode().IsRegular() {
		return e, errors.New("导出目录身份已改变，请重新选择位置")
	}
	pinned, err := root.Stat(".")
	if err != nil {
		return e, err
	}
	name := filepath.Base(e.Path)
	current, err := exportFile(root, name)
	if err == nil {
		if fileFingerprint(current) != e.Fingerprint {
			return e, paperConflict("文件被外部修改，已停止覆盖，请另选文件或备份后重新接管")
		}
	} else if !os.IsNotExist(err) || e.Fingerprint != "missing" {
		return e, errors.New("导出文件缺失或不可读取，请重新选择位置")
	}
	papers, err := s.PaperItems()
	if err != nil {
		return e, err
	}
	ids := []string{}
	for _, p := range papers {
		hit := e.Folder == ""
		for _, folder := range p.Folders {
			rest, ok := tagSuffix(folder, e.Folder)
			if ok && (rest == "" || e.IncludeChildren) {
				hit = true
			}
		}
		if hit {
			ids = append(ids, p.ID)
		}
	}
	text, err := s.Bibliography(ids, e.Mode)
	if err != nil {
		return e, err
	}
	nextFingerprint := fileFingerprint([]byte(text))
	if nextFingerprint != e.Fingerprint {
		temporary := ".interleaf-bib-" + id() + ".tmp"
		f, e2 := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e2 != nil {
			return e, e2
		}
		defer root.Remove(temporary)
		_, err = f.WriteString(text)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return e, err
		}
		// Recheck after rendering: external edits during generation must win.
		checked, e2 := exportFile(root, name)
		if e2 == nil {
			if fileFingerprint(checked) != e.Fingerprint {
				return e, paperConflict("导出期间文件被外部修改，已停止覆盖")
			}
		} else if !os.IsNotExist(e2) || e.Fingerprint != "missing" {
			return e, errors.New("导出文件在生成期间变化")
		}
		info, e2 := os.Stat(filepath.Dir(e.Path))
		if e2 != nil || !os.SameFile(info, pinned) {
			return e, errors.New("导出目录已改变")
		}
		if err = root.Rename(temporary, name); err != nil {
			return e, err
		}
	}
	e.Fingerprint = nextFingerprint
	e.Error = ""
	e.LastExportedAt = now()
	_, err = s.DB.Exec(`UPDATE bibliography_exports SET fingerprint=?,last_exported_at=?,error='' WHERE id=?`, e.Fingerprint, e.LastExportedAt, e.ID)
	return e, err
}
func (s *Store) renameBibliographyExportFolders(tx *sql.Tx, from, to string) error {
	rows, err := tx.Query(`SELECT id,folder FROM bibliography_exports`)
	if err != nil {
		return err
	}
	type change struct{ id, folder string }
	changes := []change{}
	for rows.Next() {
		var c change
		if err = rows.Scan(&c.id, &c.folder); err != nil {
			rows.Close()
			return err
		}
		if rest, ok := tagSuffix(c.folder, from); ok {
			if to != "" {
				c.folder = to + rest
			}
			changes = append(changes, c)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, c := range changes {
		if to == "" {
			_, err = tx.Exec(`UPDATE bibliography_exports SET paused=1,error='分类已删除，自动导出已暂停' WHERE id=?`, c.id)
		} else {
			_, err = tx.Exec(`UPDATE bibliography_exports SET folder=? WHERE id=?`, c.folder, c.id)
		}
		if err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) SetBibliographyExportCapability(secret string) {
	s.exportCapability = secret
}
func (s *Server) registerBibliographyExportRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/papers/exports", func(w http.ResponseWriter, r *http.Request) {
		exports, err := s.Store.BibliographyExports()
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, exports)
	})
	mux.HandleFunc("POST /api/papers/exports", func(w http.ResponseWriter, r *http.Request) {
		secret := r.Header.Get("X-Interleaf-Export-Capability")
		if s.exportCapability == "" || subtle.ConstantTimeCompare([]byte(secret), []byte(s.exportCapability)) != 1 {
			fail(w, 403, "请从桌面版选择导出位置")
			return
		}
		var v BibliographyExportRequest
		if !decode(w, r, &v) {
			return
		}
		e, err := s.Store.RegisterBibliographyExport(v)
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 201, e)
	})
	mux.HandleFunc("POST /api/papers/exports/{id}/refresh", func(w http.ResponseWriter, r *http.Request) {
		e, err := s.Store.RefreshBibliographyExport(r.PathValue("id"))
		if err != nil {
			paperError(w, err)
			return
		}
		respond(w, 200, e)
	})
	mux.HandleFunc("DELETE /api/papers/exports/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.Store.bibliographyExportMu.Lock()
		defer s.Store.bibliographyExportMu.Unlock()
		_, err := s.Store.DB.Exec(`DELETE FROM bibliography_exports WHERE id=?`, r.PathValue("id"))
		if err != nil {
			paperError(w, err)
			return
		}
		w.WriteHeader(204)
	})
}
func (s *Server) StartBibliographyExports(ctx context.Context) func() {
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			exports, err := s.Store.BibliographyExports()
			if err == nil {
				for _, e := range exports {
					if ctx.Err() != nil {
						return
					}
					if !e.Paused {
						_, _ = s.Store.RefreshBibliographyExport(e.ID)
					}
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { <-done }
}
