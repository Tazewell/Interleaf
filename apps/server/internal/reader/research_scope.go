package reader

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

var errResearchScopeChanged = errors.New("研究范围或原文已变更，请重试")

type researchScopePaper struct {
	Paper     PaperItem
	Documents []Document
}

// Both enumeration passes use one consistent SQLite transaction. Parsing and
// hashing happen outside it: corpus preparation itself needs the sole DB connection.
func readResearchScope(tx *sql.Tx, topicID string) (ResearchTopic, []researchScopePaper, error) {
	topic, err := readResearchTopic(tx, topicID)
	if err != nil {
		return topic, nil, err
	}
	if topic.ScopeState != "active" {
		return topic, nil, paperConflict("研究分类已解除绑定，请重新选择分类")
	}
	rows, err := tx.Query(`SELECT id FROM paper_items WHERE deleted_at='' ORDER BY id`)
	if err != nil {
		return topic, nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return topic, nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return topic, nil, err
	}
	out := []researchScopePaper{}
	for _, id := range ids {
		p, err := readPaper(tx, id)
		if err != nil {
			return topic, nil, err
		}
		match := false
		for _, folder := range p.Folders {
			rest, hit := tagSuffix(folder, topic.Folder)
			match = match || (hit && (topic.IncludeChildren || rest == ""))
		}
		if !match {
			continue
		}
		item := researchScopePaper{Paper: p, Documents: []Document{}}
		for _, a := range p.Attachments {
			var d Document
			err := tx.QueryRow(`SELECT id,type,library,deleted_at FROM documents WHERE id=?`, a.DocumentID).Scan(&d.ID, &d.Type, &d.Library, &d.DeletedAt)
			if err != nil {
				return topic, nil, err
			}
			item.Documents = append(item.Documents, d)
		}
		out = append(out, item)
	}
	return topic, out, nil
}

// Incremental hashing is cancellable and bounded in memory, even for large PDFs.
func researchFileHash(ctx context.Context, path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("原文不是普通文件")
	}
	hash, err := researchHashReader(ctx, f)
	if err != nil {
		return "", err
	}
	after, err := f.Stat()
	if err != nil {
		return "", err
	}
	if info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return "", errResearchScopeChanged
	}
	return hash, nil
}

func researchHashReader(ctx context.Context, reader io.Reader) (string, error) {
	h := sha256.New()
	buf := make([]byte, 128<<10)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, err := reader.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Parser provenance must bind to these exact original bytes. Legacy PDF layouts
// without inputSHA256 are usable in the reader but cannot substantiate research.
// EPUBs are re-prepared into an owned scratch directory and compared with the
// sanitized resources actually used by the navigator/corpus; originals stay intact.
func (s *Server) researchParserSource(ctx context.Context, d Document, hash string) error {
	if d.Type == "pdf" {
		raw, err := os.ReadFile(filepath.Join(s.analysisDir(d.ID), "manifest.json"))
		if err != nil {
			return errors.New("原文尚未完成可验证解析")
		}
		var m struct {
			InputSHA256 string `json:"inputSHA256"`
		}
		if json.Unmarshal(raw, &m) != nil || m.InputSHA256 == "" || m.InputSHA256 != hash {
			return errors.New("解析与原文版本不一致或缺少来源校验，请重新解析")
		}
		return nil
	}
	work, err := os.MkdirTemp(filepath.Join(s.Store.Root, "ai-work"), "research-epub-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	if _, _, err = prepareEPUB(ctx, s.Store.File(d), work); err != nil {
		return errors.New("EPUB 原件无法读取")
	}
	cached := filepath.Join(s.Store.Root, "cache", d.ID)
	raw, err := os.ReadFile(filepath.Join(work, "manifest.json"))
	if err != nil {
		return err
	}
	var manifest epubReaderManifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		return err
	}
	current, err := os.ReadFile(filepath.Join(cached, "manifest.json"))
	if err != nil {
		return errors.New("EPUB 原文尚未解析")
	}
	var expected, actual any
	if json.Unmarshal(raw, &expected) != nil || json.Unmarshal(current, &actual) != nil || !reflect.DeepEqual(expected, actual) {
		return errors.New("EPUB 解析与原文版本不一致，请重新导入原件")
	}
	for _, link := range manifest.ReadingOrder {
		name, err := safeResource(link.Href)
		if err != nil {
			return err
		}
		a, err := researchFileHash(ctx, filepath.Join(work, filepath.FromSlash(name)))
		if err != nil {
			return err
		}
		b, err := researchFileHash(ctx, filepath.Join(cached, filepath.FromSlash(name)))
		if err != nil || a != b {
			return errors.New("EPUB 章节与原件不一致，请重新导入原件")
		}
	}
	return nil
}

