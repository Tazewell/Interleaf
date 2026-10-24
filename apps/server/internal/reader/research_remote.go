package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"reader.local/server/internal/scholar"
)

const researchRemoteProtocol = "public-evidence-v2"

type researchRemoteCache struct {
	RunID, SnapshotID, TopicID, CandidateID, Version, ResourceHash, FinalURL, FetchedAt, Protocol string
	Evidence                                                                                      []ResearchEvidence
}

// Download and worker output own at most 64+32 MiB per operation. Reserve the
// upper bound before creating files; never evict original files or reports.
var researchRemoteWork = struct {
	sync.Mutex
	total int64
	runs  map[string]int64
}{runs: map[string]int64{}}

func reserveResearchRemoteWork(run string) (func(), error) {
	const bytes = int64(96 << 20)
	researchRemoteWork.Lock()
	defer researchRemoteWork.Unlock()
	if researchRemoteWork.total+bytes > 1<<30 || researchRemoteWork.runs[run]+bytes > 512<<20 {
		return nil, generationError(ErrorLimit, "研究临时下载空间不足")
	}
	researchRemoteWork.total += bytes
	researchRemoteWork.runs[run] += bytes
	return func() {
		researchRemoteWork.Lock()
		defer researchRemoteWork.Unlock()
		researchRemoteWork.total -= bytes
		researchRemoteWork.runs[run] -= bytes
		if researchRemoteWork.runs[run] == 0 {
			delete(researchRemoteWork.runs, run)
		}
	}, nil
}
func researchCandidateVersion(raw string) string {
	// Import mapping is provenance for future local reads, not a change to the
	// already-read public resource. All scholarly metadata still versions it.
	var candidate ResearchCandidate
	if json.Unmarshal([]byte(raw), &candidate) == nil && (candidate.PaperID != "" || candidate.DocumentID != "") {
		candidate.PaperID, candidate.DocumentID = "", ""
		raw = jsonText(candidate)
	}
	return sourceKey(researchRemoteProtocol + "\n" + raw)
}

// A topic candidate is not automatically registered for every run. The proof
// is either a successful search owned by this exact run, or an exact URL from
// its durable user input. Landing-page links never manufacture user authority.
func readResearchRegisteredCandidate(ctx context.Context, q researchRowQuery, scope researchScope, candidateID string) (ResearchCandidate, string, error) {
	var c ResearchCandidate
	current, e := readResearchRunScope(ctx, q, scope.Run.ID)
	if e != nil {
		return c, "", e
	}
	if current.Run.TopicID != scope.Run.TopicID || current.Run.SessionID != scope.Run.SessionID || current.Snapshot.ID != scope.Snapshot.ID || current.Snapshot.Revision != scope.Snapshot.Revision {
		return c, "", errResearchScopeChanged
	}
	var raw, topic, identity string
	err := q.QueryRowContext(ctx, `SELECT body,topic_id,identity_key FROM research_candidates WHERE id=?`, candidateID).Scan(&raw, &topic, &identity)
	if err != nil {
		return c, "", err
	}
	var availability struct {
		Availability string `json:"availability"`
	}
	_ = json.Unmarshal([]byte(raw), &availability)
	if json.Unmarshal([]byte(raw), &c) != nil || c.ID != candidateID || c.TopicID != topic || c.IdentityKey != identity || topic != scope.Run.TopicID || (availability.Availability != "" && availability.Availability != "valid") {
		return c, "", errResearchScopeChanged
	}
	var registered int
	err = q.QueryRowContext(ctx, `SELECT count(*) FROM research_searches s WHERE s.topic_id=? AND s.run_id=? AND json_extract(s.body,'$.id')=s.id AND json_extract(s.body,'$.runId')=s.run_id AND json_extract(s.body,'$.status')='ok' AND EXISTS(SELECT 1 FROM json_each(s.body,'$.candidateIds') v WHERE v.value=?)`, scope.Run.TopicID, scope.Run.ID, c.ID).Scan(&registered)
	if err != nil {
		return c, "", err
	}
	if registered == 0 {
		record, e := readResearchRecord(ctx, q, scope.Run.ID)
		if e != nil {
			return c, "", e
		}
		allowed := false
		for _, u := range record.Input.URLs {
			if u != "" && (u == c.LandingURL || u == c.PDFURL) {
				allowed = true
			}
		}
		// With no search proof, use only the user supplied URL. A candidate may
		// not smuggle a second PDF/landing URL by matching just one of its fields.
		if !allowed {
			return c, "", fmt.Errorf("候选未在本次研究中登记")
		}
		if c.PDFURL != "" && !containsResearchID(record.Input.URLs, c.PDFURL) {
			return c, "", errResearchScopeChanged
		}
		if c.LandingURL != "" && !containsResearchID(record.Input.URLs, c.LandingURL) {
			return c, "", errResearchScopeChanged
		}
	}
	return c, researchCandidateVersion(raw), nil
}

