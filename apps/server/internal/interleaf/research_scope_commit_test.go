package interleaf

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// Diagnostics may contain parser scratch/library paths. Moving a library must
// not make unchanged unavailable content appear to be new research evidence.
func TestResearchUnavailableDiagnosticDoesNotChangeIdentity(t *testing.T) {
	s, topicID, _ := researchFixture(t)
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
	info, err := os.Stat(s.Store.File(d))
	if err != nil {
		t.Fatal(err)
	}
	var revisions []string
	for _, reason := range []string{"open /old/library/cache/doc/corpus.json: permission denied", "open /new/library/cache/doc/corpus.json: permission denied", "parser diagnostic wording changed"} {
		prepared := map[string]researchPreparedDocument{"doc": {Document: d, Hash: "same-original-bytes", Reason: reason, Context: context.Background(), SourceInfo: info, ParserGeneration: s.parserGeneration("doc")}}
		snap, err := s.commitResearchScope(t.Context(), ResearchSnapshot{ID: id(), TopicID: topicID, CreatedAt: now()}, topic, items, prepared)
		if err != nil {
			t.Fatal(err)
		}
		if snap.Members[0].Reason != reason || snap.Members[0].Coverage != "unavailable" {
			t.Fatal("diagnostic lost", snap)
		}
		revisions = append(revisions, snap.Revision)
	}
	if revisions[0] != revisions[1] || revisions[0] != revisions[2] {
		t.Fatal("diagnostic path changed identity", revisions)
	}
	prepared := map[string]researchPreparedDocument{"doc": {Document: d, Hash: "actually-changed-original", Reason: "parser diagnostic wording changed", Context: context.Background(), SourceInfo: info, ParserGeneration: s.parserGeneration("doc")}}
	changed, err := s.commitResearchScope(t.Context(), ResearchSnapshot{ID: id(), TopicID: topicID, CreatedAt: now()}, topic, items, prepared)
	if err != nil || changed.Revision == revisions[0] {
		t.Fatal("real content change ignored", changed, err)
	}
}

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
