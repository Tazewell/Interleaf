package interleaf

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Re-resolve only actually acquired sources, including current local source
// identity and remote candidate versions. Old report text is never evidence.
func (s *Server) researchIdeaEvidence(ctx context.Context, runID string) ([]ResearchEvidence, error) {
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT id FROM research_evidence WHERE run_id=? AND availability='valid' ORDER BY id`, runID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := []ResearchEvidence{}
	for _, source := range ids {
		ev, e := s.resolveResearchSource(ctx, source)
		if e != nil {
			return nil, e
		}
		if ev.RunID != runID {
			return nil, errResearchScopeChanged
		}
		out = append(out, ev)
	}
	return out, nil
}
func researchWorkID(e ResearchEvidence) string {
	if e.CandidateID != "" {
		return e.CandidateID
	}
	return e.PaperID
}
func validateResearchIdea(idea ResearchIdea, evidence []ResearchEvidence) error {
	for _, v := range []string{idea.ID, idea.Problem, idea.Mechanism, idea.MinimumExperiment, idea.Falsification, idea.Resources} {
		if len(strings.TrimSpace(v)) < 3 {
			return fmt.Errorf("idea缺少具体机制、实验或证伪条件")
		}
	}
	for _, list := range [][]string{idea.Hypotheses, idea.Changes, idea.Baselines, idea.Ablations} {
		if len(list) == 0 {
			return fmt.Errorf("idea缺少实验字段")
		}
		for _, v := range list {
			if len(strings.TrimSpace(v)) < 3 {
				return fmt.Errorf("idea实验字段为空")
			}
		}
	}
	allowed := map[string]ResearchEvidence{}
	works := map[string]bool{}
	for _, ev := range evidence {
		if ev.Availability == "valid" {
			allowed[ev.ID] = ev
		}
	}
	if len(idea.Basis) == 0 || len(idea.NearestWorkIDs) == 0 {
		return fmt.Errorf("idea缺少事实证据归因")
	}
	for _, fact := range idea.Basis {
		if strings.TrimSpace(fact.Text) == "" || len(fact.EvidenceIDs) == 0 {
			return fmt.Errorf("idea事实未归因")
		}
		for _, sid := range fact.EvidenceIDs {
			ev, ok := allowed[sid]
			if !ok {
				return errResearchScopeChanged
			}
			works[researchWorkID(ev)] = true
		}
	}
	for _, work := range idea.NearestWorkIDs {
		if !works[work] {
			return errResearchScopeChanged
		}
	}
	if len(idea.Claims) == 0 {
		return fmt.Errorf("idea缺少待查主张")
	}
	seen := map[string]bool{}
	for _, claim := range idea.Claims {
		if claim.ID == "" || seen[claim.ID] || len(strings.TrimSpace(claim.Text)) < 3 || (claim.Kind != "problem" && claim.Kind != "method" && claim.Kind != "experiment") {
			return fmt.Errorf("idea主张无效")
		}
		seen[claim.ID] = true
	}
	refs := []string{}
	for _, f := range idea.Basis {
		refs = append(refs, f.EvidenceIDs...)
	}
	if err := validateResearchInlineSources(jsonText(idea), refs); err != nil {
		return err
	}
	if researchOverclaim(jsonText(idea)) {
		return fmt.Errorf("idea不能保证原创性或编造概率")
	}
	return nil
}
func (s *Server) saveResearchResult(ctx context.Context, scope researchScope, key, kind string, result any) error {
	states := []*researchReadState{}
	defer func() {
		for _, st := range states {
			st.Finish()
		}
	}()
	refs := []string{}
	switch v := result.(type) {
	case researchBatchCheckpoint:
		refs = append(refs, v.SourceIDs...)
		for _, source := range v.Progress.Sources {
			refs = append(refs, source.SourceID)
		}
		for _, idea := range v.Ideas {
			for _, f := range idea.Basis {
				refs = append(refs, f.EvidenceIDs...)
			}
		}
		for _, row := range v.Rows {
			refs = append(refs, row.EvidenceIDs...)
		}
	case []ResearchIdea:
		for _, idea := range v {
			for _, f := range idea.Basis {
				refs = append(refs, f.EvidenceIDs...)
			}
		}
	case NoveltyReport:
		for _, row := range v.Rows {
			refs = append(refs, row.EvidenceIDs...)
		}
	}
	for _, m := range scope.Snapshot.Members {
		if m.Coverage == "unavailable" {
			continue
		}
		st, e := s.prepareResearchRead(ctx, m)
		if e != nil {
			return e
		}
		states = append(states, st)
	}
	return s.commitResearchRead(ctx, scope, states, true, func(tx *sql.Tx) error {
		for _, sid := range refs {
			ev, e := readResearchEvidence(ctx, tx, sid)
			if e != nil || ev.RunID != scope.Run.ID || ev.TopicID != scope.Run.TopicID || ev.SnapshotID != scope.Snapshot.ID {
				return errResearchScopeChanged
			}
			if ev.CandidateID != "" && ev.Kind == "local-passage" {
				if e = validateCandidateLocalEvidence(ctx, tx, scope, ev); e != nil {
					return e
				}
			} else if strings.HasPrefix(ev.Kind, "remote-") {
				if e = validateResearchRemoteEvidence(ctx, tx, scope, ev); e != nil {
					return e
				}
			} else {
				valid := false
				for _, st := range states {
					valid = valid || researchEvidenceMatches(ev, scope, st)
				}
				if !valid {
					return errResearchScopeChanged
				}
			}
		}
		return writeResearchUnit(ctx, tx, ResearchUnit{RunID: scope.Run.ID, UnitKey: key, Kind: kind, Status: "complete", ContentHash: sourceKey(jsonText(result)), Result: json.RawMessage(jsonText(result))})
	})
}
func (s *Server) getResearchResults(ctx context.Context, runID string) (ResearchResults, error) {
	out := ResearchResults{PartialIdeas: []ResearchIdea{}, Batches: []ResearchBatchProgress{}, Ideas: []ResearchIdea{}, Novelty: []NoveltyReport{}, Queries: []ResearchNoveltyQuery{}, PendingIdeaIDs: []string{}, Capability: "text-search-assistance"}
	if _, err := readResearchRecord(ctx, s.Store.DB, runID); err != nil {
		return out, err
	}
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT unit_key FROM research_units WHERE run_id=? AND kind IN ('ideas','novelty','novelty-queries','research-batch') AND status='complete' ORDER BY unit_key`, runID)
	if err != nil {
		return out, err
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if err = rows.Scan(&key); err != nil {
			rows.Close()
			return out, err
		}
		keys = append(keys, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	checked := map[string]bool{}
	for _, key := range keys {
		u, e := readResearchUnit(ctx, s.Store.DB, runID, key)
		if e != nil {
			return out, e
		}
		if u.ContentHash != sourceKey(string(u.Result)) {
			return out, errResearchScopeChanged
		}
		switch u.Kind {
		case "research-batch":
			var cp researchBatchCheckpoint
			err = json.Unmarshal(u.Result, &cp)
			out.Batches = append(out.Batches, cp.Progress)
			if cp.Progress.Stage == "ideas" {
				out.PartialIdeas = cp.Ideas
			}
		case "ideas":
			err = json.Unmarshal(u.Result, &out.Ideas)
		case "novelty":
			var n NoveltyReport
			err = json.Unmarshal(u.Result, &n)
			out.Novelty = append(out.Novelty, n)
			checked[n.IdeaID] = true
		case "novelty-queries":
			var q []ResearchNoveltyQuery
			err = json.Unmarshal(u.Result, &q)
			out.Queries = append(out.Queries, q...)
		}
		if err != nil {
			return out, err
		}
	}
	if len(out.Ideas) > 0 {
		out.PartialIdeas = []ResearchIdea{}
	}
	for _, idea := range out.Ideas {
		if !checked[idea.ID] {
			out.PendingIdeaIDs = append(out.PendingIdeaIDs, idea.ID)
		}
	}
	return out, nil
}
func (s *Server) selectedResearchIdea(ctx context.Context, r researchRunRecord, evidence []ResearchEvidence) (ResearchIdea, error) {
	var idea ResearchIdea
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT u.run_id FROM research_units u JOIN research_runs r ON r.id=u.run_id WHERE r.topic_id=? AND r.session_id=? AND u.kind='ideas' AND u.status='complete' AND json_extract(r.body,'$.revision')=? ORDER BY u.created_at DESC`, r.TopicID, r.SessionID, r.Revision)
	if err != nil {
		return idea, err
	}
	runs := []string{}
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			rows.Close()
			return idea, err
		}
		runs = append(runs, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return idea, err
	}
	for _, rid := range runs {
		results, e := s.getResearchResults(ctx, rid)
		if e != nil {
			return idea, e
		}
		for _, v := range results.Ideas {
			if v.ID != r.Input.IdeaID {
				continue
			}
			idea = v
			// Only exact currently verified content can replace an old source ID.
			adopted := map[string]string{}
			for i, f := range idea.Basis {
				for j, sid := range f.EvidenceIDs {
					old, e := s.resolveResearchSource(ctx, sid)
					if e != nil {
						return idea, e
					}
					matched := ""
					for _, cur := range evidence {
						if researchWorkID(old) == researchWorkID(cur) && old.Revision == cur.Revision && old.ContentHash == cur.ContentHash && string(old.Location) == string(cur.Location) {
							matched = cur.ID
							break
						}
					}
					if matched == "" {
						return idea, fmt.Errorf("所选idea的证据尚未在本次研究重验")
					}
					idea.Basis[i].EvidenceIDs[j] = matched
					adopted[sid] = matched
				}
			}
			remapResearchIdeaInlineSources(&idea, adopted)
			return idea, validateResearchIdea(idea, evidence)
		}
	}
	return idea, fmt.Errorf("所选idea不属于当前会话和资料版本")
}
func (s *Server) exploreResearchIdeas(ctx context.Context, runID string) ([]ResearchIdea, error) {
	scope, err := readResearchRunScope(ctx, s.Store.DB, runID)
	if err != nil {
		return nil, err
	}
	evidence, err := s.researchIdeaEvidence(ctx, runID)
	if err != nil {
		return nil, err
	}
	if u, e := readResearchUnit(ctx, s.Store.DB, runID, "ideas"); e == nil {
		var ideas []ResearchIdea
		if u.Kind != "ideas" || u.Status != "complete" || u.ContentHash != sourceKey(string(u.Result)) || json.Unmarshal(u.Result, &ideas) != nil {
			return nil, errResearchScopeChanged
		}
		for _, v := range ideas {
			if e = validateResearchIdea(v, evidence); e != nil {
				return nil, e
			}
		}
		return ideas, nil
	} else if !errors.Is(e, sql.ErrNoRows) {
		return nil, e
	}
	r, err := readResearchRecord(ctx, s.Store.DB, runID)
	if err != nil {
		return nil, err
	}
	count := r.Input.IdeaCount
	if count == 0 {
		count = 3
	}
	selected := ResearchIdea{}
	if r.Input.IdeaID != "" {
		selected, err = s.selectedResearchIdea(ctx, r, evidence)
		if err != nil {
			return nil, err
		}
		count = 1
	}
	// Acquisition's lease ends before this stage. Remote evidence needs a fresh
	// generation check and an owner spanning model work and both checkpoint
	// writes, so revocation cancels and joins late responses before returning.
	// Purely local ideas remain usable with scholarly networking disabled.
	for _, ev := range evidence {
		if strings.HasPrefix(ev.Kind, "remote-") {
			var finish func()
			ctx, finish, err = s.beginResearchNetwork(ctx, runID)
			if err != nil {
				return nil, err
			}
			defer finish()
			break
		}
	}
	ideas := []ResearchIdea{}
	if r.Input.Mode == "novelty" {
		ideas = append(ideas, selected)
	} else {
		var payload struct {
			Ideas []ResearchIdea `json:"ideas"`
		}
		validate := func(text string) error {
			if strictToolArguments([]byte(text), &payload) != nil || len(payload.Ideas) != count {
				return fmt.Errorf("idea数量或结构无效")
			}
			for _, v := range payload.Ideas {
				if e := validateResearchIdea(v, evidence); e != nil {
					return e
				}
			}
			return nil
		}
		prompt := researchIdeasPrompt + fmt.Sprintf("\n候选数量=%d；用户要求=%s；仅精化此候选=%s\nRESEARCH_IDEA_EVIDENCE_JSON\n%s", count, r.Input.Question, jsonText(selected), jsonText(evidence))
		if !researchStageFits(ctx, prompt) {
			ideas, err = s.exploreResearchIdeaBatches(ctx, scope, r, count, selected, evidence)
			if err != nil {
				return nil, err
			}
			payload.Ideas = ideas
		} else if _, err = s.researchNetworkPlan(ctx, scope, "ideas-model", prompt, validate); err != nil {
			return nil, err
		}
		ideas = payload.Ideas
		for i := range ideas {
			ideas[i].ID = sourceKey(fmt.Sprintf("%s:idea:%d", runID, i))[:32]
			ideas[i].DerivedFromID = r.Input.IdeaID
		}
	}
	if err = s.saveResearchResult(ctx, scope, "ideas", "ideas", ideas); err != nil {
		return nil, err
	}
	return ideas, nil
}

func validateResearchInlineSources(text string, refs []string) error {
	allowed := map[string]bool{}
	for _, sid := range refs {
		allowed[sid] = true
	}
	_, err := parseResearchSection(jsonText(researchReportSection{Content: text, SourceIDs: refs}), allowed)
	return err
}

var researchInlineSourceToken = regexp.MustCompile(`\[[0-9a-f]{32}\]`)

// Rewrite only supported citation tokens after all old sources were verified.
// IDs in prose, claim identities and unknown references never gain authority.
func remapResearchIdeaInlineSources(idea *ResearchIdea, adopted map[string]string) {
	rewrite := func(text string) string {
		return researchInlineSourceToken.ReplaceAllStringFunc(text, func(token string) string {
			if sid, ok := adopted[token[1:len(token)-1]]; ok {
				return "[" + sid + "]"
			}
			return token
		})
	}
	for _, p := range []*string{&idea.Problem, &idea.Mechanism, &idea.MinimumExperiment, &idea.Falsification, &idea.Resources} {
		*p = rewrite(*p)
	}
	for _, list := range [][]string{idea.Hypotheses, idea.Changes, idea.Baselines, idea.Ablations} {
		for i := range list {
			list[i] = rewrite(list[i])
		}
	}
	for i := range idea.Basis {
		idea.Basis[i].Text = rewrite(idea.Basis[i].Text)
	}
	for i := range idea.Claims {
		idea.Claims[i].Text = rewrite(idea.Claims[i].Text)
	}
}