func (s *Server) reserveResearchNetwork(ctx context.Context, runID, kind string) error {
	s.researchNetworkMu.Lock()
	defer s.researchNetworkMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, _, err = researchNetworkPermission(ctx, tx, runID); err != nil {
		return err
	}
	if err = checkResearchNetworkLease(ctx, tx, runID); err != nil {
		return err
	}
	r, err := readResearchRecord(ctx, tx, runID)
	if err != nil {
		return err
	}
	if r.Status != "running" {
		return context.Canceled
	}
	var sessionBody, sessionTopic string
	if err = tx.QueryRowContext(ctx, `SELECT body,topic_id FROM research_sessions WHERE id=?`, r.SessionID).Scan(&sessionBody, &sessionTopic); err != nil {
		return err
	}
	var session ResearchSession
	if json.Unmarshal([]byte(sessionBody), &session) != nil || session.ID != r.SessionID || session.TopicID != sessionTopic || sessionTopic != r.TopicID {
		return errResearchScopeChanged
	}
	if r.Input.Network == "deny" || r.Input.Network != "allow-task" && !session.NetworkAllowed {
		return fmt.Errorf("本次研究未允许论文联网")
	}
	started, err := time.Parse(time.RFC3339Nano, r.AttemptStarted)
	if err != nil {
		return err
	}
	if time.Since(started) >= time.Duration(r.AttemptBudget.MaxMinutes)*time.Minute {
		return errResearchBudget
	}
	switch kind {
	case "search":
		if r.AttemptSearchRequests >= r.AttemptBudget.MaxSearchRequests {
			return errResearchBudget
		}
		r.AttemptSearchRequests++
		r.SearchRequests++
	case "remote":
		if r.AttemptRemoteReads >= r.AttemptBudget.MaxRemoteReads {
			return errResearchBudget
		}
		r.AttemptRemoteReads++
		r.RemoteReads++
	default:
		return fmt.Errorf("未知研究网络预算类型")
	}
	if err = writeResearchRecord(ctx, tx, r); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) researchRemoteLocal(ctx context.Context, scope researchScope, c ResearchCandidate) ([]ResearchEvidence, bool, error) {
	paperID := c.PaperID
	previouslyLocal := c.DocumentID != ""
	{
		// Evidence keeps identity metadata after payload removal. Remember that
		// this candidate used a local original even after its paper row is purged;
		// a public download must not silently resurrect that deleted source.
		rows, e := s.Store.DB.QueryContext(ctx, `SELECT body,paper_id,COALESCE(document_id,''),run_id,snapshot_id,availability FROM research_evidence WHERE candidate_id=? AND topic_id=? AND paper_id!=''`, c.ID, scope.Run.TopicID)
		if e != nil {
			return nil, true, e
		}
		for rows.Next() {
			var raw, pid, doc, run, snapshot, state string
			if e = rows.Scan(&raw, &pid, &doc, &run, &snapshot, &state); e != nil {
				rows.Close()
				return nil, true, e
			}
			var ev ResearchEvidence
			if json.Unmarshal([]byte(raw), &ev) != nil || ev.CandidateID != c.ID || ev.TopicID != scope.Run.TopicID || ev.PaperID != pid || ev.DocumentID != doc || ev.RunID != run || ev.SnapshotID != snapshot || ev.Availability != state || ev.Kind != "local-passage" || paperID != "" && paperID != pid {
				rows.Close()
				return nil, true, errResearchScopeChanged
			}
			paperID = pid
			previouslyLocal = true
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, true, e
		}
	}
	if paperID == "" && (c.DOI != "" || c.ArXiv != "") {
		// Check exact scholarly identities, never title similarity. Include trash:
		// deleted local originals cannot be resurrected from a candidate cache.
		rows, err := s.Store.DB.QueryContext(ctx, `SELECT id,metadata FROM paper_items`)
		if err != nil {
			return nil, false, err
		}
		for rows.Next() {
			var pid, raw string
			if err = rows.Scan(&pid, &raw); err != nil {
				rows.Close()
				return nil, false, err
			}
			var m PaperMetadata
			if json.Unmarshal([]byte(raw), &m) != nil {
				continue
			}
			if c.DOI != "" && strings.EqualFold(strings.TrimSpace(c.DOI), strings.TrimSpace(m.DOI)) || scholar.SameArXiv(c.ArXiv, m.ArXiv) {
				if paperID != "" && paperID != pid {
					rows.Close()
					return nil, true, errResearchScopeChanged
				}
				paperID = pid
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, false, err
		}
	}
	if paperID == "" {
		return nil, false, nil
	}
	paper, err := s.Store.PaperItem(paperID)
	if err != nil {
		return nil, true, err
	}
	if !candidatePaperIdentity(c, paper) {
		return nil, true, errResearchScopeChanged
	}
	hasOriginal := false
	for _, attachment := range paper.Attachments {
		if attachment.Role == "original" {
			hasOriginal = true
			break
		}
	}
	if !hasOriginal && !previouslyLocal && paper.DeletedAt == "" {
		// A bibliographic item without original is not a deleted source. A prior
		// candidate-local provenance, even removed, must never take this path.
		return nil, false, nil
	}
	evidence, err := s.readCandidateLocalOriginal(ctx, scope, c, paper)
	return evidence, true, err
}

func remoteCacheKey(candidate, version string) string { return "remote:" + candidate + ":" + version }
func readResearchRemoteCache(ctx context.Context, q researchRowQuery, scope researchScope, c ResearchCandidate, version string) (researchRemoteCache, error) {
	var cache researchRemoteCache
	unit, err := readResearchUnit(ctx, q, scope.Run.ID, remoteCacheKey(c.ID, version))
	if err != nil {
		return cache, err
	}
	if unit.Kind != "remote" || unit.Status != "complete" || unit.ContentHash != sourceKey(string(unit.Result)) || json.Unmarshal(unit.Result, &cache) != nil || cache.RunID != scope.Run.ID || cache.TopicID != scope.Run.TopicID || cache.SnapshotID != scope.Snapshot.ID || cache.CandidateID != c.ID || cache.Version != version || cache.Protocol != researchRemoteProtocol || len(cache.Evidence) == 0 {
		return cache, errResearchScopeChanged
	}
	return cache, nil
}
func validateResearchRemoteEvidence(ctx context.Context, q researchRowQuery, scope researchScope, ev ResearchEvidence) error {
	if ev.RunID != scope.Run.ID || ev.TopicID != scope.Run.TopicID || ev.SnapshotID != scope.Snapshot.ID || ev.PaperID != "" || ev.DocumentID != "" || ev.CandidateID == "" || ev.Availability != "valid" || !strings.HasPrefix(ev.Kind, "remote-") {
		return errResearchScopeChanged
	}
	c, version, err := readResearchRegisteredCandidate(ctx, q, scope, ev.CandidateID)
	if err != nil {
		return err
	}
	cache, err := readResearchRemoteCache(ctx, q, scope, c, version)
	if err != nil {
		return err
	}
	if ev.Revision != sourceKey(version+"\n"+cache.ResourceHash) || ev.ContentHash != sourceKey(ev.Excerpt) {
		return errResearchScopeChanged
	}
	for _, original := range cache.Evidence {
		if original.ID == ev.ID && jsonText(original) == jsonText(ev) {
			return nil
		}
	}
	return errResearchScopeChanged
}

func (s *Server) readResearchRemote(ctx context.Context, runID, candidateID string) ([]ResearchEvidence, error) {
	ctx, finish, err := s.beginResearchNetwork(ctx, runID)
	if err != nil {
		return nil, err
	}
	defer finish()
	scope, err := readResearchRunScope(ctx, s.Store.DB, runID)
	if err != nil {
		return nil, err
	}
	if scope.Run.Status != "running" {
		return nil, context.Canceled
	}
	c, version, err := readResearchRegisteredCandidate(ctx, s.Store.DB, scope, candidateID)
	if err != nil {
		return nil, err
	}
	if local, found, e := s.researchRemoteLocal(ctx, scope, c); found || e != nil {
		return local, e
	}
	cache, err := readResearchRemoteCache(ctx, s.Store.DB, scope, c, version)
	if err == nil {
		for _, ev := range cache.Evidence {
			if _, err = s.resolveResearchSource(ctx, ev.ID); err != nil {
				return nil, err
			}
		}
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		return cache.Evidence, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	release, err := reserveResearchRemoteWork(runID)
	if err != nil {
		return nil, err
	}
	defer release()
	work, err := os.MkdirTemp(filepath.Join(s.Store.Root, "ai-work"), "research-remote-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	var reservationErr error
	ctx = scholar.WithPublicReservation(ctx, func(ctx context.Context) error {
		reservationErr = s.reserveResearchNetwork(ctx, runID, "remote")
		return reservationErr
	})
	raw, kind := c.PDFURL, "pdf"
	if raw == "" {
		raw, kind = c.LandingURL, "document"
	}
	var resource scholar.PublicResource
	var fetchErr error
	if raw != "" {
		resource, fetchErr = s.scholarClient().FetchPublic(ctx, raw, kind)
	} else {
		fetchErr = fmt.Errorf("候选仅有摘要")
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if reservationErr != nil {
		return nil, reservationErr
	}
	cache = researchRemoteCache{RunID: runID, TopicID: scope.Run.TopicID, SnapshotID: scope.Snapshot.ID, CandidateID: c.ID, Version: version, Protocol: researchRemoteProtocol, FinalURL: resource.FinalURL, FetchedAt: resource.FetchedAt, ResourceHash: resource.Hash, Evidence: []ResearchEvidence{}}
	add := func(kind, text string, location map[string]any) {
		if strings.TrimSpace(text) == "" {
			return
		}
		location["url"] = cache.FinalURL
		location["fetchedAt"] = cache.FetchedAt
		location["resourceHash"] = cache.ResourceHash
		cache.Evidence = append(cache.Evidence, ResearchEvidence{ID: id(), TopicID: scope.Run.TopicID, SnapshotID: scope.Snapshot.ID, RunID: runID, CandidateID: c.ID, Kind: kind, Revision: sourceKey(version + "\n" + cache.ResourceHash), ContentHash: sourceKey(text), Location: json.RawMessage(jsonText(location)), Excerpt: text, ReadAt: now(), Availability: "valid"})
	}
	if fetchErr == nil && (kind == "pdf" || strings.Contains(strings.ToLower(resource.ContentType), "application/pdf")) {
		input := filepath.Join(work, "source.pdf")
		if err = os.WriteFile(input, resource.Bytes, 0600); err != nil {
			return nil, err
		}
		extracted, e := runPDFTextWorker(ctx, work, input, "")
		fetchErr = e
		if e == nil {
			for _, page := range extracted.Pages {
				var text strings.Builder
				for _, span := range page.Spans {
					if text.Len() > 0 {
						text.WriteByte(' ')
					}
					text.WriteString(span.Text)
				}
				add("remote-page", strings.TrimSpace(text.String()), map[string]any{"type": "pdf", "page": page.Page, "totalPages": extracted.TotalPages, "textOnly": true})
			}
		}
	} else if fetchErr == nil {
		for i, p := range strings.Split(string(resource.Bytes), "\n") {
			add("remote-html", p, map[string]any{"type": "html", "paragraph": i + 1})
		}
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if len(cache.Evidence) == 0 {
		abstract := scholar.PublicText(c.Abstract)
		if abstract == "" {
			if fetchErr != nil {
				return nil, fetchErr
			}
			return nil, fmt.Errorf("公开资料没有可读正文或摘要")
		}
		cache.FinalURL = scholar.PublicDisplayURL(c.LandingURL)
		cache.ResourceHash = sourceKey(abstract)
		cache.FetchedAt = ""
		reason := "未获取可读全文，仅有已登记摘要"
		if fetchErr != nil {
			reason += "：" + fetchErr.Error()
		}
		add("remote-abstract", abstract, map[string]any{"type": "abstract", "abstractOnly": true, "reason": reason})
	}
	payload := json.RawMessage(jsonText(cache))
	if len(payload) > 32<<20 {
		return nil, generationError(ErrorLimit, "远程证据超过缓存限制")
	}
	err = s.commitResearchRead(ctx, scope, nil, true, func(tx *sql.Tx) error {
		current, currentVersion, e := readResearchRegisteredCandidate(ctx, tx, scope, c.ID)
		if e != nil {
			return e
		}
		if currentVersion != version || current.ID != c.ID {
			return errResearchScopeChanged
		}
		if prior, e := readResearchRemoteCache(ctx, tx, scope, c, version); e == nil {
			cache = prior
			return nil
		} else if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		// One SQLite writer serializes cache quota checks with publication. Cache
		// is task-owned text, not library Documents; no original file is reclaimed.
		var total, runBytes int64
		if e = tx.QueryRowContext(ctx, `SELECT COALESCE(sum(length(CAST(body AS BLOB))),0),COALESCE(sum(CASE WHEN run_id=? THEN length(CAST(body AS BLOB)) ELSE 0 END),0) FROM research_units WHERE kind='remote'`, runID).Scan(&total, &runBytes); e != nil {
			return e
		}
		if total+int64(len(payload)) > 1<<30 || runBytes+int64(len(payload)) > 512<<20 {
			return generationError(ErrorLimit, "研究远程缓存空间不足")
		}
		unit := ResearchUnit{RunID: runID, UnitKey: remoteCacheKey(c.ID, version), Kind: "remote", Status: "complete", ContentHash: sourceKey(string(payload)), Result: payload}
		if e = writeResearchUnit(ctx, tx, unit); e != nil {
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
