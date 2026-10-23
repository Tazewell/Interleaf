package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"reader.local/server/internal/scholar"
)

// A registered online candidate can point to an original already in another
// local folder. Its native evidence remains local-passage with a candidate ID;
// it never becomes a member of the folder snapshot or its coverage totals.
type researchCandidateLocalCache struct {
	Version  string
	Member   ResearchMember
	Evidence []ResearchEvidence
}

func candidateLocalKey(candidate, version string) string {
	return "candidate-local:" + candidate + ":" + version
}
func candidatePaperIdentity(c ResearchCandidate, p PaperItem) bool {
	if c.PaperID != "" && c.PaperID != p.ID {
		return false
	}
	return c.DOI != "" && strings.EqualFold(strings.TrimSpace(c.DOI), strings.TrimSpace(p.Metadata.DOI)) || scholar.SameArXiv(c.ArXiv, p.Metadata.ArXiv)
}
func readCandidateLocalCache(ctx context.Context, q researchRowQuery, scope researchScope, c ResearchCandidate, version string) (researchCandidateLocalCache, error) {
	var cache researchCandidateLocalCache
	u, err := readResearchUnit(ctx, q, scope.Run.ID, candidateLocalKey(c.ID, version))
	if err != nil {
		return cache, err
	}
	if u.Kind != "candidate-local" || u.Status != "complete" || u.ContentHash != sourceKey(string(u.Result)) || json.Unmarshal(u.Result, &cache) != nil || cache.Version != version || cache.Member.PaperID == "" || cache.Member.DocumentID == "" || cache.Member.Coverage != "fulltext" {
		return cache, errResearchScopeChanged
	}
	return cache, nil
}
func validateCandidateLocalEvidence(ctx context.Context, tx *sql.Tx, scope researchScope, ev ResearchEvidence) error {
	c, version, err := readResearchRegisteredCandidate(ctx, tx, scope, ev.CandidateID)
	if err != nil {
		return err
	}
	cache, err := readCandidateLocalCache(ctx, tx, scope, c, version)
	if err != nil {
		return err
	}
	p, err := readPaper(tx, ev.PaperID)
	if err != nil || !candidatePaperIdentity(c, p) || !researchPaperMatches(p, cache.Member) {
		return errResearchScopeChanged
	}
	if ev.RunID != scope.Run.ID || ev.TopicID != scope.Run.TopicID || ev.SnapshotID != scope.Snapshot.ID || ev.Kind != "local-passage" || ev.PaperID != cache.Member.PaperID || ev.DocumentID != cache.Member.DocumentID || ev.Revision != cache.Member.CorpusRevision || ev.Availability != "valid" || ev.ContentHash != sourceKey(ev.Excerpt) {
		return errResearchScopeChanged
	}
	var revision, paperID, deleted string
	if err = tx.QueryRowContext(ctx, `SELECT c.revision,a.paper_id,d.deleted_at FROM document_corpora c JOIN documents d ON d.id=c.document_id JOIN paper_attachments a ON a.document_id=d.id AND a.role='original' WHERE d.id=?`, ev.DocumentID).Scan(&revision, &paperID, &deleted); err != nil || revision != ev.Revision || paperID != p.ID || deleted != "" {
		return errResearchScopeChanged
	}
	for _, original := range cache.Evidence {
		if jsonText(original) == jsonText(ev) {
			return nil
		}
	}
	return errResearchScopeChanged
}
func (s *Server) resolveCandidateLocalSource(ctx context.Context, scope researchScope, ev ResearchEvidence) (ResearchEvidence, error) {
	c, version, err := readResearchRegisteredCandidate(ctx, s.Store.DB, scope, ev.CandidateID)
	if err != nil {
		return ResearchEvidence{}, err
	}
	cache, err := readCandidateLocalCache(ctx, s.Store.DB, scope, c, version)
	if err != nil {
		return ResearchEvidence{}, err
	}
	ctx, finish, err := s.beginResearchPaperTask(ctx, ev.PaperID)
	if err != nil {
		return ResearchEvidence{}, err
	}
	defer finish()
	st, err := s.prepareResearchRead(ctx, cache.Member)
	if err != nil {
		return ResearchEvidence{}, err
	}
	defer st.Finish()
	copyEvidence := ev
	copyEvidence.CandidateID = "" // payload validation uses the same native local parser, not the snapshot membership gate.
	if !researchEvidenceMatches(copyEvidence, scope, st) {
		return ResearchEvidence{}, errResearchScopeChanged
	}
	err = s.commitResearchRead(ctx, scope, []*researchReadState{st}, false, func(tx *sql.Tx) error {
		current, e := readResearchEvidence(ctx, tx, ev.ID)
		if e != nil || jsonText(current) != jsonText(ev) {
			return errResearchScopeChanged
		}
		return validateCandidateLocalEvidence(ctx, tx, scope, ev)
	})
	if err != nil {
		return ResearchEvidence{}, err
	}
	return ev, nil
}
func (s *Server) readCandidateLocalOriginal(ctx context.Context, scope researchScope, c ResearchCandidate, p PaperItem) ([]ResearchEvidence, error) {
	_, version, err := readResearchRegisteredCandidate(ctx, s.Store.DB, scope, c.ID)
	if err != nil {
		return nil, err
	}
	if !candidatePaperIdentity(c, p) || p.DeletedAt != "" {
		return nil, errResearchScopeChanged
	}
	ctx, finish, err := s.beginResearchPaperTask(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	defer finish()
	if cache, e := readCandidateLocalCache(ctx, s.Store.DB, scope, c, version); e == nil {
		for _, ev := range cache.Evidence {
			if _, err = s.resolveCandidateLocalSource(ctx, scope, ev); err != nil {
				return nil, err
			}
		}
		return cache.Evidence, nil
	} else if !errors.Is(e, sql.ErrNoRows) {
		return nil, e
	}
	docID := c.DocumentID
	if docID == "" {
		for _, a := range p.Attachments {
			if a.Role == "original" && (docID == "" || a.DocumentID == p.PrimaryDocumentID) {
				docID = a.DocumentID
			}
		}
	}
	if docID == "" {
		return nil, errResearchScopeChanged
	}
	docCtx, finishDoc, err := s.beginDocumentTask(ctx, docID)
	if err != nil {
		return nil, err
	}
	defer finishDoc()
	d, err := s.Store.Document(docID)
	if err != nil || d.PaperID != p.ID || d.DeletedAt != "" {
		return nil, errResearchScopeChanged
	}
	hash, err := researchFileHash(docCtx, s.Store.File(d))
	if err != nil {
		return nil, err
	}
	if err = s.researchParserSource(docCtx, d, hash); err != nil {
		return nil, err
	}
	corpus, err := s.prepareDocumentCorpus(docCtx, docID, nil, false)
	if err != nil {
		return nil, err
	}
	member := ResearchMember{PaperID: p.ID, DocumentID: docID, Title: p.Title, CitationKey: p.CitationKey, SourceHash: hash, CorpusRevision: corpus.Revision, Coverage: "fulltext"}
	if frozen, e := scope.member(p.ID); e == nil {
		if frozen.DocumentID != docID {
			return nil, errResearchScopeChanged
		}
		member = frozen
	}
	st, err := s.prepareResearchRead(docCtx, member)
	if err != nil {
		return nil, err
	}
	defer st.Finish()
	cache := researchCandidateLocalCache{Version: version, Member: member, Evidence: []ResearchEvidence{}}
	for _, passage := range researchPassages(st) {
		ev := researchPassageEvidence(scope, member, passage)
		ev.CandidateID = c.ID
		cache.Evidence = append(cache.Evidence, ev)
	}
	if len(cache.Evidence) == 0 {
		return nil, errResearchScopeChanged
	}
	payload := json.RawMessage(jsonText(cache))
	if len(payload) > 32<<20 {
		return nil, generationError(ErrorLimit, "候选本地证据超过缓存限制")
	}
	err = s.commitResearchRead(ctx, scope, []*researchReadState{st}, true, func(tx *sql.Tx) error {
		_, v, e := readResearchRegisteredCandidate(ctx, tx, scope, c.ID)
		if e != nil || v != version {
			return errResearchScopeChanged
		}
		if prior, e := readCandidateLocalCache(ctx, tx, scope, c, version); e == nil {
			if prior.Member.SourceHash != member.SourceHash || prior.Member.CorpusRevision != member.CorpusRevision {
				return errResearchScopeChanged
			}
			cache = prior
			return nil
		} else if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		if e = writeResearchUnit(ctx, tx, ResearchUnit{RunID: scope.Run.ID, UnitKey: candidateLocalKey(c.ID, version), Kind: "candidate-local", Status: "complete", ContentHash: sourceKey(string(payload)), Result: payload}); e != nil {
			return e
		}
		for _, ev := range cache.Evidence {
			if e = writeResearchEvidence(ctx, tx, ev); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return cache.Evidence, nil
}
