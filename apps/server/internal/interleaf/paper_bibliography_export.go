package interleaf

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"

	"interleaf.local/server/internal/bibliography"
)

type bibCollected struct {
	paper  PaperItem
	record paperBibRecord
	raw    bool
}

func bibCollect(tx *sql.Tx, ids []string) ([]bibCollected, error) {
	out := []bibCollected{}
	state := map[string]int{}
	var visit func(string, int) error
	visit = func(id string, depth int) error {
		if depth > 128 {
			return paperConflict("crossref 依赖嵌套过深")
		}
		p, err := readPaper(tx, id)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return paperConflict("缺少 crossref 依赖或文献：" + id)
			}
			return err
		}
		if p.DeletedAt != "" {
			return paperConflict("crossref 依赖或文献已在回收站：" + p.Title)
		}
		if state[p.ID] == 1 {
			return paperConflict("crossref 循环依赖：" + p.CitationKey)
		}
		if state[p.ID] == 2 {
			return nil
		}
		state[p.ID] = 1
		record, raw, err := readPaperBib(tx, p.ID)
		if err != nil {
			return err
		}
		if record.ParentID != "" {
			parent, err := readPaper(tx, record.ParentID)
			if err != nil {
				return paperConflict("缺少 crossref 依赖：" + record.ParentID)
			}
			record.ParentID = parent.ID
		}
		// Put children before parents, as required by classic BibTeX crossref lookup.
		out = append(out, bibCollected{paper: p, record: record, raw: raw})
		if record.ParentID != "" {
			if err = visit(record.ParentID, depth+1); err != nil {
				return err
			}
		}
		state[p.ID] = 2
		return nil
	}
	for _, id := range ids {
		if err := visit(id, 0); err != nil {
			return nil, err
		}
	}
	// A parent explicitly selected first still has to follow all of its children.
	// Stable dependency sorting also makes an equivalent selected set deterministic.
	sort.SliceStable(out, func(i, j int) bool { return out[i].paper.ID < out[j].paper.ID })
	ordered := []bibCollected{}
	placed := map[string]bool{}
	for len(ordered) < len(out) {
		progress := false
		for _, item := range out {
			if placed[item.paper.ID] {
				continue
			}
			needed := false
			for _, child := range out {
				if !placed[child.paper.ID] && child.record.ParentID == item.paper.ID {
					needed = true
				}
			}
			if !needed {
				ordered = append(ordered, item)
				placed[item.paper.ID] = true
				progress = true
			}
		}
		if !progress {
			return nil, paperConflict("crossref 循环依赖")
		}
	}
	return ordered, nil
}

// Bibliography is shared by downloads, copies and managed export targets.
// It allocates persisted keys and reads all dependencies in one transaction.
func (s *Store) Bibliography(ids []string, mode string) (string, error) {
	if mode != "bibtex" && mode != "biblatex" {
		return "", errors.New("导出模式须为 bibtex 或 biblatex")
	}
	if len(ids) > 10000 {
		return "", errors.New("请选择 1–10000 篇文献")
	}
	if len(ids) == 0 {
		return "", nil
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	items, err := bibCollect(tx, ids)
	if err != nil {
		return "", err
	}
	// Allocate in identity order so presentation order cannot affect fresh keys.
	order := make([]int, len(items))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(i, j int) bool { return items[order[i]].paper.ID < items[order[j]].paper.ID })
	for _, index := range order {
		p := &items[index].paper
		if p.CitationKey != "" {
			continue
		}
		base := citationBase(*p)
		for n := 0; ; n++ {
			key := base
			if n > 0 {
				key = fmt.Sprintf("%s-%d", base, n+1)
			}
			err = reserveCitationKey(tx, p.ID, key)
			if errors.Is(err, errPaperConflict) {
				continue
			}
			if err != nil {
				return "", err
			}
			p.CitationKey = key
			break
		}
		if _, err = tx.Exec(`UPDATE paper_items SET citation_key=? WHERE id=?`, p.CitationKey, p.ID); err != nil {
			return "", err
		}
	}
	keys := map[string]string{}
	for _, item := range items {
		keys[item.paper.ID] = item.paper.CitationKey
	}
	db := bibliography.Database{Entries: []bibliography.Entry{}}
	for _, item := range items {
		if item.raw {
			if err := bibValidateEprint(item.paper, item.record); err != nil {
				return "", err
			}
		}
		combined, err := bibCombineContexts(db, item.record.Context)
		if err != nil {
			return "", err
		}
		db.Strings, db.Preambles = combined.Strings, combined.Preambles
		entry := bibEntry(item.paper, item.record, item.raw, mode)
		if item.record.ParentID != "" {
			parent, err := readPaper(tx, item.record.ParentID)
			if err != nil {
				return "", err
			}
			key := keys[parent.ID]
			if key == "" {
				return "", paperConflict("缺少 crossref 依赖")
			}
			old, err := item.record.Context.Value(item.record.Entry, "crossref")
			if err != nil {
				return "", err
			}
			if old != key {
				bibSet(&entry, "crossref", "{"+key+"}")
			}
		}
		db.Entries = append(db.Entries, entry)
	}
	// Ensure deterministic sorting when no crossref ordering constrains the result.
	text, err := bibliography.Render(db)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(text) == "" {
		return "", errors.New("参考文献为空")
	}
	if err = tx.Commit(); err != nil {
		return "", err
	}
	return text, nil
}
