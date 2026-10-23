package reader

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func researchRunFixture(t *testing.T, s *Server, topic string) ResearchRun {
	t.Helper()
	snap := researchSnapshot(t, s, topic)
	session, err := s.Store.CreateResearchSession(t.Context(), topic, ResearchSessionInput{Title: "test"})
	if err != nil {
		t.Fatal(err)
	}
	run := ResearchRun{ID: id(), TopicID: topic, SessionID: session.ID, UserMessageID: id(), SnapshotID: snap.ID, Revision: snap.Revision, Status: "running", UpdatedAt: now()}
	_, err = s.Store.DB.Exec(`INSERT INTO research_runs(id,topic_id,session_id,user_message_id,status,request_hash,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, run.ID, topic, session.ID, run.UserMessageID, run.Status, "fixture", jsonText(run), now(), now())
	if err != nil {
		t.Fatal(err)
	}
	return run
}

func TestResearchToolsNativeLoopProtocols(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic"} {
		t.Run(protocol, func(t *testing.T) {
			s, topic, paper := researchFixture(t)
			run := researchRunFixture(t, s, topic)
			tools, err := s.researchTools(t.Context(), run.ID)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var payload map[string]any
				if e := json.NewDecoder(r.Body).Decode(&payload); e != nil {
					t.Error(e)
					return
				}
				for _, item := range payload["tools"].([]any) {
					def := item.(map[string]any)
					params := def["input_schema"]
					if protocol == "openai" {
						params = def["function"].(map[string]any)["parameters"]
					}
					if params.(map[string]any)["required"] == nil {
						t.Error("invalid JSON schema: required null")
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				if calls > 1 {
					var source string
					if e := s.Store.DB.QueryRow(`SELECT id FROM research_evidence WHERE run_id=? ORDER BY rowid LIMIT 1`, run.ID).Scan(&source); e != nil {
						t.Error(e)
						return
					}
					fmt.Fprint(w, strings.ReplaceAll(nativeFixtureFrame(protocol, "answer"), "[S1]", "["+source+"]"))
					return
				}
				args := jsonText(map[string]any{"paperId": paper, "full": true})
				if protocol == "openai" {
					fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "c1", "type": "function", "function": map[string]any{"name": "read_paper_passage", "arguments": args}}}}, "finish_reason": "tool_calls"}}})+"\n\ndata: [DONE]\n\n")
				} else {
					events := []any{map[string]any{"type": "message_start", "message": map[string]any{"model": "test"}}, map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "c1", "name": "read_paper_passage", "input": map[string]any{}}}, map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": args}}, map[string]any{"type": "content_block_stop", "index": 0}, map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}}, map[string]any{"type": "message_stop"}}
					for _, event := range events {
						fmt.Fprint(w, "data: "+jsonText(event)+"\n\n")
					}
				}
			}))
			defer endpoint.Close()
			result, err := runNativeLoop(t.Context(), nativeLoopRequest{Snapshot: nativeTaskSnapshot{Connection: APIConnection{URL: endpoint.URL, Protocol: protocol}, Model: "test", Tools: true}, Input: AIInput{Prompt: "Read this paper using its real scoped tools."}, Tools: tools}, nil)
			if err != nil || calls != 2 || !strings.HasPrefix(result.Result.Text, "answer [") {
				t.Fatal(result.Result.Text, err, calls)
			}
		})
	}
}

func researchLongPDF(t *testing.T, s *Server, count int) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(s.analysisDir("doc"), "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest layoutManifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	first := manifest.Blocks[0]
	manifest.Blocks = nil
	manifest.Pages = 1
	for i := 0; i < count; i++ {
		b := first
		b.ID = fmt.Sprintf("p1-b%d", i+1)
		b.Text = fmt.Sprintf("Fact %d ", i) + strings.Repeat("verified original text ", 90)
		manifest.Blocks = append(manifest.Blocks, b)
	}
	if err = os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(manifest)), 0600); err != nil {
		t.Fatal(err)
	}
	researchSetLayoutSource(t, s, "doc", "long-source")
}

func TestResearchToolsPaginationDoesNotReadHiddenPassages(t *testing.T) {
	s, topic, paper := researchFixture(t)
	researchLongPDF(t, s, 80)
	run := researchRunFixture(t, s, topic)
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	search := researchToolCall(t, tools, "search_papers", map[string]any{"query": "verified", "limit": 1})
	if search["nextCursor"] == "" {
		t.Fatal("lost search continuation")
	}
	var count int
	s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=?`, run.ID).Scan(&count)
	if count != 0 {
		t.Fatal("search counted as read")
	}
	total := 0
	cursor := ""
	seen := map[string]bool{}
	for {
		result := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": paper, "full": true, "cursor": cursor})
		items := result["items"].([]any)
		if len(items) == 0 {
			t.Fatal("nonprogressing cursor")
		}
		total += len(items)
		for _, item := range items {
			loc := item.(map[string]any)["location"].(map[string]any)
			block := loc["blockId"].(string)
			if seen[block] {
				t.Fatal("repeated page chunk")
			}
			seen[block] = true
		}
		s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=?`, run.ID).Scan(&count)
		if count != total {
			t.Fatal("unreturned evidence recorded", count, total)
		}
		next := result["nextCursor"].(string)
		if cursor == "" && (next == "" || total >= 80) {
			t.Fatal("missing bounded continuation", total, next)
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if total != 80 {
		t.Fatal("unread tail", total)
	}
}

func TestResearchToolsPreserveEPUBAndPDFLocations(t *testing.T) {
	s, topic, pdf := researchFixture(t)
	w := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var doc Document
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	epub := paperCreate(t, s, "EPUB paper")
	paperCall(t, s, "PATCH", "/api/papers/"+epub, `{"folders":["ML"]}`, 200)
	paperCall(t, s, "PUT", "/api/papers/"+epub+"/attachments/"+doc.ID, `{"role":"original","primary":true}`, 200)
	run := researchRunFixture(t, s, topic)
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": epub, "full": true})
	ev := result["items"].([]any)[0].(map[string]any)
	loc := ev["location"].(map[string]any)
	if loc["type"] != "epub" || loc["href"] == nil || loc["locator"] == nil {
		t.Fatal("lost Readium selector", loc)
	}
	if got := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": epub, "fromPage": 1, "toPage": 1}); got["error"] == nil {
		t.Fatal("EPUB reduced to pages")
	}
	if got := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": pdf, "sectionId": loc["href"]}); got["error"] == nil {
		t.Fatal("cross-engine selector")
	}
	source := ev["sourceId"].(string)
	actual, err := s.resolveResearchSource(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	actual.Location = json.RawMessage(`{"type":"pdf","page":1}`)
	s.Store.DB.Exec(`UPDATE research_evidence SET body=? WHERE id=?`, jsonText(actual), source)
	if _, err = s.resolveResearchSource(t.Context(), source); err == nil {
		t.Fatal("forged location accepted")
	}
}

func TestResearchToolsRejectOwnershipAndParserReplacement(t *testing.T) {
	s, topic, paper := researchFixture(t)
	run := researchRunFixture(t, s, topic)
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": paper, "full": true})
	source := result["items"].([]any)[0].(map[string]any)["sourceId"].(string)
	ev, err := s.resolveResearchSource(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	ev.PaperID = "foreign"
	s.Store.DB.Exec(`UPDATE research_evidence SET paper_id=?,body=? WHERE id=?`, ev.PaperID, jsonText(ev), source)
	if _, err = s.resolveResearchSource(t.Context(), source); err == nil {
		t.Fatal("cross-paper evidence accepted")
	}
	// Replacing parsed text without touching original bytes invalidates old runs.
	raw, _ := os.ReadFile(filepath.Join(s.analysisDir("doc"), "manifest.json"))
	var manifest layoutManifest
	json.Unmarshal(raw, &manifest)
	manifest.Blocks[0].Text = "New parsed text"
	os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), []byte(jsonText(manifest)), 0600)
	if _, err = tools.Call(t.Context(), "read_paper_passage", json.RawMessage(jsonText(map[string]any{"paperId": paper, "full": true}))); err == nil {
		t.Fatal("parser replacement reused old corpus")
	}
}

func TestResearchToolsInterruptedRunRetainsHistoricalSources(t *testing.T) {
	s, topic, paper := researchFixture(t)
	run := researchRunFixture(t, s, topic)
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": paper, "full": true})
	source := result["items"].([]any)[0].(map[string]any)["sourceId"].(string)
	s.Store.DB.Exec(`UPDATE research_runs SET status='interrupted',body=json_set(body,'$.status','interrupted') WHERE id=?`, run.ID)
	if _, err = s.resolveResearchSource(t.Context(), source); err != nil {
		t.Fatal("historical source rejected", err)
	}
	if _, err = tools.Call(t.Context(), "read_paper_passage", json.RawMessage(jsonText(map[string]any{"paperId": paper, "full": true}))); err == nil {
		t.Fatal("interrupted run kept reading")
	}
}

func TestResearchToolsNativeCoverageDoesNotClaimPartialPages(t *testing.T) {
	s, topic, paper := researchFixture(t)
	researchLongPDF(t, s, 80)
	// A second native page has no extracted text and must remain uncovered.
	path := filepath.Join(s.analysisDir("doc"), "manifest.json")
	raw, _ := os.ReadFile(path)
	var manifest layoutManifest
	json.Unmarshal(raw, &manifest)
	manifest.Pages = 2
	// ParsedPages empty means both pages were parsed; page 2 has no text.
	os.WriteFile(path, []byte(jsonText(manifest)), 0600)
	researchSetLayoutSource(t, s, "doc", "long-source")
	run := researchRunFixture(t, s, topic)
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	cursor := ""
	covered := 0
	for {
		got := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": paper, "full": true, "cursor": cursor})
		coverage := got["readCoverage"].(map[string]any)
		if coverage["totalUnits"] != float64(2) {
			t.Fatal("native missing page hidden", coverage)
		}
		next := got["nextCursor"].(string)
		if cursor == "" && coverage["readUnits"] != float64(0) {
			t.Fatal("partial page claimed complete", coverage)
		}
		if next == "" {
			covered = int(coverage["readUnits"].(float64))
			break
		}
		cursor = next
	}
	if covered != 1 {
		t.Fatal("cumulative page coverage", covered)
	}
}

func TestResearchToolsPageImagesAndReleasedReads(t *testing.T) {
	s, topic, paper := researchFixture(t)
	run := researchRunFixture(t, s, topic)
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	m, _ := scope.member(paper)
	data, _, err := visionProbe()
	if err != nil {
		t.Fatal(err)
	}
	for _, page := range []int{1, 2} {
		name, _ := pageImageName(m.CorpusRevision, page)
		file := filepath.Join(s.Store.Root, "cache", "doc", "page-images", name)
		if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	tools.Definitions(true)
	result, err := tools.Call(t.Context(), "read_paper_pages", json.RawMessage(jsonText(map[string]any{"paperId": paper, "pages": []int{1, 2}})))
	if err != nil || len(result.Images) != 2 || len(result.Images[0].Data) == 0 {
		t.Fatal(result, err)
	}
	ev, err := s.resolveResearchSource(t.Context(), result.Images[0].SourceID)
	if err != nil || ev.Kind != "local-page" {
		t.Fatal(ev, err)
	}
	if _, err = tools.(nativeImageLoader).ImageData(t.Context(), result.Images[0]); err != nil {
		t.Fatal(err)
	}
	s.documentMu.Lock()
	pending := len(s.documentTasks["doc"])
	s.documentMu.Unlock()
	if pending != 0 {
		t.Fatal("read registration leaked", pending)
	}
	name, _ := pageImageName(m.CorpusRevision, 1)
	os.WriteFile(filepath.Join(s.Store.Root, "cache", "doc", "page-images", name), []byte("changed"), 0600)
	if _, err = s.resolveResearchSource(t.Context(), ev.ID); err == nil {
		t.Fatal("changed image trusted")
	}
}

func TestResearchToolsBlockNeighbourCursor(t *testing.T) {
	s, topic, paper := researchFixture(t)
	researchLongPDF(t, s, 10)
	run := researchRunFixture(t, s, topic)
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var raw string
	if err = s.Store.DB.QueryRow(`SELECT body FROM document_corpora WHERE document_id='doc'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var corpus documentCorpus
	if err = json.Unmarshal([]byte(raw), &corpus); err != nil {
		t.Fatal(err)
	}
	tools.(*researchToolset).passageBytes = 6 << 10
	cursor := ""
	seen := map[string]bool{}
	for {
		got := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": paper, "blockId": corpus.Passages[3].ID, "before": 3, "after": 3, "cursor": cursor})
		if got["error"] != nil {
			t.Fatal("unusable neighbourhood continuation", got)
		}
		for _, item := range got["items"].([]any) {
			block := item.(map[string]any)["location"].(map[string]any)["blockId"].(string)
			if seen[block] {
				t.Fatal("repeated continuation", block)
			}
			seen[block] = true
		}
		next := got["nextCursor"].(string)
		if next == "" {
			break
		}
		cursor = next
	}
	if len(seen) != 7 {
		t.Fatal("neighbour passages lost", len(seen))
	}
}

func TestResearchToolsMetadataIdentitySurvivesRelocation(t *testing.T) {
	s, topic, _ := researchFixture(t)
	paper := paperCreate(t, s, "Metadata")
	paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"],"metadata":{"abstract":"Stable abstract"}}`, 200)
	first := researchSnapshot(t, s, topic)
	root := s.Store.Root
	s.Store.Root = t.TempDir()
	for _, name := range []string{"papers", "books", "cache", "ai-work"} {
		if err := os.CopyFS(filepath.Join(s.Store.Root, name), os.DirFS(filepath.Join(root, name))); err != nil {
			t.Fatal(err)
		}
	}
	defer func() { s.Store.Root = root }()
	second := researchSnapshot(t, s, topic)
	var before, after string
	for _, m := range first.Members {
		if m.PaperID == paper {
			before = m.SourceHash
		}
	}
	for _, m := range second.Members {
		if m.PaperID == paper {
			after = m.SourceHash
		}
	}
	if before == "" || before != after {
		t.Fatal("unstable abstract identity", before, after)
	}
}
func researchToolCall(t *testing.T, tools nativeToolset, name string, args any) map[string]any {
	t.Helper()
	result, err := tools.Call(t.Context(), name, json.RawMessage(jsonText(args)))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Content) > 64<<10 {
		t.Fatal("unbounded result")
	}
	return decodeBody[map[string]any](t, result.Content)
}

