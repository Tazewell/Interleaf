package interleaf

import (
	"encoding/json"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"
)

func researchCompletedReport(t *testing.T, s *Server, topic string) ResearchReport {
	t.Helper()
	run, _, _ := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	done := researchWaitJob(t, s, run, "completed")
	report, err := readResearchReport(t.Context(), s.Store.DB, done["latestReportId"].(string))
	if err != nil || len(report.SourceIDs) == 0 {
		t.Fatal("missing sourced report", report, err)
	}
	return report
}

func TestResearchUserReportHistoricalRevision(t *testing.T) {
	for _, change := range []string{"stale", "trash", "removed"} {
		t.Run(change, func(t *testing.T) {
			s, topic, paper := researchFixture(t)
			var calls atomic.Int32
			researchJobModel(t, s, &calls, nil)
			original := researchCompletedReport(t, s, topic)
			prior, err := s.createResearchReportRevision(t.Context(), original.ID, id(), "Existing user text")
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "stale":
				paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"title":"Changed source"}`, 200)
			case "trash":
				paperCall(t, s, "POST", "/api/documents/doc/trash", `{}`, 200)
			case "removed":
				if response := request(t, s, "DELETE", "/api/documents/doc", nil); response.Code != 204 {
					t.Fatal(response.Code)
				}
			}
			beforeCalls := calls.Load()
			source := original.SourceIDs[0]
			var evidenceBefore string
			if err = s.Store.DB.QueryRow(`SELECT body FROM research_evidence WHERE id=?`, source).Scan(&evidenceBefore); err != nil {
				t.Fatal(err)
			}
			var ev ResearchEvidence
			if err = json.Unmarshal([]byte(evidenceBefore), &ev); err != nil {
				t.Fatal(err)
			}
			expected := "stale"
			if change == "removed" {
				expected = "removed"
			}
			if ev.Availability != expected {
				t.Fatal("invalidation path failed", ev.Availability)
			}
			if change == "removed" && (ev.Excerpt != "" || string(ev.Location) != "null") {
				t.Fatal("removed payload retained", ev)
			}
			for _, parent := range []ResearchReport{original, prior} {
				requestID := id()
				body := jsonText(map[string]string{"requestId": requestID, "content": "Edited history [unknown-source]"})
				path := "/api/research/reports/" + parent.ID + "/revisions"
				response := paperCall(t, s, "POST", path, body, 201)
				saved, err := readResearchReport(t.Context(), s.Store.DB, response["id"].(string))
				if err != nil {
					t.Fatal(err)
				}
				if saved.Origin != "user" || saved.RunID != "" || saved.SourceRunID != original.SourceRunID || saved.DerivedFromID != parent.ID || saved.SourceRevision != original.SourceRevision || saved.TopicID != parent.TopicID || saved.SessionID != parent.SessionID || !saved.Stale || !reflect.DeepEqual(saved.SourceIDs, parent.SourceIDs) {
					t.Fatal("history identity changed", saved)
				}
				if repeat := paperCall(t, s, "POST", path, body, 201); repeat["id"] != saved.ID {
					t.Fatal("retry created revision")
				}
				paperCall(t, s, "POST", path, jsonText(map[string]string{"requestId": requestID, "content": "different"}), 409)
				old, err := readResearchReport(t.Context(), s.Store.DB, parent.ID)
				if err != nil || old.Content != parent.Content || old.Revision != parent.Revision || !old.Stale {
					t.Fatal("old history changed", old, err)
				}
			}
			var evidenceAfter string
			if err = s.Store.DB.QueryRow(`SELECT body FROM research_evidence WHERE id=?`, source).Scan(&evidenceAfter); err != nil || evidenceAfter != evidenceBefore {
				t.Fatal("historical edit changed evidence", err)
			}
			paperCall(t, s, "GET", "/api/research/sources/"+source, "", 409)
			tx, err := s.Store.DB.BeginTx(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			model := original
			model.ID = id()
			if err = writeResearchReport(t.Context(), tx, model, ""); !errors.Is(err, errResearchScopeChanged) {
				tx.Rollback()
				t.Fatal("new model report accepted invalid evidence")
			}
			tx.Rollback()
			if calls.Load() != beforeCalls {
				t.Fatal("history edit called model")
			}
		})
	}
}

func TestResearchUserReportHistoricalOwnerTampering(t *testing.T) {
	s, topic, paper := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	original := researchCompletedReport(t, s, topic)
	otherTopic := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Other","folder":"ML"}`, 201)["id"].(string)
	other := researchCompletedReport(t, s, otherTopic)
	paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"title":"Invalidated"}`, 200)
	parent, err := readResearchReport(t.Context(), s.Store.DB, original.ID)
	if err != nil {
		t.Fatal(err)
	}
	otherSnapshot := researchSnapshot(t, s, topic)
	for _, field := range []string{"parent", "run", "topic", "session", "snapshot", "source", "source-body", "stale", "source-revision"} {
		t.Run(field, func(t *testing.T) {
			tx, err := s.Store.DB.BeginTx(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			r := parent
			r.ID = id()
			r.RunID = ""
			r.Origin = "user"
			r.DerivedFromID = parent.ID
			r.Content = "edit"
			r.Revision = sourceKey(r.Content)
			switch field {
			case "parent":
				r.DerivedFromID = other.ID
			case "run":
				r.SourceRunID = other.SourceRunID
			case "topic":
				r.TopicID = other.TopicID
			case "session":
				r.SessionID = other.SessionID
			case "source":
				r.SourceIDs = other.SourceIDs
			case "stale":
				r.Stale = false
			case "source-revision":
				r.SourceRevision = "other"
			case "snapshot":
				_, err = tx.Exec(`UPDATE research_evidence SET snapshot_id=?,body=json_set(body,'$.snapshotId',?) WHERE id=?`, otherSnapshot.ID, otherSnapshot.ID, r.SourceIDs[0])
			case "source-body":
				_, err = tx.Exec(`UPDATE research_evidence SET body=json_set(body,'$.runId',?) WHERE id=?`, other.SourceRunID, r.SourceIDs[0])
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = writeResearchReport(t.Context(), tx, r, id()); err == nil {
				t.Fatal("historical writer accepted tampered " + field)
			}
		})
	}
}