type researchPreparedDocument struct {
	Document                            Document
	Hash, Revision, Reason, Fingerprint string
	Context                             context.Context
	SourceInfo                          os.FileInfo
	ParserGeneration                    uint64
}

func (s *Server) snapshotResearchScope(ctx context.Context, topicID string) (ResearchSnapshot, error) {
	snap := ResearchSnapshot{ID: id(), TopicID: topicID, Members: []ResearchMember{}, CreatedAt: now()}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return snap, err
	}
	topic, items, err := readResearchScope(tx, topicID)
	tx.Rollback()
	if err != nil {
		return snap, err
	}
	prepared := map[string]researchPreparedDocument{}
	finishes := []func(){}
	defer func() {
		for _, finish := range finishes {
			finish()
		}
	}()
	for _, item := range items {
		for i, a := range item.Paper.Attachments {
			d := item.Documents[i]
			if a.Role != "original" || d.DeletedAt != "" || d.Library != "papers" || (d.Type != "pdf" && d.Type != "epub") {
				continue
			}
			taskCtx, finish, e := s.beginDocumentTask(ctx, d.ID)
			if e != nil {
				return snap, e
			}
			finishes = append(finishes, finish)
			p := researchPreparedDocument{Document: d, Context: taskCtx, ParserGeneration: s.parserGeneration(d.ID)}
			p.Hash, e = researchFileHash(taskCtx, s.Store.File(d))
			if e == nil {
				e = s.researchParserSource(taskCtx, d, p.Hash)
			}
			if e == nil {
				var c *documentCorpus
				c, e = s.prepareDocumentCorpus(taskCtx, d.ID, nil, false)
				if e == nil {
					if len(c.Passages) == 0 {
						e = errors.New("原文暂无可读取文字")
					} else {
						p.Revision = c.Revision
						p.Fingerprint = c.Fingerprint
					}
				}
			}
			if taskCtx.Err() != nil {
				return snap, taskCtx.Err()
			}
			if e != nil {
				p.Reason = "原文不可读取或无法验证解析来源"
				if p.Hash != "" {
					p.Reason = e.Error()
				}
			}
			prepared[d.ID] = p
		}
	}
	// Rehash before taking the write transaction, so file I/O cannot monopolize
	// the single connection. App mutations are then checked in that transaction.
	for id, p := range prepared {
		if p.Context.Err() != nil {
			return snap, p.Context.Err()
		}
		hash, e := researchFileHash(p.Context, s.Store.File(p.Document))
		if (e == nil && hash != p.Hash) || (e != nil && p.Hash != "") {
			return snap, errResearchScopeChanged
		}
		p.SourceInfo, e = os.Stat(s.Store.File(p.Document))
		if e != nil && !os.IsNotExist(e) {
			return snap, e
		}
		if p.Revision != "" {
			if e = s.researchParserSource(p.Context, p.Document, p.Hash); e != nil {
				return snap, errResearchScopeChanged
			}
			fingerprint, e := s.corpusFingerprintContext(p.Context, p.Document)
			if e != nil || fingerprint != p.Fingerprint {
				return snap, errResearchScopeChanged
			}
		}
		prepared[id] = p
	}
	return s.commitResearchScope(ctx, snap, topic, items, prepared)
}