// A missing route currently returns 404; source payloads must be authenticated,
// validate the persisted source, and never guess navigation for a forged ID.
func TestResearchToolsSourceRouteRejectsForged(t *testing.T) {
	s := testServer(t)
	w := request(t, s, "GET", "/api/research/sources/forged", nil)
	if w.Code != 409 {
		t.Fatalf("source lookup = %d %s; want 409", w.Code, w.Body.String())
	}
}

func TestResearchToolsIsolateSameBlockIDs(t *testing.T) {
	s, topic, paper := researchFixture(t)
	paperSeed(t, s.Store, "second")
	d, _ := s.Store.Document("second")
	paperCall(t, s, "PATCH", "/api/papers/"+d.PaperID, `{"folders":["ML"]}`, 200)
	os.MkdirAll(s.analysisDir("second"), 0700)
	raw, _ := os.ReadFile(filepath.Join(s.analysisDir("doc"), "manifest.json"))
	os.WriteFile(filepath.Join(s.analysisDir("second"), "manifest.json"), raw, 0600)
	researchSetLayoutSource(t, s, "second", "source-B")
	run := researchRunFixture(t, s, topic)
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	sources := []string{}
	for _, pid := range []string{paper, d.PaperID} {
		outline := researchToolCall(t, tools, "get_paper_outline", map[string]any{"paperId": pid})
		block := outline["items"].([]any)[0].(map[string]any)["firstBlockId"].(string)
		result := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": pid, "blockId": block})
		ev := result["items"].([]any)[0].(map[string]any)
		sources = append(sources, ev["sourceId"].(string))
	}
	if sources[0] == sources[1] {
		t.Fatal("cross-paper source collision")
	}
	if err = s.validateResearchSources(t.Context(), run.ID, sources); err != nil {
		t.Fatal(err)
	}
	for _, args := range []any{map[string]any{"paperId": "foreign", "full": true}, map[string]any{"paperId": paper, "sourceId": sources[0]}, map[string]any{"paperId": paper, "sectionId": "a.xhtml"}} {
		if got := researchToolCall(t, tools, "read_paper_passage", args); got["error"] == nil {
			t.Fatal("unscoped selector accepted", got)
		}
	}
	if err = s.validateResearchSources(t.Context(), run.ID, []string{"forged"}); err == nil {
		t.Fatal("forged source accepted")
	}
	other := researchRunFixture(t, s, topic)
	if err = s.validateResearchSources(t.Context(), other.ID, sources); err == nil {
		t.Fatal("foreign run accepted")
	}
	for _, q := range []string{"transactions", `%_'\" OR 1=1 --`} {
		got := researchToolCall(t, tools, "search_papers", map[string]any{"query": q, "limit": 2})
		items := got["items"].([]any)
		if q == "transactions" && (len(items) != 2 || items[0].(map[string]any)["paperId"] == items[1].(map[string]any)["paperId"]) {
			t.Fatal("unfair search", got)
		}
		if q != "transactions" && len(items) != 0 {
			t.Fatal("query escaped binding", got)
		}
	}
	if strings.Contains(jsonText(tools.Definitions(false)), "read_paper_pages") {
		t.Fatal("vision registration")
	}
	if got := researchToolCall(t, tools, "read_paper_pages", map[string]any{"paperId": paper, "pages": []int{1}}); got["error"] == nil {
		t.Fatal("vision bypass")
	}
	if !strings.Contains(jsonText(tools.Definitions(true)), "read_paper_pages") {
		t.Fatal("vision registration")
	}
	w := request(t, s, "GET", "/api/research/sources/"+sources[0], nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	researchSetLayoutSource(t, s, "doc", "replaced")
	if err = s.validateResearchSources(context.Background(), run.ID, sources); err == nil {
		t.Fatal("replaced source trusted")
	}
	w = request(t, s, "GET", "/api/research/sources/"+sources[0], nil)
	if w.Code != 409 || strings.Contains(w.Body.String(), "Long-running") {
		t.Fatal(w.Code, w.Body.String())
	}
}

// Metadata/abstract identity is from the snapshot, never filled from the current
// paper at read time. A changed abstract must invalidate a pre-existing run.
func TestResearchToolsAbstractIdentity(t *testing.T) {
	s, topic, _ := researchFixture(t)
	paper := paperCreate(t, s, "Abstract")
	paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"],"metadata":{"abstract":"A measured result."}}`, 200)
	run := researchRunFixture(t, s, topic)
	tools, err := s.researchTools(t.Context(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	result := researchToolCall(t, tools, "read_paper_passage", map[string]any{"paperId": paper, "full": true})
	source := result["items"].([]any)[0].(map[string]any)["sourceId"].(string)
	if err = s.validateResearchSources(t.Context(), run.ID, []string{source}); err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"metadata":{"abstract":"A contradictory replacement."}}`, 200)
	if _, err = tools.Call(t.Context(), "read_paper_passage", json.RawMessage(jsonText(map[string]any{"paperId": paper, "full": true}))); err == nil {
		t.Fatal("read replacement under old snapshot")
	}
	if err = s.validateResearchSources(t.Context(), run.ID, []string{source}); err == nil {
		t.Fatal("trusted stale abstract")
	}
}
