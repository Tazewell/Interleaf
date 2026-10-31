package interleaf

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/url"
	"strings"

	"interleaf.local/server/internal/scholar"
)

// Export never prepares a parser, fetches a resource, or repairs a cache.
// A source that cannot be verified from existing records stays historical.
func (s *Server) researchMarkdown(ctx context.Context, r ResearchReport) string {
	text := researchMarkdown(r)
	scope, scopeErr := readResearchRunScope(ctx, s.Store.DB, r.SourceRunID)
	var appendix strings.Builder
	seen := map[string]bool{}
	for _, sid := range r.SourceIDs {
		if !researchRequestID.MatchString(sid) || seen[sid] {
			continue
		}
		seen[sid] = true
		anchor := "source-" + sid
		text = strings.ReplaceAll(text, "\\["+sid+"]", "["+sid+"](#"+anchor+")")
		fmt.Fprintf(&appendix, "\n### %s\n\n", anchor)
		var raw, availability, paperID, runID, topicID string
		err := s.Store.DB.QueryRowContext(ctx, `SELECT body,availability,paper_id,run_id,topic_id FROM research_evidence WHERE id=?`, sid).Scan(&raw, &availability, &paperID, &runID, &topicID)
		if err != nil || scopeErr != nil || runID != r.SourceRunID || topicID != r.TopicID {
			appendix.WriteString("来源已失效或删除，保留历史引用。\n")
			continue
		}
		var ev ResearchEvidence
		if json.Unmarshal([]byte(raw), &ev) != nil || ev.ID != sid || ev.RunID != runID || ev.TopicID != topicID || ev.SnapshotID != scope.Snapshot.ID || ev.PaperID != paperID {
			appendix.WriteString("来源已失效或删除，保留历史引用。\n")
			continue
		}
		valid := availability == "valid" && ev.Availability == "valid" && (ev.Kind == "local-page" || sourceKey(ev.Excerpt) == ev.ContentHash)
		if ev.CandidateID == "" {
			m, e := scope.member(paperID)
			if e == nil {
				fmt.Fprintf(&appendix, "%s；引用键：%s\n\n", researchExportText(m.Title), researchExportText(m.CitationKey))
				p, e := s.Store.PaperItem(paperID)
				valid = valid && e == nil && researchPaperMatches(p, m)
				if m.DocumentID != "" {
					d, e := s.Store.Document(m.DocumentID)
					valid = valid && e == nil && d.DeletedAt == "" && d.PaperID == paperID && ev.DocumentID == d.ID
					if valid {
						hash, e := researchFileHash(ctx, s.Store.File(d))
						valid = e == nil && hash == m.SourceHash
					}
					var revision string
					e = s.Store.DB.QueryRowContext(ctx, `SELECT revision FROM document_corpora WHERE document_id=?`, m.DocumentID).Scan(&revision)
					valid = valid && e == nil && revision == m.CorpusRevision && ev.Revision == revision
					if valid && ev.Kind == "local-page" {
						var pos struct{ Page int }
						_ = json.Unmarshal(ev.Location, &pos)
						_, image, e := s.cachedPageImage(m.DocumentID, m.CorpusRevision, pos.Page)
						valid = e == nil && image.Hash == ev.ContentHash
					}
				} else {
					valid = valid && ev.Revision == m.SourceHash
				}
			} else {
				valid = false
			}
		} else {
			c, version, e := readResearchRegisteredCandidate(ctx, s.Store.DB, scope, ev.CandidateID)
			valid = valid && e == nil
			if valid && ev.Kind == "local-passage" {
				cache, e := readCandidateLocalCache(ctx, s.Store.DB, scope, c, version)
				valid = e == nil
				if valid {
					tx, e := s.Store.DB.BeginTx(ctx, nil)
					if e != nil {
						valid = false
					} else {
						valid = validateCandidateLocalEvidence(ctx, tx, scope, ev) == nil
						_ = tx.Rollback()
					}
					d, e := s.Store.Document(cache.Member.DocumentID)
					valid = valid && e == nil
					if valid {
						hash, e := researchFileHash(ctx, s.Store.File(d))
						valid = e == nil && hash == cache.Member.SourceHash
					}
					if valid {
						fmt.Fprintf(&appendix, "引用键：%s\n\n", researchExportText(cache.Member.CitationKey))
					}
				}
			} else {
				valid = valid && validateResearchRemoteEvidence(ctx, s.Store.DB, scope, ev) == nil
			}
			if valid {
				fmt.Fprintf(&appendix, "%s；DOI：%s\n\n", researchExportText(c.Title), researchExportText(c.DOI))
			}
		}
		if !valid {
			appendix.WriteString("来源已失效或删除，保留历史引用；不作为当前可核验证据。\n")
			continue
		}
		var loc struct {
			Type, Href, URL, FetchedAt, ResourceHash, ContentLevel string
			Page, Paragraph                                        int
			Progression                                            float64
			BlockID                                                string
		}
		_ = json.Unmarshal(ev.Location, &loc)
		switch loc.Type {
		case "pdf":
			fmt.Fprintf(&appendix, "PDF 第 %d 页；块：%s\n\n", loc.Page, researchExportText(loc.BlockID))
		case "epub":
			fmt.Fprintf(&appendix, "EPUB 章节：%s；进度：%.3f；块：%s\n\n", researchExportText(loc.Href), loc.Progression, researchExportText(loc.BlockID))
		case "html":
			fmt.Fprintf(&appendix, "网页第 %d 段；内容等级：%s\n\n", loc.Paragraph, researchExportText(loc.ContentLevel))
		case "abstract":
			appendix.WriteString("摘要证据\n\n")
		}
		if safe := scholar.PublicDisplayURL(loc.URL); safe != "" {
			// The URL belongs to a verified public-fetch cache. Encode parentheses so
			// untrusted path bytes cannot escape a Markdown link destination.
			parsed, e := url.Parse(safe)
			if e == nil {
				safe = parsed.String()
				safe = strings.NewReplacer("(", "%28", ")", "%29", "<", "%3C", ">", "%3E").Replace(safe)
				fmt.Fprintf(&appendix, "[公开来源](%s)\n\n", safe)
			}
		}
		fmt.Fprintf(&appendix, "读取时间：%s；获取时间：%s；resourceHash：%s；证据版本：%s\n\n摘录：%s\n", researchExportText(ev.ReadAt), researchExportText(loc.FetchedAt), researchExportText(loc.ResourceHash), researchExportText(ev.Revision), researchExportText(ev.Excerpt))
	}
	if appendix.Len() > 0 {
		text += "\n## 来源\n" + appendix.String()
	}
	return text
}

func researchExportText(text string) string {
	return strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "!", "\\!", "`", "\\`", "#", "\\#", "*", "\\*", "_", "\\_", "\n", " ", "\r", " ").Replace(html.EscapeString(text))
}