// Commit the prepared scope without repeating expensive original reads inside
// SQLite's sole connection. All prepared identities are checked here.
func (s *Server) commitResearchScope(ctx context.Context, snap ResearchSnapshot, topic ResearchTopic, items []researchScopePaper, prepared map[string]researchPreparedDocument) (ResearchSnapshot, error) {
	s.parserPublicationMu.RLock()
	defer s.parserPublicationMu.RUnlock()
	for _, p := range prepared {
		if s.parserGenerations[p.Document.ID] != p.ParserGeneration {
			return snap, errResearchScopeChanged
		}
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return snap, err
	}
	defer tx.Rollback()
	current, currentItems, err := readResearchScope(tx, topic.ID)
	if err != nil {
		return snap, err
	}
	if current.Folder != topic.Folder || current.IncludeChildren != topic.IncludeChildren || !reflect.DeepEqual(items, currentItems) {
		return snap, errResearchScopeChanged
	}
	// A cheap final file-identity/version check closes app-managed replacement
	// races without holding the sole SQLite connection while hashing large files.
	for _, p := range prepared {
		if p.Revision != "" {
			var revision, fingerprint string
			e := tx.QueryRowContext(ctx, `SELECT revision,fingerprint FROM document_corpora WHERE document_id=?`, p.Document.ID).Scan(&revision, &fingerprint)
			if e != nil || revision != p.Revision || fingerprint != p.Fingerprint {
				return snap, errResearchScopeChanged
			}
		}
		info, e := os.Stat(s.Store.File(p.Document))
		if p.SourceInfo == nil {
			if !os.IsNotExist(e) {
				return snap, errResearchScopeChanged
			}
		} else if e != nil || !os.SameFile(p.SourceInfo, info) || info.Size() != p.SourceInfo.Size() || !info.ModTime().Equal(p.SourceInfo.ModTime()) {
			return snap, errResearchScopeChanged
		}
	}
	identities := []any{}
	for _, item := range items {
		p := item.Paper
		m := ResearchMember{PaperID: p.ID, Title: p.Title, CitationKey: p.CitationKey, Coverage: "metadata"}
		if strings.TrimSpace(p.Metadata.Abstract) != "" {
			m.Coverage = "abstract"
		}
		candidates := []researchPreparedDocument{}
		var primary *researchPreparedDocument
		originals := 0
		versions := []string{}
		for _, a := range p.Attachments {
			if a.Role != "original" {
				continue
			}
			originals++
			if doc, ok := prepared[a.DocumentID]; ok {
				if doc.Context.Err() != nil {
					return snap, doc.Context.Err()
				}
				versions = append(versions, a.DocumentID+":"+doc.Hash)
				if doc.Revision != "" {
					candidates = append(candidates, doc)
					if a.DocumentID == p.PrimaryDocumentID {
						v := doc
						primary = &v
					}
				}
			}
		}
		var chosen *researchPreparedDocument
		if primary != nil {
			chosen = primary
		} else if len(candidates) == 1 {
			chosen = &candidates[0]
		}
		if chosen != nil {
			m.DocumentID = chosen.Document.ID
			m.SourceHash = chosen.Hash
			m.CorpusRevision = chosen.Revision
			m.Coverage = "fulltext"
			versions = nil
		} else if len(p.Attachments) > 0 {
			m.Coverage = "unavailable"
			m.Reason = "没有可读取且来源可验证的原文附件"
			if len(candidates) > 1 {
				m.Reason = "存在多个可读原文，请明确选择原文主附件"
			}
			if originals == 1 {
				for _, a := range p.Attachments {
					if a.Role == "original" {
						m.DocumentID = a.DocumentID
						if v, ok := prepared[a.DocumentID]; ok {
							m.SourceHash = v.Hash
							if v.Reason != "" {
								m.Reason = v.Reason
							}
						}
					}
				}
			}
		}
		snap.Members = append(snap.Members, m)
		identities = append(identities, struct {
			Member   ResearchMember
			Author   string
			Metadata PaperMetadata
			Versions []string
		}{m, p.Author, p.Metadata, versions})
	}
	raw, err := json.Marshal(struct {
		Protocol string
		Members  []any
	}{"research-scope-v1:" + corpusVersion, identities})
	if err != nil {
		return snap, err
	}
	snap.Revision = sourceKey(string(raw))
	raw, err = json.Marshal(snap)
	if err != nil {
		return snap, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO research_snapshots(id,topic_id,revision,body,created_at,updated_at) VALUES(?,?,?,?,?,?)`, snap.ID, snap.TopicID, snap.Revision, string(raw), snap.CreatedAt, snap.CreatedAt); err != nil {
		return snap, err
	}
	if err = ctx.Err(); err != nil {
		return snap, err
	}
	for _, p := range prepared {
		if err = p.Context.Err(); err != nil {
			return snap, err
		}
	}
	if err = tx.Commit(); err != nil {
		return snap, fmt.Errorf("保存研究范围: %w", err)
	}
	return snap, nil
}
