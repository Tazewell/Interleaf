package interleaf

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

// The opaque evidence ID is global. A block ID is only meaningful within this
// paper/document/revision and is never accepted as a source reference.
type researchScope struct {
	Run      ResearchRun
	Snapshot ResearchSnapshot
}
type researchRowQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readResearchRunScope(ctx context.Context, q researchRowQuery, runID string) (researchScope, error) {
	var scope researchScope
	var runRaw, snapRaw, topic, session, message, status, snapTopic, revision string
	err := q.QueryRowContext(ctx, `SELECT r.body,r.topic_id,r.session_id,r.user_message_id,r.status,n.body,n.topic_id,n.revision FROM research_runs r JOIN research_sessions s ON s.id=r.session_id AND s.topic_id=r.topic_id JOIN research_snapshots n ON n.id=json_extract(r.body,'$.snapshotId') AND n.topic_id=r.topic_id WHERE r.id=?`, runID).Scan(&runRaw, &topic, &session, &message, &status, &snapRaw, &snapTopic, &revision)
	if err != nil {
		return scope, err
	}
	if json.Unmarshal([]byte(runRaw), &scope.Run) != nil || json.Unmarshal([]byte(snapRaw), &scope.Snapshot) != nil {
		return scope, errResearchScopeChanged
	}
	r, n := scope.Run, scope.Snapshot
	if r.ID != runID || r.TopicID != topic || r.SessionID != session || r.UserMessageID != message || r.Status != status || n.ID != r.SnapshotID || n.TopicID != snapTopic || n.Revision != revision || r.Revision != n.Revision {
		return scope, errResearchScopeChanged
	}
	return scope, nil
}
func (r researchScope) member(paperID string) (ResearchMember, error) {
	for _, m := range r.Snapshot.Members {
		if m.PaperID == paperID {
			return m, nil
		}
	}
	return ResearchMember{}, fmt.Errorf("论文不在本次研究快照中")
}
func researchMetadataHash(p PaperItem) string {
	return sourceKey("research-metadata-v1\n" + jsonText(struct {
		Title, Author, CitationKey string
		Metadata                   PaperMetadata
	}{p.Title, p.Author, p.CitationKey, p.Metadata}))
}

type researchReadState struct {
	Member      ResearchMember
	Paper       PaperItem
	Document    Document
	Corpus      *documentCorpus
	Generation  uint64
	Info        os.FileInfo
	Context     context.Context
	Finish      func()
	TotalUnits  int
	NativeUnits map[string]int
}

func researchPaperMatches(p PaperItem, m ResearchMember) bool {
	if p.ID != m.PaperID || p.DeletedAt != "" || p.Title != m.Title || p.CitationKey != m.CitationKey {
		return false
	}
	if m.Coverage == "metadata" || m.Coverage == "abstract" {
		return m.SourceHash != "" && m.SourceHash == researchMetadataHash(p)
	}
	if m.Coverage != "fulltext" {
		return false
	}
	found := false
	for _, a := range p.Attachments {
		if a.Role == "original" && a.DocumentID == m.DocumentID {
			found = true
		}
		if a.Role == "original" && p.PrimaryDocumentID == a.DocumentID && a.DocumentID != m.DocumentID {
			return false
		}
	}
	return found
}
func (s *Server) prepareResearchRead(ctx context.Context, m ResearchMember) (*researchReadState, error) {
	st := &researchReadState{Member: m, Context: ctx, Finish: func() {}}
	var err error
	st.Paper, err = s.Store.PaperItem(m.PaperID)
	if err != nil || !researchPaperMatches(st.Paper, m) {
		return nil, errResearchScopeChanged
	}
	if m.Coverage != "fulltext" {
		return st, nil
	}
	st.Context, st.Finish, err = s.beginDocumentTask(ctx, m.DocumentID)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*researchReadState, error) { st.Finish(); return nil, err }
	st.Generation = s.parserGeneration(m.DocumentID)
	st.Document, err = s.Store.Document(m.DocumentID)
	if err != nil || st.Document.DeletedAt != "" || st.Document.PaperID != m.PaperID {
		return fail(errResearchScopeChanged)
	}
	hash, err := researchFileHash(st.Context, s.Store.File(st.Document))
	if err != nil || hash != m.SourceHash {
		return fail(errResearchScopeChanged)
	}
	if err = s.researchParserSource(st.Context, st.Document, hash); err != nil {
		return fail(errResearchScopeChanged)
	}
	st.Corpus, err = s.prepareDocumentCorpus(st.Context, m.DocumentID, nil, false)
	if err != nil {
		return fail(err)
	}
	if st.Corpus.Revision != m.CorpusRevision {
		return fail(errResearchScopeChanged)
	}
	st.TotalUnits = st.Corpus.Coverage.TotalUnits
	if st.Document.Type == "epub" {
		raw, e := os.ReadFile(filepath.Join(s.Store.Root, "cache", st.Document.ID, "manifest.json"))
		if e != nil {
			return fail(e)
		}
		var manifest epubReaderManifest
		if e = json.Unmarshal(raw, &manifest); e != nil {
			return fail(e)
		}
		st.TotalUnits = len(manifest.ReadingOrder)
		st.NativeUnits = map[string]int{}
		for _, link := range manifest.ReadingOrder {
			st.NativeUnits["epub:"+link.Href]++
		}
	}
	st.Info, err = os.Stat(s.Store.File(st.Document))
	if err != nil {
		return fail(err)
	}
	if st.Generation != s.parserGeneration(m.DocumentID) {
		return fail(errResearchScopeChanged)
	}
	return st, nil
}

