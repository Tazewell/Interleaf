package reader

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// Exercise the real prepare/commit boundary deterministically: application
// publishing may happen after expensive source verification, before the Tx.
func TestResearchScopeCommitRejectsCorpusAndParserReplacement(t *testing.T) {
	for _, replacement := range []string{"corpus-revision", "corpus-fingerprint", "parser"} {
		t.Run(replacement, func(t *testing.T) {
			s, topicID, _ := researchFixture(t)
			snap := researchSnapshot(t, s, topicID)
			tx, err := s.Store.DB.Begin()
			if err != nil {
				t.Fatal(err)
			}
			topic, items, err := readResearchScope(tx, topicID)
			tx.Rollback()
			if err != nil {
				t.Fatal(err)
			}
			d, err := s.Store.Document("doc")
			if err != nil {
				t.Fatal(err)
			}
			corpus, err := s.documentCorpus(t.Context(), "doc", nil)
			if err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(s.Store.File(d))
			if err != nil {
				t.Fatal(err)
			}
			prepared := map[string]researchPreparedDocument{"doc": {Document: d, Hash: snap.Members[0].SourceHash, Revision: corpus.Revision, Fingerprint: corpus.Fingerprint, Context: context.Background(), SourceInfo: info, ParserGeneration: s.parserGeneration("doc")}}
			if replacement == "corpus-revision" {
				if _, err = s.Store.DB.Exec(`UPDATE document_corpora SET revision='published-new-revision',body=json_set(body,'$.corpusRevision','published-new-revision') WHERE document_id='doc'`); err != nil {
					t.Fatal(err)
				}
			} else if replacement == "corpus-fingerprint" {
				if _, err = s.Store.DB.Exec(`UPDATE document_corpora SET fingerprint='new-fingerprint' WHERE document_id='doc'`); err != nil {
					t.Fatal(err)
				}
			} else {
				// This is an application publication, not an external file-stat spoof.
				work := t.TempDir()
				raw, err := os.ReadFile(filepath.Join(s.analysisDir("doc"), "manifest.json"))
				if err != nil {
					t.Fatal(err)
				}
				var layout map[string]any
				if err = json.Unmarshal(raw, &layout); err != nil {
					t.Fatal(err)
				}
				for _, block := range layout["blocks"].([]any) {
					delete(block.(map[string]any), "image")
				}
				raw, _ = json.Marshal(layout)
				if err = os.WriteFile(filepath.Join(work, "manifest.json"), raw, 0600); err != nil {
					t.Fatal(err)
				}
				if err = s.mergeLayout("doc", work); err != nil {
					t.Fatal(err)
				}
			}
			snap.ID = id()
			if _, err = s.commitResearchScope(t.Context(), snap, topic, items, prepared); !errors.Is(err, errResearchScopeChanged) {
				t.Fatalf("committed stale %s preparation: %v", replacement, err)
			}
			var n int
			if err = s.Store.DB.QueryRow(`SELECT count(*) FROM research_snapshots WHERE id=?`, snap.ID).Scan(&n); err != nil || n != 0 {
				t.Fatal("obsolete snapshot saved", n, err)
			}
		})
	}
}
