package interleaf

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const paperTitleBackfillKey = "migration:local-paper-titles-v1"

// Existing parsed papers can acquire local titles without replacing their
// analysis, translation, or annotations. A scan needs only its first page.
func (s *Server) backfillLocalPaperTitles(ctx context.Context) {
	var done string
	if s.Store.DB.QueryRowContext(ctx, "SELECT value FROM settings WHERE key=?", paperTitleBackfillKey).Scan(&done) == nil {
		return
	}
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT d.id FROM documents d
 JOIN paper_attachments a ON a.document_id=d.id AND a.role='original'
 JOIN paper_items i ON i.id=a.paper_id AND i.primary_document_id=d.id
 JOIN document_processing p ON p.document_id=d.id
 WHERE d.type='pdf' AND d.library='papers' AND d.deleted_at=''
 AND COALESCE(json_extract(d.metadata,'$.sources.title'),'')=''
 AND (p.phase!='learning' OR p.status='failed')`)
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return
	}
	complete := true
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		if !s.backfillLocalPaperTitle(ctx, id) {
			complete = false
		}
	}
	if complete {
		_, _ = s.Store.DB.ExecContext(ctx, "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", paperTitleBackfillKey, "true")
	}
}

func (s *Server) backfillLocalPaperTitle(ctx context.Context, id string) bool {
	work, finish, err := s.beginDocumentTask(ctx, id)
	if err != nil {
		return false
	}
	defer finish()
	m, err := s.readLayout(id)
	if err != nil {
		return true
	}
	doc, err := s.applyLocalPaperMetadata(id, m)
	if err != nil {
		return false
	}
	if doc.Metadata.Sources["title"] != "" || !hasScannedTitleRegion(m) || runtime.GOOS != "windows" {
		return true
	}
	if os.Getenv("INTERLEAF_NODE") == "" || os.Getenv("INTERLEAF_PROCESSOR") == "" {
		return false
	}
	dir, err := os.MkdirTemp(s.Store.Root, "paper-title-")
	if err != nil {
		return false
	}
	defer os.RemoveAll(dir)
	child, cancel := context.WithTimeout(work, 60*time.Second)
	defer cancel()
	if s.runLayout(child, doc, dir, 1, 1, nil) != nil {
		return false
	}
	refreshed, err := readValidatedLayout(filepath.Join(dir, "manifest.json"))
	if err != nil || work.Err() != nil {
		return false
	}
	_, err = s.applyLocalPaperMetadata(id, refreshed)
	return err == nil
}

func hasScannedTitleRegion(m layoutManifest) bool {
	hasTitle := false
	for _, b := range m.Blocks {
		if b.Page != 1 {
			continue
		}
		if strings.TrimSpace(b.Text) != "" {
			return false
		}
		hasTitle = hasTitle || (b.Label == "doc_title" && b.Bounds.Y < 0.45)
	}
	return hasTitle
}
