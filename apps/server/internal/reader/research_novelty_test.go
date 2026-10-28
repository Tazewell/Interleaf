package reader

import (
	"context"
	"fmt"
	"net/http"
	"reader.local/server/internal/scholar"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type noveltyClock struct {
	mu    sync.Mutex
	stamp time.Time
}

func (c *noveltyClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.stamp }
func (c *noveltyClock) Sleep(ctx context.Context, d time.Duration) error {
	c.mu.Lock()
	c.stamp = c.stamp.Add(d)
	c.mu.Unlock()
	return ctx.Err()
}
func noveltyFixture(t *testing.T, mode string) (*Server, string, *atomic.Int32) {
	t.Helper()
	s, old, _, hits := remoteFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("model credentials leaked")
		}
		switch r.URL.Path {
		case "/arxiv":
			if mode == "failed" {
				http.Error(w, "private upstream", 400)
				return
			}
			w.Header().Set("Content-Type", "application/atom+xml")
			fmt.Fprint(w, `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>5</opensearch:itemsPerPage></feed>`)
		case "/works":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"ok","message-type":"work-list","message":{"items-per-page":5,"total-results":1,"items":[{"DOI":"10.1000/overlap","title":["Different title B"],"abstract":"Only a summary","URL":"http://paper.example/full"}]}}`)
		case "/large":
			for i := 0; i < 24; i++ {
				fmt.Fprintf(w, "<p>Passage %d: %s</p>", i, strings.Repeat("evidence ", 1000))
			}
		case "/missing":
			http.Error(w, "private upstream", 404)
		case "/explicit":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, researchArticleFixture("Explicit user paper uses uncertainty weighted graph propagation."))
		case "/full":
			if mode == "abstract" {
				http.Error(w, "not available", 404)
				return
			}
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, researchArticleFixture("We implement uncertainty weighted graph propagation with variance weights."))
		default:
			t.Error("unexpected HTTP path", r.URL.Path)
		}
	})
	s.scholar.ArXivAPI = "http://paper.example/arxiv"
	s.scholar.Crossref = "http://paper.example/works"
	clock := &noveltyClock{stamp: time.Now()}
	s.scholar.Public.Clock = clock
	s.scholar.Public.Limiter = scholar.NewSourceLimiter(clock)
	// Fixture's registration run is not part of the accepted worker under test.
	if _, err := s.Store.DB.Exec(`UPDATE research_runs SET status='completed',body=json_set(body,'$.status','completed') WHERE id=?`, old.ID); err != nil {
		t.Fatal(err)
	}
	return s, old.TopicID, hits
}
func TestResearchNoveltyFindsKnownOverlap(t *testing.T) {
	s, topic, hits := noveltyFixture(t, "full")
	var calls atomic.Int32
	ideasModel(t, s, &calls, nil)
	run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "allow-task", IdeaCount: 1})
	done := researchWaitJob(t, s, run, "completed")
	results, err := s.getResearchResults(t.Context(), run)
	if err != nil {
		t.Fatal(err)
	}
	if len(results.Queries) != 6 || len(results.Novelty) != 1 || results.Novelty[0].Rows[0].Status != "high_overlap" || hits.Load() != 7 {
		t.Fatalf("queries/read acquisition not executed: %+v hits=%d", results, hits.Load())
	}
	classes := map[string]bool{}
	sources := map[string]bool{}
	for _, q := range results.Queries {
		classes[q.Kind] = true
		sources[q.Source] = true
		if q.Status != "ok" || q.SearchID == "" || q.FetchedAt == "" || q.Exclusions == nil {
			t.Fatal(q)
		}
	}
	if len(classes) != 3 || !sources["arxiv"] || !sources["crossref"] {
		t.Fatal(classes, sources)
	}
	row := results.Novelty[0].Rows[0]
	ev, err := s.resolveResearchSource(t.Context(), row.EvidenceIDs[0])
	if err != nil || ev.RunID != run || ev.Kind != "remote-html" || !strings.Contains(ev.Excerpt, "uncertainty weighted") {
		t.Fatal(ev, err)
	}
	report := paperCall(t, s, "GET", "/api/research/reports/"+done["latestReportId"].(string), "", 200)
	if !strings.Contains(report["content"].(string), "high_overlap") || !strings.Contains(report["content"].(string), ev.ID) {
		t.Fatal(report)
	}
	// A new explicit novelty run must use fresh public searches, while paper
	// cards remain cached and older report source IDs are revalidated/remapped.
	record, err := readResearchRecord(t.Context(), s.Store.DB, run)
	if err != nil {
		t.Fatal(err)
	}
	second := ideasRun(t, s, topic, record.SessionID, ResearchRunInput{Mode: "novelty", IdeaID: results.Ideas[0].ID, Network: "allow-task"})
	researchWaitJob(t, s, second, "completed")
	if hits.Load() < 13 {
		t.Fatal("new novelty used normal 24h search cache", hits.Load())
	}
}
func TestResearchNoveltyInsufficientEvidence(t *testing.T) {
	for _, mode := range []string{"abstract", "failed"} {
		t.Run(mode, func(t *testing.T) {
			s, topic, _ := noveltyFixture(t, mode)
			var calls atomic.Int32
			ideasModel(t, s, &calls, nil)
			run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "allow-task", IdeaCount: 1})
			researchWaitJob(t, s, run, "completed")
			result, err := s.getResearchResults(t.Context(), run)
			if err != nil {
				t.Fatal(err)
			}
			row := result.Novelty[0].Rows[0]
			if mode == "abstract" && row.Status != "insufficient" {
				t.Fatal(row)
			}
			if row.Status == "not_found" {
				t.Fatal("failed/abstract acquisition cleared claim")
			}
			if len(result.Novelty[0].Caveats) < 2 {
				t.Fatal("coverage gap hidden")
			}
		})
	}
}
func TestResearchNoveltyBudgetRetainsQueries(t *testing.T) {
	s, topic, hits := noveltyFixture(t, "full")
	var calls atomic.Int32
	ideasModel(t, s, &calls, nil)
	run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "allow-task", IdeaCount: 1, Budget: ResearchBudget{MaxSearchRequests: 1}})
	researchWaitJob(t, s, run, "paused")
	raw := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
	if len(raw["ideas"].([]any)) != 1 || len(raw["pendingIdeaIds"].([]any)) != 1 || len(raw["queries"].([]any)) != 6 || len(raw["novelty"].([]any)) != 0 {
		t.Fatal(raw)
	}
	result, _ := s.getResearchResults(t.Context(), run)
	stamp := result.Queries[0].FetchedAt
	if stamp == "" || result.Queries[1].Status != "pending" {
		t.Fatal(result)
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`","budget":{"maxModelRequests":200,"maxSearchRequests":24,"maxRemoteReads":8,"maxMinutes":30}}`, 202)
	researchWaitJob(t, s, run, "completed")
	result, _ = s.getResearchResults(t.Context(), run)
	if result.Queries[0].FetchedAt != stamp || hits.Load() != 7 {
		t.Fatal("resume replayed completed query", result, hits.Load())
	}
}
func TestResearchNoveltyRejectsInvalidClaims(t *testing.T) {
	ev := ResearchEvidence{ID: "e1", CandidateID: "b", Kind: "remote-html", Location: []byte(`{"contentLevel":"fulltext","qualification":"dom-body-v1"}`), Availability: "valid"}
	searches := []ResearchSearch{}
	ids := []string{}
	for i := 0; i < 6; i++ {
		sid := fmt.Sprint(i)
		ids = append(ids, sid)
		searches = append(searches, ResearchSearch{ID: sid, Source: []string{"arxiv", "crossref"}[i%2], Status: "ok"})
	}
	base := NoveltyReport{IdeaID: "idea", AsOf: now(), QueryIDs: ids, Rows: []NoveltyRow{{ClaimID: "method", Status: "high_overlap", RelatedWorkIDs: []string{"b"}, EvidenceIDs: []string{"e1"}, Overlap: "Same mechanism", Unverified: "Other conditions untested"}}}
	if err := validateNoveltyReport(base, []ResearchEvidence{ev}, searches); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"unread", "abstract", "absolute", "probability", "failed", "unexecuted"} {
		t.Run(kind, func(t *testing.T) {
			v := base
			v.Rows = append([]NoveltyRow{}, base.Rows...)
			es := []ResearchEvidence{ev}
			ss := append([]ResearchSearch{}, searches...)
			switch kind {
			case "unread":
				v.Rows[0].EvidenceIDs = []string{"forged"}
			case "abstract":
				es[0].Kind = "remote-abstract"
			case "absolute":
				v.Rows[0].Difference = "绝对原创"
			case "probability":
				v.Rows[0].Difference = "Novelty probability 98%"
			case "failed":
				v.Rows[0].Status = "not_found"
				ss[0].Status = "failed"
			case "unexecuted":
				v.Rows[0].Status = "not_found"
				v.QueryIDs = v.QueryIDs[:2]
			}
			if validateNoveltyReport(v, es, ss) == nil {
				t.Fatal("unsafe success accepted", kind)
			}
		})
	}
}

