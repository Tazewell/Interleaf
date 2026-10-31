package interleaf

import (
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var citationKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_:.\-]{1,128}$`)
var citationASCII = regexp.MustCompile(`[^A-Za-z0-9]+`)

func reserveCitationKey(tx *sql.Tx, paperID, key string) error {
	if !citationKeyPattern.MatchString(key) {
		return errors.New("引用键须为 1–128 个 ASCII 字母、数字、下划线、连字符、冒号或句点")
	}
	var owner string
	err := tx.QueryRow(`SELECT paper_id FROM paper_citation_keys WHERE key=? COLLATE NOCASE`, key).Scan(&owner)
	if err == nil {
		if owner != paperID {
			return paperConflict("引用键已使用，不能重新分配")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = tx.Exec(`INSERT INTO paper_citation_keys(key,paper_id) VALUES(?,?)`, key, paperID)
	return err
}
func citationBase(p PaperItem) string {
	author := ""
	if len(p.Metadata.Creators) > 0 {
		author = p.Metadata.Creators[0].Family
		if author == "" {
			author = p.Metadata.Creators[0].Name
		}
	}
	if author == "" {
		parts := strings.Fields(p.Author)
		if len(parts) > 0 {
			author = parts[len(parts)-1]
		}
	}
	author = citationASCII.ReplaceAllString(author, "")
	year := p.Metadata.Date
	if len(year) > 4 {
		year = year[:4]
	}
	title := ""
	for _, word := range strings.Fields(p.Title) {
		word = citationASCII.ReplaceAllString(word, "")
		if word != "" {
			title = word
			break
		}
	}
	if author == "" || year == "" || title == "" {
		suffix := p.ID
		if len(suffix) > 12 {
			suffix = suffix[:12]
		}
		return "ref-" + suffix
	}
	base := author + year + title
	if len(base) > 110 {
		base = base[:110]
	}
	return base
}
func (s *Store) EnsureCitationKeys(ids []string) ([]PaperItem, error) {
	if len(ids) == 0 || len(ids) > 10000 {
		return nil, errors.New("请选择 1–10000 篇文献")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Read every requested ID before assigning anything, and make an initially
	// unallocated batch deterministic regardless of its presentation order.
	papers := map[string]PaperItem{}
	order := []string{}
	for _, id := range ids {
		p, e := readPaper(tx, id)
		if e != nil {
			return nil, e
		}
		papers[p.ID] = p
		order = append(order, p.ID)
	}
	sorted := []string{}
	for id := range papers {
		sorted = append(sorted, id)
	}
	sort.Strings(sorted)
	for _, id := range sorted {
		p := papers[id]
		if p.CitationKey != "" {
			continue
		}
		base := citationBase(p)
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
				return nil, err
			}
			p.CitationKey = key
			break
		}
		if _, err = tx.Exec(`UPDATE paper_items SET citation_key=? WHERE id=?`, p.CitationKey, p.ID); err != nil {
			return nil, err
		}
		papers[id] = p
	}
	out := []PaperItem{}
	for _, id := range order {
		out = append(out, papers[id])
	}
	return out, tx.Commit()
}
