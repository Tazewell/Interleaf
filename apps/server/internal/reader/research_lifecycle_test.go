package reader

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"modernc.org/sqlite"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestResearchLifecycleCommitBarrier(t *testing.T) {
	for _, action := range []string{"close", "delete"} {
		t.Run(action, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			var calls atomic.Int32
			block := make(chan struct{})
			researchJobModel(t, s, &calls, block)
			run, _, _ := researchCreateJob(t, s, topic, 200)
			paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
			deadline := time.Now().Add(3 * time.Second)
			for calls.Load() == 0 && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if calls.Load() == 0 {
				close(block)
				t.Fatal("model did not start")
			}
			done := make(chan struct{})
			go func() {
				if action == "close" {
					s.Close()
				} else {
					request(t, s, "DELETE", "/api/documents/doc", nil)
				}
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				close(block)
				t.Fatal("cancel/join deadlock")
			}
			close(block)
			var n int
			if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_reports WHERE run_id=?`, run).Scan(&n); err != nil || n != 0 {
				t.Fatal("canceled run committed", n, err)
			}
		})
	}
}

func TestResearchLifecycleFinalTransactionJoin(t *testing.T) {
	for _, action := range []string{"close", "delete", "migration", "trash", "paper-trash", "pause"} {
		t.Run(action, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			defer once.Do(func() { close(release) })
			fn := "research_barrier_" + id()
			if err := sqlite.RegisterScalarFunction(fn, 0, func(*sqlite.FunctionContext, []driver.Value) (driver.Value, error) {
				close(entered)
				<-release
				return int64(1), nil
			}); err != nil {
				t.Fatal(err)
			}
			s, topic, paper := researchFixture(t)
			var calls atomic.Int32
			researchJobModel(t, s, &calls, nil)
			old, _, _ := researchCreateJob(t, s, topic, 200)
			paperCall(t, s, "POST", "/api/research/runs/"+old+"/start", `{"requestId":"`+id()+`"}`, 202)
			prior := researchWaitJob(t, s, old, "completed")
			if _, err := s.Store.DB.Exec(`CREATE TRIGGER block_research_commit BEFORE INSERT ON research_reports BEGIN SELECT ` + fn + `(); END`); err != nil {
				t.Fatal(err)
			}
			run, _, _ := researchCreateJob(t, s, topic, 200)
			paperCall(t, s, "POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202)
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("final transaction not entered")
			}
			s.researchMu.Lock()
			worker := s.researchWorkers[run]
			s.researchMu.Unlock()
			if worker == nil {
				t.Fatal("worker ownership lost before final transaction")
			}
			ended := make(chan int, 1)
			go func() {
				if action == "delete" {
					ended <- request(t, s, "DELETE", "/api/documents/doc", nil).Code
				} else if action == "trash" {
					ended <- request(t, s, "POST", "/api/documents/doc/trash", nil).Code
				} else if action == "paper-trash" {
					ended <- request(t, s, "POST", "/api/papers/"+paper+"/trash", nil).Code
				} else if action == "pause" {
					ended <- request(t, s, "POST", "/api/research/runs/"+run+"/pause", strings.NewReader(`{"requestId":"`+id()+`"}`)).Code
				} else {
					s.Close()
					ended <- 0
				}
			}()
			select {
			case <-worker.ctx.Done():
			case <-time.After(time.Second):
				once.Do(func() { close(release) })
				<-ended
				t.Fatal("final transaction owner was not canceled before waiting for DB")
			}
			select {
			case <-ended:
				t.Fatal("lifecycle returned before final transaction joined")
			default:
			}
			once.Do(func() { close(release) })
			select {
			case status := <-ended:
				want := map[string]int{"delete": 204, "trash": 200, "paper-trash": 200, "pause": 200, "close": 0, "migration": 0}[action]
				if status != want {
					t.Fatal(status)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("join deadlock")
			}
			var n int
			if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_reports WHERE run_id=?`, run).Scan(&n); err != nil || n != 0 {
				t.Fatal("canceled report survived transaction", n, err)
			}
			var status string
			if err := s.Store.DB.QueryRow(`SELECT status FROM research_runs WHERE id=?`, run).Scan(&status); err != nil {
				t.Fatal(err)
			}
			wantStatus := "interrupted"
			if action == "pause" {
				wantStatus = "paused"
			}
			if status != wantStatus {
				t.Fatalf("lifecycle state %s, want %s", status, wantStatus)
			}
			report, err := readResearchReport(t.Context(), s.Store.DB, prior["latestReportId"].(string))
			if err != nil || report.Content == "" {
				t.Fatal("old report lost", err)
			}
			if action == "migration" {
				root := s.Store.Root
				s.Store.DB.Close()
				dest := filepath.Join(t.TempDir(), "migrated")
				if err := CopyLibrary(root, dest); err != nil {
					t.Fatal(err)
				}
				store, err := OpenStore(dest)
				if err != nil {
					t.Fatal(err)
				}
				defer store.DB.Close()
				migrated := NewServer(store, "test-secret", "")
				defer migrated.Close()
				saved, err := readResearchReport(t.Context(), store.DB, report.ID)
				if err != nil || saved.Content != report.Content {
					t.Fatal("migration lost previous report", err)
				}
				if err = store.DB.QueryRow(`SELECT count(*) FROM research_reports WHERE run_id=?`, run).Scan(&n); err != nil || n != 0 {
					t.Fatal("migration copied late report")
				}
			}
		})
	}
}
func TestResearchLifecyclePageIOJoin(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("required node runtime missing", err)
	}
	for _, action := range []string{"close", "delete", "migration"} {
		t.Run(action, func(t *testing.T) {
			s, topic, paper := researchFixture(t)
			run := researchRunFixture(t, s, topic)
			scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			marker := filepath.Join(dir, "entered")
			script := fmt.Sprintf("import fs from 'node:fs';fs.writeFileSync(%s,'ready');setInterval(()=>{},1000);", jsonText(marker))
			if err = os.WriteFile(filepath.Join(dir, "render-pages.mjs"), []byte(script), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("READER_NODE", node)
			t.Setenv("READER_PROCESSOR", filepath.Join(dir, "main.mjs"))
			w, err := s.registerResearchWorker(scope)
			if err != nil {
				t.Fatal(err)
			}
			readDone := make(chan error, 1)
			go func() {
				defer s.finishResearchWorker(run.ID, w)
				tools, e := s.researchTools(w.ctx, run.ID)
				if e == nil {
					tools.Definitions(true)
					_, e = tools.Call(w.ctx, "read_paper_pages", json.RawMessage(jsonText(map[string]any{"paperId": paper, "pages": []int{1}})))
				}
				readDone <- e
			}()
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				if _, e := os.Stat(marker); e == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
			if _, err = os.Stat(marker); err != nil {
				s.Close()
				t.Fatal("page subprocess did not enter", err)
			}
			if action == "delete" {
				if response := request(t, s, "DELETE", "/api/documents/doc", nil); response.Code != 204 {
					t.Fatal(response.Code)
				}
			} else {
				s.Close()
			}
			select {
			case e := <-readDone:
				if e == nil {
					t.Fatal("canceled page read succeeded")
				}
			default:
				t.Fatal("page subprocess/read not joined")
			}
			var n int
			if e := s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=? AND json_extract(body,'$.kind')='local-page'`, run.ID).Scan(&n); e != nil || n != 0 {
				t.Fatal("unread page saved", n, e)
			}
			files, e := filepath.Glob(filepath.Join(s.Store.Root, "ai-work", "page-images-*"))
			if e != nil || len(files) != 0 {
				t.Fatal("owned temporary images leaked", files, e)
			}
		})
	}
}