func TestResearchNoveltyNotFoundRequiresReadFulltext(t *testing.T) {
	queries := []ResearchSearch{}
	ids := []string{}
	for i := 0; i < 6; i++ {
		sid := fmt.Sprint(i)
		ids = append(ids, sid)
		queries = append(queries, ResearchSearch{ID: sid, Source: []string{"arxiv", "crossref"}[i%2], Status: "ok"})
	}
	report := NoveltyReport{IdeaID: "idea", AsOf: now(), QueryIDs: ids, Rows: []NoveltyRow{{ClaimID: "method", Status: "not_found", Unverified: "Only searched the plan"}}}
	if validateNoveltyReport(report, []ResearchEvidence{{ID: "a", Kind: "remote-abstract", Availability: "valid"}}, queries) == nil {
		t.Fatal("abstract-only evidence cleared a method claim")
	}
}

func TestResearchNoveltyInvalidModelDoesNotPublish(t *testing.T) {
	for _, kind := range []string{"failed-not-found", "unread", "absolute"} {
		t.Run(kind, func(t *testing.T) {
			s, topic, _ := noveltyFixture(t, "failed")
			var calls atomic.Int32
			ideasModel(t, s, &calls, nil, func(row *NoveltyRow) {
				switch kind {
				case "failed-not-found":
					row.Status = "not_found"
				case "unread":
					row.EvidenceIDs = []string{"ffffffffffffffffffffffffffffffff"}
				case "absolute":
					row.Difference = "绝对原创"
				}
			})
			run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "allow-task", IdeaCount: 1})
			waitIdeasFailure(t, s, run)
			out := paperCall(t, s, "GET", "/api/research/runs/"+run+"/results", "", 200)
			if len(out["ideas"].([]any)) != 1 || len(out["novelty"].([]any)) != 0 || len(out["pendingIdeaIds"].([]any)) != 1 {
				t.Fatal(out)
			}
			var n int
			if err := s.Store.DB.QueryRow(`SELECT count(*) FROM research_reports WHERE run_id=?`, run).Scan(&n); err != nil || n != 0 {
				t.Fatal("invalid report saved", n, err)
			}
		})
	}
}