// Hash and parser validation happen before this short transaction. Publication
// uses the existing lock order (parser RLock -> DB), matching snapshot commits.
func (s *Server) commitResearchRead(ctx context.Context, scope researchScope, states []*researchReadState, requireRunning bool, write func(*sql.Tx) error) error {
	if _, ok := ctx.Value(researchNetworkKey{}).(*researchNetworkLease); ok {
		s.researchNetworkMu.Lock()
		defer s.researchNetworkMu.Unlock()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.parserPublicationMu.RLock()
	defer s.parserPublicationMu.RUnlock()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = checkResearchNetworkLease(ctx, tx, scope.Run.ID); err != nil {
		return err
	}
	current, err := readResearchRunScope(ctx, tx, scope.Run.ID)
	if err != nil {
		return err
	}
	if current.Run.TopicID != scope.Run.TopicID || current.Run.SessionID != scope.Run.SessionID || current.Snapshot.ID != scope.Snapshot.ID || current.Snapshot.Revision != scope.Snapshot.Revision {
		return errResearchScopeChanged
	}
	if requireRunning && current.Run.Status != "running" {
		return generationError(ErrorCanceled, "研究任务已停止")
	}
	for _, st := range states {
		if err = st.Context.Err(); err != nil {
			return err
		}
		p, e := readPaper(tx, st.Member.PaperID)
		if e != nil || !researchPaperMatches(p, st.Member) {
			return errResearchScopeChanged
		}
		if st.Corpus == nil {
			continue
		}
		if s.parserGenerations[st.Document.ID] != st.Generation {
			return errResearchScopeChanged
		}
		var revision, fingerprint, paperID, deleted string
		if e = tx.QueryRowContext(ctx, `SELECT c.revision,c.fingerprint,a.paper_id,d.deleted_at FROM document_corpora c JOIN documents d ON d.id=c.document_id JOIN paper_attachments a ON a.document_id=d.id AND a.role='original' WHERE d.id=?`, st.Document.ID).Scan(&revision, &fingerprint, &paperID, &deleted); e != nil || revision != st.Corpus.Revision || fingerprint != st.Corpus.Fingerprint || paperID != p.ID || deleted != "" {
			return errResearchScopeChanged
		}
		info, e := os.Stat(s.Store.File(st.Document))
		if e != nil || !os.SameFile(st.Info, info) || info.Size() != st.Info.Size() || !info.ModTime().Equal(st.Info.ModTime()) {
			return errResearchScopeChanged
		}
	}
	if err = write(tx); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return tx.Commit()
}
func researchPassageLocation(p documentPassage) json.RawMessage {
	var loc map[string]any
	_ = json.Unmarshal(p.Location, &loc)
	loc["blockId"] = p.ID
	return json.RawMessage(jsonText(loc))
}
func researchPassageEvidence(scope researchScope, m ResearchMember, p documentPassage) ResearchEvidence {
	revision := m.CorpusRevision
	if revision == "" {
		revision = m.SourceHash
	}
	return ResearchEvidence{ID: id(), TopicID: scope.Run.TopicID, SnapshotID: scope.Snapshot.ID, RunID: scope.Run.ID, PaperID: m.PaperID, DocumentID: m.DocumentID, Kind: "local-passage", Revision: revision, ContentHash: sourceKey(p.Text), Location: researchPassageLocation(p), Excerpt: p.Text, ReadAt: now(), Availability: "valid"}
}
func writeResearchEvidence(ctx context.Context, tx *sql.Tx, ev ResearchEvidence) error {
	scope, ownerErr := readResearchRunScope(ctx, tx, ev.RunID)
	if ownerErr != nil {
		return ownerErr
	}
	if scope.Run.TopicID != ev.TopicID || scope.Snapshot.ID != ev.SnapshotID {
		return errResearchScopeChanged
	}
	if ev.CandidateID != "" && ev.Kind != "local-passage" && ev.Kind != "remote-abstract" && ev.Kind != "remote-html" && ev.Kind != "remote-page" {
		return errResearchScopeChanged
	}
	if strings.HasPrefix(ev.Kind, "remote-") {
		if err := validateResearchRemoteEvidence(ctx, tx, scope, ev); err != nil {
			return err
		}
	}
	if ev.PaperID == "" && (ev.DocumentID != "" || strings.HasPrefix(ev.Kind, "local-")) {
		return errResearchScopeChanged
	}
	if ev.PaperID != "" && ev.CandidateID == "" {
		m, err := scope.member(ev.PaperID)
		if err != nil || m.DocumentID != ev.DocumentID {
			return errResearchScopeChanged
		}
	}
	if ev.CandidateID != "" && ev.Kind == "local-passage" {
		if err := validateCandidateLocalEvidence(ctx, tx, scope, ev); err != nil {
			return err
		}
	}
	if ev.CandidateID != "" {
		var topic string
		if err := tx.QueryRowContext(ctx, `SELECT topic_id FROM research_candidates WHERE id=?`, ev.CandidateID).Scan(&topic); err != nil || topic != ev.TopicID {
			return errResearchScopeChanged
		}
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO research_evidence(id,topic_id,snapshot_id,run_id,paper_id,document_id,candidate_id,availability,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, ev.ID, ev.TopicID, ev.SnapshotID, ev.RunID, ev.PaperID, nullResearchString(ev.DocumentID), nullResearchString(ev.CandidateID), ev.Availability, jsonText(ev), ev.ReadAt, ev.ReadAt)
	return err
}
func nullResearchString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// Units stay native: PDF pages, EPUB spine resources, one local abstract, or
// zero metadata units. Partial passage reads retain exact ranges; they do not
// complete a page/section until all its extractable text was actually provided.
// Images remain separate viewed pages and never complete textual coverage.
func researchCoverageFor(st *researchReadState, evidence []ResearchEvidence) ResearchReadCoverage {
	coverage := ResearchReadCoverage{Ranges: []json.RawMessage{}}
	if st.Corpus != nil {
		coverage.TotalUnits = st.TotalUnits
	} else if st.Member.Coverage == "abstract" {
		coverage.TotalUnits = 1
	}
	read, seen := map[string]bool{}, map[string]bool{}
	for _, ev := range evidence {
		key := string(ev.Location)
		if !seen[key] {
			seen[key] = true
			coverage.Ranges = append(coverage.Ranges, ev.Location)
		}
		if ev.Kind == "local-passage" {
			var loc struct {
				BlockID string `json:"blockId"`
			}
			_ = json.Unmarshal(ev.Location, &loc)
			read[loc.BlockID] = true
		}
	}
	groups := map[string][]string{}
	for _, p := range researchPassages(st) {
		var loc struct {
			Type string `json:"type"`
			Page int    `json:"page"`
			Href string `json:"href"`
		}
		_ = json.Unmarshal(p.Location, &loc)
		unit := loc.Type + ":" + loc.Href
		if loc.Type == "pdf" {
			unit = fmt.Sprintf("pdf:%d", loc.Page)
		}
		groups[unit] = append(groups[unit], p.ID)
	}
	for unit, passages := range groups {
		complete := true
		for _, block := range passages {
			complete = complete && read[block]
		}
		if complete {
			if st.NativeUnits != nil {
				coverage.ReadUnits += st.NativeUnits[unit]
			} else {
				coverage.ReadUnits++
			}
		}
	}
	return coverage
}
func readResearchEvidence(ctx context.Context, db researchRowQuery, sourceID string) (ResearchEvidence, error) {
	var ev ResearchEvidence
	var raw, topic, snapshot, run, paper, document, candidate, availability string
	err := db.QueryRowContext(ctx, `SELECT body,topic_id,snapshot_id,run_id,COALESCE(paper_id,''),COALESCE(document_id,''),COALESCE(candidate_id,''),availability FROM research_evidence WHERE id=?`, sourceID).Scan(&raw, &topic, &snapshot, &run, &paper, &document, &candidate, &availability)
	if err != nil {
		return ev, err
	}
	if json.Unmarshal([]byte(raw), &ev) != nil || ev.ID != sourceID || ev.TopicID != topic || ev.SnapshotID != snapshot || ev.RunID != run || ev.PaperID != paper || ev.DocumentID != document || ev.CandidateID != candidate || ev.Availability != availability || availability != "valid" {
		return ResearchEvidence{}, errResearchScopeChanged
	}
	return ev, nil
}
func researchEvidenceMatches(ev ResearchEvidence, scope researchScope, st *researchReadState) bool {
	m := st.Member
	if ev.TopicID != scope.Run.TopicID || ev.SnapshotID != scope.Snapshot.ID || ev.RunID != scope.Run.ID || ev.PaperID != m.PaperID || ev.DocumentID != m.DocumentID || ev.CandidateID != "" || ev.Availability != "valid" {
		return false
	}
	revision := m.CorpusRevision
	if revision == "" {
		revision = m.SourceHash
	}
	if ev.Revision != revision {
		return false
	}
	if ev.Kind == "local-page" {
		var loc struct {
			Type string `json:"type"`
			Page int    `json:"page"`
		}
		return st.Corpus != nil && st.Document.Type == "pdf" && json.Unmarshal(ev.Location, &loc) == nil && loc.Type == "pdf" && loc.Page >= 1 && loc.Page <= st.Corpus.Coverage.TotalUnits && string(ev.Location) == fmt.Sprintf(`{"type":"pdf","page":%d}`, loc.Page)
	}
	if ev.Kind != "local-passage" || sourceKey(ev.Excerpt) != ev.ContentHash {
		return false
	}
	passages := researchPassages(st)
	var loc map[string]any
	if json.Unmarshal(ev.Location, &loc) != nil {
		return false
	}
	for _, p := range passages {
		if p.ID == loc["blockId"] && p.Text == ev.Excerpt {
			var actual map[string]any
			_ = json.Unmarshal(researchPassageLocation(p), &actual)
			return reflect.DeepEqual(loc, actual)
		}
	}
	return false
}
func (s *Server) resolveResearchSource(ctx context.Context, sourceID string) (ResearchEvidence, error) {
	ev, err := readResearchEvidence(ctx, s.Store.DB, sourceID)
	if err != nil {
		return ResearchEvidence{}, err
	}
	scope, err := readResearchRunScope(ctx, s.Store.DB, ev.RunID)
	if err != nil {
		return ResearchEvidence{}, err
	}
	if ev.CandidateID != "" && ev.Kind == "local-passage" {
		return s.resolveCandidateLocalSource(ctx, scope, ev)
	}
	if strings.HasPrefix(ev.Kind, "remote-") {
		tx, e := s.Store.DB.BeginTx(ctx, nil)
		if e != nil {
			return ResearchEvidence{}, e
		}
		defer tx.Rollback()
		current, e := readResearchEvidence(ctx, tx, sourceID)
		if e != nil || jsonText(current) != jsonText(ev) {
			return ResearchEvidence{}, errResearchScopeChanged
		}
		if e = validateResearchRemoteEvidence(ctx, tx, scope, ev); e != nil {
			return ResearchEvidence{}, e
		}
		if e = tx.Commit(); e != nil {
			return ResearchEvidence{}, e
		}
		return ev, nil
	}
	m, err := scope.member(ev.PaperID)
	if err != nil {
		return ResearchEvidence{}, err
	}
	st, err := s.prepareResearchRead(ctx, m)
	if err != nil {
		return ResearchEvidence{}, err
	}
	defer st.Finish()
	if !researchEvidenceMatches(ev, scope, st) {
		return ResearchEvidence{}, errResearchScopeChanged
	}
	if ev.Kind == "local-page" {
		var loc struct {
			Page int `json:"page"`
		}
		_ = json.Unmarshal(ev.Location, &loc)
		_, img, e := s.cachedPageImage(m.DocumentID, m.CorpusRevision, loc.Page)
		if e != nil || img.Hash != ev.ContentHash {
			return ResearchEvidence{}, errResearchScopeChanged
		}
	}
	err = s.commitResearchRead(st.Context, scope, []*researchReadState{st}, false, func(tx *sql.Tx) error {
		var raw, availability string
		if e := tx.QueryRowContext(ctx, `SELECT body,availability FROM research_evidence WHERE id=?`, sourceID).Scan(&raw, &availability); e != nil {
			return e
		}
		if raw != jsonText(ev) || availability != "valid" {
			return errResearchScopeChanged
		}
		return nil
	})
	if err != nil {
		return ResearchEvidence{}, err
	}
	return ev, nil
}
func (s *Server) validateResearchSources(ctx context.Context, runID string, sourceIDs []string) error {
	for _, sourceID := range sourceIDs {
		ev, err := s.resolveResearchSource(ctx, sourceID)
		if err != nil {
			return err
		}
		if ev.RunID != runID {
			return fmt.Errorf("来源不属于本次研究")
		}
	}
	return ctx.Err()
}
