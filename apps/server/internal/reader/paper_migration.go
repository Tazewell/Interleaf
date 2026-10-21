package reader

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
)

// Compatibility columns are a transactionally maintained projection of paper_items.
// Legacy importers and metadata workers still issue SQL against documents: these
// triggers adapt those writes, including writes inside their existing transactions.
// Only changed columns propagate, so a stale legacy row cannot replace other fields.
func (s *Store) migratePaperItems() error {
	var exists int
	if err := s.DB.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='paper_items'`).Scan(&exists); err != nil {
		return err
	}
	if exists != 0 {
		return nil
	}
	snapshot := filepath.Join(s.Root, "reader.pre-paper-items.sqlite")
	if info, err := os.Stat(snapshot); os.IsNotExist(err) {
		if _, err = s.DB.Exec(`VACUUM INTO ?`, snapshot); err != nil {
			return fmt.Errorf("文献迁移快照: %w", err)
		}
	} else if err != nil {
		return err
	} else if !info.Mode().IsRegular() {
		return fmt.Errorf("文献迁移快照不是普通文件")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`
 CREATE TABLE paper_items(id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',metadata TEXT NOT NULL DEFAULT '{}',tags TEXT NOT NULL DEFAULT '[]',folders TEXT NOT NULL DEFAULT '[]',favorite INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,deleted_at TEXT NOT NULL DEFAULT '',primary_document_id TEXT NOT NULL DEFAULT '',citation_key TEXT NOT NULL DEFAULT '');
 CREATE UNIQUE INDEX paper_items_key ON paper_items(citation_key COLLATE NOCASE) WHERE citation_key!='';
 CREATE TABLE paper_attachments(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,paper_id TEXT NOT NULL REFERENCES paper_items(id) ON DELETE CASCADE,role TEXT NOT NULL DEFAULT 'original' CHECK(role IN ('original','translation','supplement','other')));
 CREATE INDEX paper_attachments_item ON paper_attachments(paper_id);
 CREATE TABLE paper_detached_documents(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,paper_id TEXT NOT NULL REFERENCES paper_items(id) ON DELETE CASCADE);
 CREATE TABLE paper_redirects(id TEXT PRIMARY KEY,target_id TEXT NOT NULL REFERENCES paper_items(id) ON DELETE CASCADE);
 CREATE TABLE paper_citation_keys(key TEXT PRIMARY KEY COLLATE NOCASE,paper_id TEXT NOT NULL);
 INSERT INTO paper_items(id,title,author,metadata,tags,folders,favorite,created_at,deleted_at,primary_document_id) SELECT 'paper_'||id,title,author,metadata,tags,folders,favorite,created_at,deleted_at,id FROM documents WHERE library='papers';
 INSERT INTO paper_attachments(document_id,paper_id) SELECT id,'paper_'||id FROM documents WHERE library='papers';
 CREATE TRIGGER paper_document_insert AFTER INSERT ON documents WHEN new.library='papers' BEGIN
 INSERT INTO paper_items(id,title,author,metadata,tags,folders,favorite,created_at,deleted_at,primary_document_id) VALUES('paper_'||new.id||'_'||lower(hex(randomblob(8))),new.title,new.author,new.metadata,new.tags,new.folders,new.favorite,new.created_at,new.deleted_at,new.id);
 INSERT INTO paper_attachments(document_id,paper_id) SELECT new.id,id FROM paper_items WHERE primary_document_id=new.id;
 END;
 CREATE TRIGGER paper_document_library AFTER UPDATE OF library ON documents WHEN new.library!=old.library BEGIN
 INSERT OR REPLACE INTO paper_detached_documents(document_id,paper_id) SELECT new.id,paper_id FROM paper_attachments WHERE document_id=new.id AND new.library!='papers';
 UPDATE paper_items SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE new.library!='papers' AND id=(SELECT paper_id FROM paper_attachments WHERE document_id=new.id) AND (SELECT count(*) FROM paper_attachments WHERE paper_id=paper_items.id)=1;
 DELETE FROM paper_attachments WHERE document_id=new.id AND new.library!='papers';
 INSERT INTO paper_attachments(document_id,paper_id) SELECT new.id,paper_id FROM paper_detached_documents WHERE document_id=new.id AND new.library='papers' AND NOT EXISTS(SELECT 1 FROM paper_attachments WHERE document_id=new.id);
 UPDATE paper_items SET deleted_at=new.deleted_at,primary_document_id=CASE WHEN primary_document_id='' THEN new.id ELSE primary_document_id END WHERE new.library='papers' AND id=(SELECT paper_id FROM paper_attachments WHERE document_id=new.id);
 INSERT INTO paper_items(id,title,author,metadata,tags,folders,favorite,created_at,deleted_at,primary_document_id) SELECT 'paper_'||new.id||'_'||lower(hex(randomblob(8))),new.title,new.author,new.metadata,new.tags,new.folders,new.favorite,new.created_at,new.deleted_at,new.id WHERE new.library='papers' AND NOT EXISTS(SELECT 1 FROM paper_attachments WHERE document_id=new.id);
 INSERT INTO paper_attachments(document_id,paper_id) SELECT new.id,id FROM paper_items WHERE primary_document_id=new.id AND new.library='papers' AND NOT EXISTS(SELECT 1 FROM paper_attachments WHERE document_id=new.id);
 UPDATE paper_items SET title=new.title,author=new.author,metadata=new.metadata,tags=new.tags,folders=new.folders,favorite=new.favorite WHERE new.library='papers' AND EXISTS(SELECT 1 FROM paper_detached_documents WHERE document_id=new.id) AND id=(SELECT paper_id FROM paper_attachments WHERE document_id=new.id);
 DELETE FROM paper_detached_documents WHERE document_id=new.id AND new.library='papers';
 END;
 CREATE TRIGGER paper_attachment_removed AFTER DELETE ON paper_attachments BEGIN
 UPDATE paper_items SET primary_document_id=COALESCE((SELECT document_id FROM paper_attachments WHERE paper_id=old.paper_id ORDER BY document_id LIMIT 1),'') WHERE id=old.paper_id AND primary_document_id=old.document_id;
 END;
 CREATE TRIGGER paper_document_deleted AFTER UPDATE OF deleted_at ON documents WHEN old.deleted_at!=new.deleted_at BEGIN
 UPDATE paper_items SET deleted_at=CASE WHEN EXISTS(SELECT 1 FROM paper_attachments a JOIN documents d ON d.id=a.document_id WHERE a.paper_id=paper_items.id AND d.deleted_at='') THEN '' ELSE new.deleted_at END WHERE id=(SELECT paper_id FROM paper_attachments WHERE document_id=new.id);
 END;
 `)
	if err != nil {
		return err
	}
	// Per-column triggers avoid clobbering a sibling attachment's newer data.
	for _, column := range []string{"title", "author", "metadata", "tags", "folders", "favorite"} {
		_, err = tx.Exec(fmt.Sprintf(`CREATE TRIGGER paper_document_%[1]s AFTER UPDATE OF %[1]s ON documents WHEN new.%[1]s IS NOT old.%[1]s BEGIN UPDATE paper_items SET %[1]s=new.%[1]s WHERE id=(SELECT paper_id FROM paper_attachments WHERE document_id=new.id) AND %[1]s IS NOT new.%[1]s; END;
 CREATE TRIGGER paper_item_%[1]s AFTER UPDATE OF %[1]s ON paper_items WHEN new.%[1]s IS NOT old.%[1]s BEGIN UPDATE documents SET %[1]s=new.%[1]s WHERE id IN (SELECT document_id FROM paper_attachments WHERE paper_id=new.id) AND %[1]s IS NOT new.%[1]s; END;`, column))
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Use the owning item's values whenever joining an attachment. Compatibility
// document columns remain available to legacy conditional SQL updates.
func syncPaperAttachments(tx *sql.Tx, paperID string) error {
	_, err := tx.Exec(`UPDATE documents SET title=p.title,author=p.author,metadata=p.metadata,tags=p.tags,folders=p.folders,favorite=p.favorite FROM paper_items p WHERE p.id=? AND documents.id IN(SELECT document_id FROM paper_attachments WHERE paper_id=p.id)`, paperID)
	return err
}