func TestResearchNoveltyExplicitUserURLs(t *testing.T) {
	for _, mode := range []string{"ideas", "novelty"} {
		for _, missing := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/missing=%v", mode, missing), func(t *testing.T) {
				s, topic, _ := noveltyFixture(t, "full")
				var calls atomic.Int32
				ideasModel(t, s, &calls, nil)
				first := ideasRun(t, s, topic, "", ResearchRunInput{IdeaCount: 1})
				researchWaitJob(t, s, first, "completed")
				r, _ := readResearchRecord(t.Context(), s.Store.DB, first)
				prior, _ := s.getResearchResults(t.Context(), first)
				raw := "http://paper.example/explicit"
				if missing {
					raw = "http://paper.example/missing?signature=PRIVATE"
				}
				input := ResearchRunInput{Mode: mode, IdeaCount: 1, Network: "allow-task", URLs: []string{raw}}
				if mode == "novelty" {
					input.IdeaID = prior.Ideas[0].ID
				}
				run := ideasRun(t, s, topic, r.SessionID, input)
				done := researchWaitJob(t, s, run, "completed")
				var cid string
				if err := s.Store.DB.QueryRow(`SELECT id FROM research_candidates WHERE topic_id=? AND identity_key=?`, topic, "url:"+sourceKey(raw)).Scan(&cid); err != nil {
					t.Fatal("explicit authorized URL ignored", err)
				}
				var count int
				s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=? AND candidate_id=?`, run, cid).Scan(&count)
				result, _ := s.getResearchResults(t.Context(), run)
				if !missing && count == 0 {
					t.Fatal("explicit candidate was not read")
				}
				if missing {
					if !strings.Contains(strings.Join(result.Novelty[0].Caveats, " "), "用户指定") {
						t.Fatal("explicit failure hidden", result)
					}
					report := paperCall(t, s, "GET", "/api/research/reports/"+done["latestReportId"].(string), "", 200)
					if strings.Contains(report["content"].(string), "PRIVATE") {
						t.Fatal("private URL leaked")
					}
				}
				var searches int
				s.Store.DB.QueryRow(`SELECT count(*) FROM research_searches WHERE run_id=?`, run).Scan(&searches)
				if searches != 6 {
					t.Fatal("extra generic search", searches)
				}
				before := calls.Load()
				input.UserMessageID = id()
				input.Network = "deny"
				paperCall(t, s, "POST", "/api/research/topics/"+topic+"/sessions/"+r.SessionID+"/runs", jsonText(input), 400)
				if calls.Load() != before {
					t.Fatal("denied URL made model request")
				}
			})
		}
	}
}

func TestResearchNoveltyExplicitURLBudgetDoesNotSkip(t *testing.T) {
	s, topic, hits := noveltyFixture(t, "full")
	var calls atomic.Int32
	ideasModel(t, s, &calls, nil)
	run := ideasRun(t, s, topic, "", ResearchRunInput{Network: "allow-task", IdeaCount: 1, URLs: []string{"http://paper.example/explicit", "http://paper.example/full"}, Budget: ResearchBudget{MaxRemoteReads: 1}})
	researchWaitJob(t, s, run, "paused")
	out, _ := s.getResearchResults(t.Context(), run)
	if len(out.Ideas) != 0 || hits.Load() != 1 {
		t.Fatal("budget skipped explicit read", out, hits.Load())
	}
	paperCall(t, s, "POST", "/api/research/runs/"+run+"/resume", `{"requestId":"`+id()+`","budget":{"maxModelRequests":200,"maxSearchRequests":24,"maxRemoteReads":8,"maxMinutes":30}}`, 202)
	researchWaitJob(t, s, run, "completed")
	if hits.Load() != 9 {
		t.Fatal("resume repeated explicit successful read", hits.Load())
	}
}
