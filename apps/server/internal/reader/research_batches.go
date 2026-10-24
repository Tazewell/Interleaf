package reader

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// A model fragment is an explicitly bounded view of an existing source. It
// retains the original kind/hash/identity, never a new or upgraded evidence row.
type researchEvidenceFragment struct {
	ResearchEvidence
	From  int `json:"fragmentFrom"`
	To    int `json:"fragmentTo"`
	Total int `json:"fragmentTotal"`
}
type researchBatchCheckpoint struct {
	Progress    ResearchBatchProgress `json:"progress"`
	Fingerprint string                `json:"fingerprint"`
	SourceIDs   []string              `json:"sourceIds"`
	Ideas       []ResearchIdea        `json:"ideas"`
	Rows        []NoveltyRow          `json:"rows"`
}

func researchFragments(evidence []ResearchEvidence) []researchEvidenceFragment {
	out := []researchEvidenceFragment{}
	for _, ev := range evidence {
		r := []rune(ev.Excerpt)
		if len(r) == 0 {
			out = append(out, researchEvidenceFragment{ResearchEvidence: ev})
			continue
		}
		for from := 0; from < len(r); from += 1024 {
			to := min(from+1024, len(r))
			part := ev
			part.Excerpt = string(r[from:to])
			out = append(out, researchEvidenceFragment{part, from, to, len(r)})
		}
	}
	return out
}
func researchStageFits(ctx context.Context, prompt string) bool {
	a, ok := ctx.Value(researchAttemptKey{}).(*researchAttempt)
	if !ok {
		return false
	}
	snapshot := a.snapshot
	snapshot.Tools = false
	snapshot.Vision = false
	return nativeConversationFits(nativeInitialMessages(snapshot, AIInput{Prompt: prompt, SourceOnly: true}), nil, nativeInputLimit(snapshot))
}
func researchBatchEnd(ctx context.Context, fragments []researchEvidenceFragment, start int, prompt func([]researchEvidenceFragment) string) (int, error) {
	end := start
	for end < len(fragments) && researchStageFits(ctx, prompt(fragments[start:end+1])) {
		end++
	}
	if end == start {
		return end, generationError(ErrorContext, "单项研究上下文无法放入当前模型窗口，请缩小问题或候选描述")
	}
	return end, nil
}
func (s *Server) researchBatchCheckpoint(ctx context.Context, scope researchScope, key string, progress ResearchBatchProgress, fingerprint string) (researchBatchCheckpoint, error) {
	cp := researchBatchCheckpoint{Progress: progress, Fingerprint: fingerprint, SourceIDs: []string{}, Ideas: []ResearchIdea{}, Rows: []NoveltyRow{}}
	u, e := readResearchUnit(ctx, s.Store.DB, scope.Run.ID, key)
	if errors.Is(e, sql.ErrNoRows) {
		return cp, nil
	}
	if e != nil {
		return cp, e
	}
	if u.Kind != "research-batch" || u.Status != "complete" || u.ContentHash != sourceKey(string(u.Result)) || json.Unmarshal(u.Result, &cp) != nil || cp.Fingerprint != fingerprint || cp.Progress.Total != progress.Total || cp.Progress.Stage != progress.Stage || cp.Progress.IdeaID != progress.IdeaID || cp.Progress.ClaimID != progress.ClaimID || cp.Progress.Done < 0 || cp.Progress.Done > progress.Total {
		return cp, errResearchScopeChanged
	}
	return cp, nil
}
func researchBatchSources(fragments []researchEvidenceFragment) []string {
	ids := []string{}
	for _, f := range fragments {
		if !containsResearchID(ids, f.ID) {
			ids = append(ids, f.ID)
		}
	}
	return ids
}

