package reader

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// A public 404 checkpoint must not mask an explicitly imported original, or
// turn a current local identity/deletion error into ordinary remote absence.
func TestResearchNetworkReadFailureAfterExplicitImport(t *testing.T) {
	remoteRealProcessor(t)
	for _, action := range []string{"readable", "identity", "removed-file", "trashed"} {
		t.Run(action, func(t *testing.T) {
			var requests atomic.Int32
			s, run, candidate, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if requests.Add(1) == 1 {
					http.Error(w, "missing", http.StatusNotFound)
					return
				}
				w.Header().Set("Content-Type", "application/pdf")
				w.Write(remotePDFBytes())
			})
			candidate.Abstract, candidate.PDFURL = "", "http://paper.example/import.pdf"
			remoteRegister(t, s, run, candidate)
			tools, err := s.researchTools(t.Context(), run.ID)
			if err != nil {
				t.Fatal(err)
			}
			args := json.RawMessage(jsonText(map[string]string{"candidateId": candidate.ID}))
			first, err := tools.Call(t.Context(), "read_online_paper", args)
			if err != nil || !strings.Contains(string(first.Content), `"unavailable":true`) {
				t.Fatal("initial missing read", string(first.Content), err)
			}
			scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			_, version, err := readResearchRegisteredCandidate(t.Context(), s.Store.DB, scope, candidate.ID)
			if err != nil {
				t.Fatal(err)
			}
			key := missingResearchReadKey(candidate.ID, version)
			history, err := readResearchUnit(t.Context(), s.Store.DB, run.ID, key)
			if err != nil {
				t.Fatal(err)
			}
			caveats, err := s.researchSearchCaveats(t.Context(), run.ID)
			if err != nil || !strings.Contains(caveats, "在线读取不足") {
				t.Fatal("missing initial caveat", caveats, err)
			}
			report := ResearchReport{ID: id(), TopicID: run.TopicID, SessionID: run.SessionID, RunID: run.ID, SourceRunID: run.ID, Origin: "model", Content: caveats, SourceIDs: []string{}, Revision: "historical", CreatedAt: now()}
			if _, err = s.Store.DB.Exec(`INSERT INTO research_reports(id,topic_id,session_id,run_id,revision,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, report.ID, report.TopicID, report.SessionID, report.RunID, report.Revision, jsonText(report), now(), now()); err != nil {
				t.Fatal(err)
			}
			imported, err := s.importResearchCandidate(t.Context(), run.TopicID, candidate.ID, id())
			if err != nil {
				t.Fatal("explicit import", err)
			}
			// The import transaction and PDF text worker are real. Supply only the
			// trusted completed-layout fixture, as researchFixture does.
			hash, err := researchFileHash(t.Context(), s.Store.File(imported))
			if err != nil {
				t.Fatal(err)
			}
			manifest := map[string]any{"inputSHA256": hash, "pages": 1, "blocks": []PDFBlock{{ID: "p1-b1", Page: 1, Label: "text", Text: "Verified remote PDF text."}}}
			if err = os.MkdirAll(s.analysisDir(imported.ID), 0700); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(s.analysisDir(imported.ID), "manifest.json"), []byte(jsonText(manifest)), 0600); err != nil {
				t.Fatal(err)
			}
			current, after, err := readResearchRegisteredCandidate(t.Context(), s.Store.DB, scope, candidate.ID)
			if err != nil || version != after || current.DocumentID != imported.ID {
				t.Fatal("mapping changed remote version or was not committed", current, version, after, err)
			}
			switch action {
			case "identity":
				_, err = s.Store.DB.Exec(`UPDATE paper_attachments SET paper_id=(SELECT paper_id FROM paper_attachments WHERE document_id='doc') WHERE document_id=?`, imported.ID)
			case "removed-file":
				err = os.Remove(s.Store.File(imported))
			case "trashed":
				if _, code, message := s.moveToTrash(t.Context(), imported.ID); message != "" {
					t.Fatal(code, message)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			// Recreate the toolset to exercise durable same-run resume rather than
			// relying on in-memory state or a direct-read cache priming call.
			resumed, err := s.researchTools(t.Context(), run.ID)
			if err != nil {
				t.Fatal(err)
			}
			replay, readErr := resumed.Call(t.Context(), "read_online_paper", args)
			if action == "readable" {
				if readErr != nil || !strings.Contains(string(replay.Content), `"kind":"local-passage"`) || strings.Contains(string(replay.Content), `"unavailable":true`) {
					t.Error("negative checkpoint hid imported original", string(replay.Content), readErr)
				}
				caveats, e := s.researchSearchCaveats(t.Context(), run.ID)
				if e != nil || strings.Contains(caveats, "在线读取不足") {
					t.Error("old failure still presented as current after local success", caveats, e)
				}
				again, e := tools.Call(t.Context(), "read_online_paper", args)
				if e != nil || string(again.Content) != string(replay.Content) {
					t.Error("same-run local evidence was not reusable", string(again.Content), e)
				}
				oldReport, e := readResearchReport(t.Context(), s.Store.DB, report.ID)
				if e != nil || jsonText(oldReport) != jsonText(report) {
					t.Error("historical report changed", oldReport, e)
				}
			} else if readErr == nil {
				t.Error("negative checkpoint swallowed local source error", string(replay.Content))
			}
			if hits.Load() != 2 {
				t.Error("local read retried public HTTP", hits.Load())
			}
			preserved, err := readResearchUnit(t.Context(), s.Store.DB, run.ID, key)
			if err != nil || jsonText(preserved) != jsonText(history) {
				t.Error("historical failure checkpoint changed", preserved, err)
			}
		})
	}
}
