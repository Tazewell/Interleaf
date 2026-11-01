package interleaf

import (
	"database/sql"
	"encoding/json"
	"errors"

	"interleaf.local/server/internal/bibliography"
)

// Additive tables keep imported expressions separate from editable metadata.
// Original input remains available even when an entry is subsequently edited.
func (s *Store) migratePaperBibliography() error {
	_, err := s.DB.Exec(`CREATE TABLE IF NOT EXISTS paper_bibliography_imports(id TEXT PRIMARY KEY,text TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_bibliography(paper_id TEXT PRIMARY KEY REFERENCES paper_items(id) ON DELETE CASCADE,body TEXT NOT NULL);`)
	return err
}

type paperBibRecord struct {
	Entry    bibliography.Entry    `json:"entry"`
	Context  bibliography.Database `json:"context"`
	Baseline PaperItem             `json:"baseline"`
	ParentID string                `json:"parentId,omitempty"`
}

func readPaperBib(q paperQuery, paperID string) (paperBibRecord, bool, error) {
	var raw string
	var record paperBibRecord
	err := q.QueryRow(`SELECT body FROM paper_bibliography WHERE paper_id=?`, paperID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return record, false, nil
	}
	if err != nil {
		return record, false, err
	}
	err = json.Unmarshal([]byte(raw), &record)
	return record, true, err
}
func savePaperBib(tx *sql.Tx, paperID string, record paperBibRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO paper_bibliography(paper_id,body) VALUES(?,?) ON CONFLICT(paper_id) DO UPDATE SET body=excluded.body`, paperID, string(raw))
	return err
}

// Called inside the normal item merge transaction, before deleting its source.
// The selected target remains authoritative; source-only expressions survive.
func mergePaperBibliography(tx *sql.Tx, targetID, sourceID string) error {
	target, hasTarget, err := readPaperBib(tx, targetID)
	if err != nil {
		return err
	}
	source, hasSource, err := readPaperBib(tx, sourceID)
	if err != nil {
		return err
	}
	if hasSource {
		if !hasTarget {
			target = source
		} else {
			context, err := bibCombineContexts(target.Context, source.Context)
			if err != nil {
				return err
			}
			target.Context = context
			for _, field := range source.Entry.Fields {
				if bibGet(target.Entry, field.Name) == "" {
					target.Entry.Fields = append(target.Entry.Fields, field)
				}
			}
			if target.ParentID == "" {
				target.ParentID = source.ParentID
			}
		}
		target.Baseline, err = bibMapped(target.Context, target.Entry)
		if err != nil {
			return err
		}
		if err = savePaperBib(tx, targetID, target); err != nil {
			return err
		}
	}
	// Bind incoming edges to the surviving identity before the source is deleted.
	if _, err = tx.Exec(`UPDATE paper_bibliography SET body=json_set(body,'$.parentId',?) WHERE json_extract(body,'$.parentId')=?`, targetID, sourceID); err != nil {
		return err
	}
	if _, err = bibCollect(tx, []string{targetID}); err != nil {
		return err
	}
	return nil
}