// Counts analysed fragments of each original source, including untouched ones.
// These are processing counters; the original source kind still governs what
// can be claimed about a paper's full text.
func researchBatchSourceProgress(fragments []researchEvidenceFragment, done int) []ResearchBatchSourceProgress {
	out := []ResearchBatchSourceProgress{}
	indexes := map[string]int{}
	for i, f := range fragments {
		index, ok := indexes[f.ID]
		if !ok {
			index = len(out)
			indexes[f.ID] = index
			out = append(out, ResearchBatchSourceProgress{SourceID: f.ID})
		}
		out[index].Total++
		if i < done {
			out[index].Done++
		}
	}
	return out
}
func researchAllowedEvidence(all []ResearchEvidence, ids []string) []ResearchEvidence {
	out := []ResearchEvidence{}
	for _, ev := range all {
		if containsResearchID(ids, ev.ID) {
			out = append(out, ev)
		}
	}
	return out
}
func (s *Server) exploreResearchIdeaBatches(ctx context.Context, scope researchScope, r researchRunRecord, count int, selected ResearchIdea, evidence []ResearchEvidence) ([]ResearchIdea, error) {
	fragments := researchFragments(evidence)
	key := "batch:ideas"
	fingerprint := sourceKey(jsonText([]any{r.Input, selected, fragments, "ideas-batch-v1"}))
	cp, err := s.researchBatchCheckpoint(ctx, scope, key, ResearchBatchProgress{Stage: "ideas", Total: len(fragments), Sources: researchBatchSourceProgress(fragments, 0)}, fingerprint)
	if err != nil {
		return nil, err
	}
	for _, v := range cp.Ideas {
		if err = validateResearchIdea(v, evidence); err != nil {
			return nil, err
		}
	}
	if err = s.saveResearchResult(ctx, scope, key, "research-batch", cp); err != nil {
		return nil, err
	}
	for cp.Progress.Done < len(fragments) {
		start := cp.Progress.Done
		prompt := func(batch []researchEvidenceFragment) string {
			return researchIdeasPrompt + fmt.Sprintf("\n候选数量=%d；用户要求=%s；用户所选候选=%s；上一批派生候选=%s。滚动综合本批与前批已验证分析，保留冲突、限制及最强候选。用户所选和前批候选都是派生分析，不是新的原文证据，只能使用其basis中的已验证引用。本批是原文片段，fragmentFrom/To/Total说明范围；不得声称片段外全文或图像已看过。输出候选总JSON保持精炼，以便后批继续。\nRESEARCH_IDEA_EVIDENCE_JSON\n%s", count, r.Input.Question, jsonText(selected), jsonText(cp.Ideas), jsonText(batch))
		}
		end, e := researchBatchEnd(ctx, fragments, start, prompt)
		if e != nil {
			return nil, e
		}
		batch := fragments[start:end]
		allowedIDs := researchBatchSources(batch)
		for _, fact := range selected.Basis {
			allowedIDs = append(allowedIDs, fact.EvidenceIDs...)
		}
		for _, v := range cp.Ideas {
			for _, f := range v.Basis {
				allowedIDs = append(allowedIDs, f.EvidenceIDs...)
			}
		}
		allowed := researchAllowedEvidence(evidence, allowedIDs)
		var result struct {
			Ideas []ResearchIdea `json:"ideas"`
		}
		validate := func(text string) error {
			if strictToolArguments([]byte(text), &result) != nil || len(result.Ideas) != count {
				return fmt.Errorf("分批候选数量或结构无效")
			}
			for _, v := range result.Ideas {
				if e := validateResearchIdea(v, allowed); e != nil {
					return e
				}
			}
			a := ctx.Value(researchAttemptKey{}).(*researchAttempt)
			if !nativeConversationFits(nativeInitialMessages(a.snapshot, AIInput{Prompt: jsonText(result), SourceOnly: true}), nil, nativeInputLimit(a.snapshot)/3) {
				return generationError(ErrorContext, "派生候选过长，需精炼后继续")
			}
			return nil
		}
		if _, err = s.researchNetworkPlan(ctx, scope, fmt.Sprintf("ideas-batch-model:%d", start), prompt(batch), validate); err != nil {
			return nil, err
		}
		cp.Ideas = result.Ideas
		for i := range cp.Ideas {
			cp.Ideas[i].ID = sourceKey(fmt.Sprintf("%s:idea:%d", scope.Run.ID, i))[:32]
			cp.Ideas[i].DerivedFromID = r.Input.IdeaID
		}
		cp.Progress.Done = end
		cp.Progress.CompletedBatches++
		cp.Progress.Sources = researchBatchSourceProgress(fragments, end)
		cp.SourceIDs = researchBatchSources(fragments[:end])
		if err = s.saveResearchResult(ctx, scope, key, "research-batch", cp); err != nil {
			return nil, err
		}
	}
	return cp.Ideas, nil
}

