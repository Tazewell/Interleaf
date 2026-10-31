package interleaf

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestResearchMarkdownLocalProvenanceAndHistoricalDeletion(t *testing.T) {
	s, topic, paper := researchFixture(t)
	var calls atomic.Int32
	researchJobModel(t, s, &calls, nil)
	run, _, _ := researchCreateJob(t, s, topic, 200)
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
	done := researchWaitJob(t, s, run, "completed")
	report, err := readResearchReport(t.Context(), s.Store.DB, done["latestReportId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	for _, removed := range []bool{false, true} {
		if removed {
			paperCall(t, s, "POST", "/api/papers/"+paper+"/trash", `{}`, 200)
		}
		var before, after int
		s.Store.DB.QueryRow(`SELECT total_changes()`).Scan(&before)
		res := request(t, s, "GET", "/api/research/reports/"+report.ID+"/markdown", nil)
		s.Store.DB.QueryRow(`SELECT total_changes()`).Scan(&after)
		text := res.Body.String()
		if res.Code != 200 || before != after || calls.Load() != 2 {
			t.Fatal("export performed writes/I/O", res.Code, before, after, calls.Load())
		}
		if !strings.Contains(text, "Stable2026") || !strings.Contains(text, "source-"+report.SourceIDs[0]) || !strings.Contains(text, "Measured result") {
			t.Fatal("missing usable provenance", text)
		}
		if !removed && !strings.Contains(text, "PDF 第 1 页") {
			t.Fatal("missing native position", text)
		}
		if removed && !strings.Contains(text, "已失效或删除") {
			t.Fatal("missing historical marker", text)
		}
	}
}

func TestResearchMarkdownRemoteProvenanceNoFetch(t *testing.T) {
	s, run, c, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<p>Public evidence.</p>") })
	evs, err := s.readResearchRemote(t.Context(), run.ID, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	report := ResearchReport{ID: id(), TopicID: run.TopicID, SessionID: run.SessionID, RunID: run.ID, SourceRunID: run.ID, Kind: "question", Revision: "report", SourceRevision: run.Revision, Origin: "model", Content: "Fact [" + evs[0].ID + "] ![unsafe](https://host/img)", SourceIDs: []string{evs[0].ID}, CreatedAt: now()}
	scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	err = s.commitResearchRead(context.Background(), scope, nil, true, func(tx *sql.Tx) error { return writeResearchReport(t.Context(), tx, report, "") })
	if err != nil {
		t.Fatal(err)
	}
	text := request(t, s, "GET", "/api/research/reports/"+report.ID+"/markdown", nil).Body.String()
	for _, want := range []string{"[公开来源](http://paper.example/page)", "10.1234/remote", "Public evidence.", "获取时间", "resourceHash", "source-" + evs[0].ID} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %s: %s", want, text)
		}
	}
	if hits.Load() != 1 || strings.Contains(text, "![unsafe](") {
		t.Fatal("unsafe export", text, hits.Load())
	}
}