// A proved overlap in any batch remains an overlap. A bounded no-overlap
// result requires every batch; a partial/abstract comparison keeps insufficiency.
func mergeResearchNoveltyRows(rows []NoveltyRow) NoveltyRow {
	rank := map[string]int{"not_found": 0, "insufficient": 1, "partial_overlap": 2, "high_overlap": 3}
	out := NoveltyRow{ClaimID: rows[0].ClaimID, Status: rows[0].Status, RelatedWorkIDs: []string{}, EvidenceIDs: []string{}}
	texts := [3][]string{}
	seen := [3]map[string]bool{{}, {}, {}}
	for i, row := range rows {
		if rank[row.Status] > rank[out.Status] {
			out.Status = row.Status
		}
		for _, sid := range row.EvidenceIDs {
			if !containsResearchID(out.EvidenceIDs, sid) {
				out.EvidenceIDs = append(out.EvidenceIDs, sid)
			}
		}
		for _, wid := range row.RelatedWorkIDs {
			if !containsResearchID(out.RelatedWorkIDs, wid) {
				out.RelatedWorkIDs = append(out.RelatedWorkIDs, wid)
			}
		}
		for j, value := range []string{row.Overlap, row.Difference, row.Unverified} {
			if value != "" && !seen[j][value] {
				seen[j][value] = true
				texts[j] = append(texts[j], fmt.Sprintf("批次%d：%s", i+1, value))
			}
		}
	}
	out.Overlap = strings.Join(texts[0], "\n")
	out.Difference = strings.Join(texts[1], "\n")
	out.Unverified = strings.Join(texts[2], "\n")
	return out
}
func (s *Server) checkResearchNoveltyBatches(ctx context.Context, scope researchScope, idea ResearchIdea, evidence []ResearchEvidence, report NoveltyReport, searches []ResearchSearch, queries []ResearchNoveltyQuery, complete, local bool, urlGaps []string) ([]NoveltyRow, error) {
	fragments := researchFragments(evidence)
	out := []NoveltyRow{}
	for _, claim := range idea.Claims {
		key := "batch:novelty:" + idea.ID + ":" + sourceKey(claim.ID)[:16]
		fingerprint := sourceKey(jsonText([]any{claim, fragments, queries, complete, local, urlGaps, "novelty-batch-v1"}))
		cp, err := s.researchBatchCheckpoint(ctx, scope, key, ResearchBatchProgress{Stage: "novelty", IdeaID: idea.ID, ClaimID: claim.ID, Total: len(fragments), Sources: researchBatchSourceProgress(fragments, 0)}, fingerprint)
		if err != nil {
			return nil, err
		}
		for _, row := range cp.Rows {
			part := report
			part.Rows = []NoveltyRow{row}
			if err = validateNoveltyReport(part, evidence, searches); err != nil {
				return nil, err
			}
		}
		if err = s.saveResearchResult(ctx, scope, key, "research-batch", cp); err != nil {
			return nil, err
		}
		for cp.Progress.Done < len(fragments) {
			start := cp.Progress.Done
			// Only the specific claim is needed; the full idea and other claims are not
			// silently compressed into a purported full-text fact.
			target := ResearchIdea{ID: idea.ID, Claims: []ResearchClaim{claim}}
			prompt := func(batch []researchEvidenceFragment) string {
				return researchNoveltyPrompt + "\n这是逐claim分批比较，只判断本批原文片段；not_found仅为批内未找到，Reader在全部批次完成后合并。fragmentFrom/To/Total表示当前片段范围，摘要不能升级为全文。\nRESEARCH_NOVELTY_INPUT_JSON\n" + jsonText(map[string]any{"idea": target, "evidence": batch, "queries": queries, "coverageComplete": complete, "localOnly": local, "requestedSourceGaps": urlGaps})
			}
			end, e := researchBatchEnd(ctx, fragments, start, prompt)
			if e != nil {
				return nil, e
			}
			batch := fragments[start:end]
			allowed := researchAllowedEvidence(evidence, researchBatchSources(batch))
			var result struct {
				Rows []NoveltyRow `json:"rows"`
			}
			validate := func(text string) error {
				if strictToolArguments([]byte(text), &result) != nil || len(result.Rows) != 1 || result.Rows[0].ClaimID != claim.ID {
					return fmt.Errorf("分批主张结果无效")
				}
				if result.Rows[0].Status == "not_found" && !complete {
					return fmt.Errorf("查询覆盖不足不能清除主张")
				}
				part := report
				part.Rows = result.Rows
				return validateNoveltyReport(part, allowed, searches)
			}
			if _, err = s.researchNetworkPlan(ctx, scope, fmt.Sprintf("novelty-batch-model:%s:%s:%d", idea.ID, sourceKey(claim.ID)[:16], start), prompt(batch), validate); err != nil {
				return nil, err
			}
			cp.Rows = append(cp.Rows, result.Rows[0])
			cp.Progress.Done = end
			cp.Progress.CompletedBatches++
			cp.Progress.Sources = researchBatchSourceProgress(fragments, end)
			cp.SourceIDs = researchBatchSources(fragments[:end])
			if err = s.saveResearchResult(ctx, scope, key, "research-batch", cp); err != nil {
				return nil, err
			}
		}
		if len(cp.Rows) == 0 {
			return nil, fmt.Errorf("缺少主张比较证据")
		}
		out = append(out, mergeResearchNoveltyRows(cp.Rows))
	}
	return out, nil
}
