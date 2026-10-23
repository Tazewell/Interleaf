package reader

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Delete/trash must cancel an abstract-only paper's live HTTP and join its
// owned analysis, while a different paper's HTTP stays alive. Holding one
// additional registered source task makes the deletion's joining gate visible.
func TestResearchCardsAbstractMutationCancelsOwnedModel(t *testing.T) {
	for _, action := range []string{"delete", "trash"} {
		t.Run(action, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			target := paperCreate(t, s, "Abstract target")
			other := paperCreate(t, s, "Unrelated abstract")
			paperCall(t, s, "PATCH", "/api/papers/"+target, `{"folders":["ML"],"metadata":{"abstract":"Measured result."}}`, 200)
			paperCall(t, s, "PATCH", "/api/papers/"+other, `{"folders":["Other"],"metadata":{"abstract":"Measured result."}}`, 200)
			otherTopic := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Other scope","folder":"Other"}`, 201)["id"].(string)
			started := make(chan string, 3)
			canceled := make(chan string, 3)
			release := make(chan struct{})
			var releaseOnce sync.Once
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					fmt.Fprint(w, `{"data":[{"id":"test"}]}`)
					return
				}
				var input struct {
					Messages []struct {
						Content string `json:"content"`
					} `json:"messages"`
				}
				json.NewDecoder(r.Body).Decode(&input)
				wire := input.Messages[len(input.Messages)-1].Content
				marker := strings.Index(wire, "RESEARCH_EVIDENCE_JSON\n")
				var evidence []struct {
					SourceID string `json:"sourceId"`
				}
				json.Unmarshal([]byte(wire[marker+len("RESEARCH_EVIDENCE_JSON\n"):]), &evidence)
				var paper string
				s.Store.DB.QueryRow(`SELECT paper_id FROM research_evidence WHERE id=?`, evidence[0].SourceID).Scan(&paper)
				started <- paper
				select {
				case <-r.Context().Done():
					canceled <- paper
				case <-release:
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": jsonText(researchCardFacts{Problem: ResearchFact{Text: "Measured result.", EvidenceIDs: []string{evidence[0].SourceID}}})}, "finish_reason": "stop"}}})+"\n\ndata: [DONE]\n\n")
				}
			}))
			defer endpoint.Close()
			defer releaseOnce.Do(func() { close(release) })
			_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":null},"models":{"chat":"test"}}`))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			run := researchRunFixture(t, s, topic)
			otherRun := researchRunFixture(t, s, otherTopic)
			done := make(chan error, 1)
			otherDone := make(chan error, 1)
			go func() { _, err := s.analyzeResearchPaper(ctx, run.ID, target); done <- err }()
			go func() { _, err := s.analyzeResearchPaper(ctx, otherRun.ID, other); otherDone <- err }()
			for i := 0; i < 2; i++ {
				select {
				case <-started:
				case <-time.After(3 * time.Second):
					t.Fatal("models did not start")
				}
			}
			heldCtx, finishHeld, err := s.beginResearchPaperTask(ctx, target)
			if err != nil {
				t.Fatal(err)
			}
			defer finishHeld()
			method, path := "DELETE", "/api/papers/"+target
			if action == "trash" {
				method, path = "POST", path+"/trash"
			}
			mutation := make(chan int, 1)
			go func() { mutation <- request(t, s, method, path, strings.NewReader(`{}`)).Code }()
			select {
			case paper := <-canceled:
				if paper != target {
					t.Fatal("unrelated model canceled", paper)
				}
			case <-time.After(time.Second):
				cancel()
				t.Fatal("abstract HTTP not canceled before mutation returned")
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("canceled analysis completed")
				}
			case <-time.After(time.Second):
				t.Fatal("analysis not joined")
			}
			select {
			case <-heldCtx.Done():
			case <-time.After(time.Second):
				t.Fatal("paper task not canceled")
			}
			select {
			case status := <-mutation:
				t.Fatal("mutation returned before source task joined", status)
			default:
			}
			if _, err = s.analyzeResearchPaper(t.Context(), run.ID, target); err == nil {
				t.Fatal("new analysis admitted while mutation joining")
			}
			select {
			case paper := <-started:
				t.Fatal("new model call during mutation", paper)
			default:
			}
			finishHeld()
			select {
			case status := <-mutation:
				want := 204
				if action == "trash" {
					want = 200
				}
				if status != want {
					t.Fatal(status)
				}
			case <-time.After(time.Second):
				t.Fatal("mutation did not complete")
			}
			select {
			case paper := <-canceled:
				t.Fatal("unrelated model canceled", paper)
			default:
			}
			releaseOnce.Do(func() { close(release) })
			select {
			case err := <-otherDone:
				if err != nil {
					t.Fatal("unrelated paper analysis failed", err)
				}
			case <-time.After(time.Second):
				t.Fatal("unrelated model did not settle")
			}
			var n int
			s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards WHERE paper_id=?`, target).Scan(&n)
			if n != 0 {
				t.Fatal("deleted abstract saved card")
			}
		})
	}
}

func TestResearchCardsPaperMutationRollbackReleasesGate(t *testing.T) {
	for _, action := range []string{"delete", "trash"} {
		t.Run(action, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			paper := paperCreate(t, s, "Abstract")
			paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"],"metadata":{"abstract":"Keep this abstract."}}`, 200)
			run := researchRunFixture(t, s, topic)
			mode := "ok"
			calls := 0
			researchCardModel(t, s, &mode, &calls)
			card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
			if err != nil {
				t.Fatal(err)
			}
			mutation := "DELETE"
			if action == "trash" {
				mutation = "UPDATE"
			}
			_, err = s.Store.DB.Exec(`CREATE TRIGGER refuse_paper_mutation BEFORE ` + mutation + ` ON paper_items BEGIN SELECT RAISE(ABORT,'rollback test'); END`)
			if err != nil {
				t.Fatal(err)
			}
			method, path := "DELETE", "/api/papers/"+paper
			if action == "trash" {
				method, path = "POST", path+"/trash"
			}
			w := request(t, s, method, path, strings.NewReader(`{}`))
			if w.Code != 400 {
				t.Fatal(w.Code, w.Body.String())
			}
			p, err := s.Store.PaperItem(paper)
			if err != nil || p.DeletedAt != "" || p.Metadata.Abstract != "Keep this abstract." {
				t.Fatal("mutation lost original", p, err)
			}
			var n int
			s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards WHERE cache_key=?`, card.CacheKey).Scan(&n)
			if n != 1 {
				t.Fatal("rollback lost cached fact")
			}
			task, finish, err := s.beginResearchPaperTask(t.Context(), paper)
			if err != nil {
				t.Fatal("failed mutation kept gate closed", err)
			}
			if task.Err() != nil {
				t.Fatal(task.Err())
			}
			finish()
		})
	}
}

func TestResearchCardsShortFragmentsSmallWindow(t *testing.T) {
	s, topic, paper := researchFixture(t)
	researchLongPDF(t, s, 20)
	path := filepath.Join(s.analysisDir("doc"), "manifest.json")
	raw, _ := os.ReadFile(path)
	var layout layoutManifest
	json.Unmarshal(raw, &layout)
	for i := range layout.Blocks {
		layout.Blocks[i].Text = strings.Repeat("x", 500)
	}
	os.WriteFile(path, []byte(jsonText(layout)), 0600)
	researchSetLayoutSource(t, s, "doc", "short-fragments")
	mode := "smallwindow"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
	if err != nil || len(card.EvidenceIDs) != 20 || card.ReadCoverage.ReadUnits != 1 || calls < 2 {
		t.Fatal("20 short fragments should be cursor-readable at 4096", err, len(card.EvidenceIDs), calls)
	}
	seen := map[string]bool{}
	for _, source := range card.EvidenceIDs {
		if seen[source] {
			t.Fatal("duplicate provided evidence", source)
		}
		seen[source] = true
	}
}

func TestResearchCardsEPUBEncodedLocationsFitSmallWindow(t *testing.T) {
	s, topic, _ := researchFixture(t)
	original := sample(t, "the-art-of-reading.epub")
	source, err := zip.NewReader(bytes.NewReader(original), int64(len(original)))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	for _, file := range source.File {
		input, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(input)
		input.Close()
		if err != nil {
			t.Fatal(err)
		}
		if file.Name == "EPUB/chapter1.xhtml" {
			text := strings.Repeat(`quote " and slash \ & < `, 15)
			body = []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><body>` + strings.Repeat("<p>"+html.EscapeString(text)+"</p>", 20) + `</body></html>`)
		}
		target, err := writer.Create(file.Name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = target.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	response := upload(t, s, "quoted.epub", out.Bytes())
	if response.Code != 201 {
		t.Fatal(response.Code, response.Body.String())
	}
	var doc Document
	if err = json.Unmarshal(response.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	paper := paperCreate(t, s, "EPUB quoted")
	paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"]}`, 200)
	paperCall(t, s, "PUT", "/api/papers/"+paper+"/attachments/"+doc.ID, `{"role":"original","primary":true}`, 200)
	mode := "smallwindow"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	scope, err := readResearchRunScope(t.Context(), s.Store.DB, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	member, err := scope.member(paper)
	if err != nil {
		t.Fatal(err)
	}
	st, err := s.prepareResearchRead(t.Context(), member)
	if err != nil {
		t.Fatal(err)
	}
	expected := len(st.Corpus.Passages)
	st.Finish()
	reserved := 0
	ctx := context.WithValue(t.Context(), researchModelReservationKey{}, func(context.Context) error { reserved++; return nil })
	card, err := s.analyzeResearchPaper(ctx, run.ID, paper)
	if err != nil || len(card.EvidenceIDs) != expected || len(card.ReadCoverage.Ranges) != expected || calls < 2 || reserved != calls {
		t.Fatal("encoded EPUB tail lost", err, len(card.EvidenceIDs), expected, calls, reserved)
	}
	for _, location := range card.ReadCoverage.Ranges {
		if !bytes.Contains(location, []byte(`"locator"`)) || !bytes.Contains(location, []byte(`"href"`)) {
			t.Fatal("native location lost", string(location))
		}
	}
}

func TestResearchCardsUnfitMinimumAndPartialNeverRetry(t *testing.T) {
	for _, modeValue := range []string{"tinywindow", "smallwindow-partial"} {
		t.Run(modeValue, func(t *testing.T) {
			s, topic, paper := researchFixture(t)
			researchLongPDF(t, s, 20)
			mode := modeValue
			calls := 0
			researchCardModel(t, s, &mode, &calls)
			run := researchRunFixture(t, s, topic)
			reserved := 0
			ctx := context.WithValue(t.Context(), researchModelReservationKey{}, func(context.Context) error { reserved++; return nil })
			card, err := s.analyzeResearchPaper(ctx, run.ID, paper)
			if err == nil || len(card.EvidenceIDs) != 0 {
				t.Fatal("uncompleted card saved", card, err)
			}
			want := 1
			if mode == "tinywindow" {
				want = 0
				if errorKind(err) != ErrorLimit || !strings.Contains(err.Error(), "更大窗口") {
					t.Fatal("unfit minimum lacked actionable failure", err)
				}
			}
			if calls != want || reserved != want {
				t.Fatal("preflight charged or partial retried", calls, reserved, want)
			}
			var count int
			s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards WHERE paper_id=?`, paper).Scan(&count)
			if count != 0 {
				t.Fatal("incomplete card persisted")
			}
			if want == 0 {
				s.Store.DB.QueryRow(`SELECT count(*) FROM research_evidence WHERE run_id=?`, run.ID).Scan(&count)
				if count != 0 {
					t.Fatal("unprovided minimum counted read")
				}
			}
		})
	}
}

func TestResearchCardsAbstractMutationCancelsCatalog(t *testing.T) {
	s, topic, _ := researchFixture(t)
	paper := paperCreate(t, s, "Abstract")
	paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"],"metadata":{"abstract":"Actual abstract"}}`, 200)
	started, canceled := make(chan struct{}), make(chan struct{})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Error("unexpected model request")
			return
		}
		close(started)
		<-r.Context().Done()
		close(canceled)
	}))
	defer endpoint.Close()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":null},"models":{"chat":"test"}}`))
	if err != nil {
		t.Fatal(err)
	}
	run := researchRunFixture(t, s, topic)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := s.analyzeResearchPaper(ctx, run.ID, paper); done <- err }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("catalog did not start")
	}
	mutation := make(chan int, 1)
	go func() { mutation <- request(t, s, "DELETE", "/api/papers/"+paper, nil).Code }()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("paper did not own catalog cancellation")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("catalog analysis not canceled")
		}
	case <-time.After(time.Second):
		t.Fatal("catalog analysis not joined")
	}
	select {
	case code := <-mutation:
		if code != 204 {
			t.Fatal(code)
		}
	case <-time.After(time.Second):
		t.Fatal("delete did not return")
	}
}

// Only the paid HTTP boundary is a fixture. Parsing, scoped reads, SQLite
// evidence, the native completion gate, and cross-run cache adoption are real.
func researchCardModel(t *testing.T, s *Server, mode *string, calls *int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			if strings.HasPrefix(*mode, "smallwindow") {
				fmt.Fprint(w, `{"data":[{"id":"model-a","context_window":4096}]}`)
				return
			}
			if *mode == "tinywindow" {
				fmt.Fprint(w, `{"data":[{"id":"model-a","context_window":1024}]}`)
				return
			}
			fmt.Fprint(w, `{"data":[{"id":"model-a"},{"id":"model-b"}]}`)
			return
		}
		*calls++
		var input struct {
			Model    string                  `json:"model"`
			Tools    json.RawMessage         `json:"tools"`
			Messages []toolCompletionMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		if strings.HasPrefix(*mode, "smallwindow") && estimateDocumentTokens(jsonText(input.Messages)) >= 2046 {
			t.Error("actual encoded system/user request exceeds 4096-window input guard")
		}
		wire, ok := input.Messages[len(input.Messages)-1].Content.(string)
		if !ok {
			t.Error("source message is not text")
			return
		}
		marker := strings.Index(wire, "RESEARCH_EVIDENCE_JSON\n")
		if marker < 0 {
			t.Error("Reader did not prepare source text")
			return
		}
		var evidence []struct {
			SourceID string `json:"sourceId"`
			Text     string `json:"text"`
		}
		if err := json.Unmarshal([]byte(wire[marker+len("RESEARCH_EVIDENCE_JSON\n"):]), &evidence); err != nil || len(evidence) == 0 {
			t.Error(err, wire)
			return
		}
		source := evidence[0].SourceID
		if *mode == "interrupt" {
			s.Store.DB.Exec(`UPDATE research_runs SET status='interrupted',body=json_set(body,'$.status','interrupted') WHERE id=(SELECT run_id FROM research_evidence WHERE id=?)`, source)
		}
		if *mode == "replace" {
			researchSetLayoutSource(t, s, "doc", "replaced-during-model-call")
		}
		if *mode == "freeze" && *calls == 1 {
			raw, err := os.ReadFile(filepath.Join(s.Store.Root, "ai-connections.json"))
			if err != nil {
				t.Error(err)
			}
			raw = []byte(strings.ReplaceAll(string(raw), `"model-a"`, `"model-b"`))
			if err = os.WriteFile(filepath.Join(s.Store.Root, "ai-connections.json"), raw, 0600); err != nil {
				t.Error(err)
			}
		}
		if *mode == "freeze" && input.Model != "model-a" {
			t.Error("model changed during batch analysis", input.Model)
		}
		if len(input.Tools) > 0 {
			t.Error("prepared-source extraction advertised callable tools")
		}
		if *mode == "forged" {
			source = "ffffffffffffffffffffffffffffffff"
		}
		text := jsonText(map[string]any{"problem": ResearchFact{Text: evidence[0].Text, EvidenceIDs: []string{source}}, "method": ResearchFact{}, "assumptions": ResearchFact{}, "dataAndEvaluation": ResearchFact{}, "findings": ResearchFact{}, "limitations": ResearchFact{}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": text}, "finish_reason": "stop"}}})+"\n\n")
		if *mode != "partial" && *mode != "smallwindow-partial" {
			fmt.Fprint(w, "data: [DONE]\n\n")
		}
	}))
	t.Cleanup(server.Close)
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+server.URL+`/v1","key":null},"models":{"chat":"model-a"}}`))
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func TestResearchCardsSmallContextUsesCursorBatches(t *testing.T) {
	s, topic, paper := researchFixture(t)
	researchLongPDF(t, s, 10)
	mode := "smallwindow"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
	if err != nil || len(card.EvidenceIDs) != 10 || calls < 3 {
		t.Fatal("small window could not continue reading", err, len(card.EvidenceIDs), calls)
	}
}

func TestResearchCardsConflictingPapersKeepOwnEvidence(t *testing.T) {
	s, topic, _ := researchFixture(t)
	mode := "ok"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	papers := []string{paperCreate(t, s, "Positive"), paperCreate(t, s, "Negative")}
	claims := []string{"The intervention improves accuracy.", "The intervention reduces accuracy."}
	for i, paper := range papers {
		paperCall(t, s, "PATCH", "/api/papers/"+paper, jsonText(map[string]any{"folders": []string{"ML"}, "metadata": map[string]any{"abstract": claims[i]}}), 200)
	}
	run := researchRunFixture(t, s, topic)
	for i, paper := range papers {
		card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
		if err != nil || card.Problem.Text != claims[i] {
			t.Fatal(card, err)
		}
		for _, source := range card.Problem.EvidenceIDs {
			ev, err := s.resolveResearchSource(t.Context(), source)
			if err != nil || ev.PaperID != paper || ev.Excerpt != claims[i] {
				t.Fatal("borrowed conflicting source", ev, err)
			}
		}
	}
}

func TestResearchCardsDeletionCancelsAndJoinsModel(t *testing.T) {
	s, topic, paper := researchFixture(t)
	started := make(chan struct{})
	modelDone := make(chan error, 1)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"test"}]}`)
			return
		}
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer endpoint.Close()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`","key":null},"models":{"chat":"test"}}`))
	if err != nil {
		t.Fatal(err)
	}
	run := researchRunFixture(t, s, topic)
	go func() { _, err := s.analyzeResearchPaper(t.Context(), run.ID, paper); modelDone <- err }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("model did not start")
	}
	deleted := make(chan int, 1)
	go func() { status, _ := s.purgeDocument(t.Context(), "doc"); deleted <- status }()
	select {
	case err := <-modelDone:
		if err == nil {
			t.Fatal("deleted source still completed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("model not canceled/joined")
	}
	select {
	case status := <-deleted:
		if status != 204 {
			t.Fatal("delete failed", status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("delete did not join")
	}
	var count int
	s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards`).Scan(&count)
	if count != 0 {
		t.Fatal("canceled model saved card")
	}
}

// Omitting any one of these inputs would reuse facts produced under a different
// extraction contract. These inputs are independent, concrete cache boundaries.
func TestResearchCardsCacheIdentity(t *testing.T) {
	member := ResearchMember{PaperID: "paper", DocumentID: "doc", SourceHash: "content-a", CorpusRevision: "parser-a", Title: "Title", Coverage: "fulltext"}
	snapshot := nativeTaskSnapshot{Model: "model-a", Fingerprint: "connection-a", Effort: "medium"}
	base := researchCardKey(member, snapshot, "protocol-a", "prompt-a")
	for _, field := range []string{"source", "parser", "level", "title", "model", "connection", "effort", "protocol", "prompt"} {
		t.Run(field, func(t *testing.T) {
			m, s := member, snapshot
			protocol, prompt := "protocol-a", "prompt-a"
			switch field {
			case "source":
				m.SourceHash = "content-b"
			case "parser":
				m.CorpusRevision = "parser-b"
			case "level":
				m.Coverage = "abstract"
			case "title":
				m.Title = "Changed title"
			case "model":
				s.Model = "model-b"
			case "connection":
				s.Fingerprint = "connection-b"
			case "effort":
				s.Effort = "high"
			case "protocol":
				protocol = "protocol-b"
			case "prompt":
				prompt = "prompt-b"
			}
			if got := researchCardKey(m, s, protocol, prompt); got == base {
				t.Fatal("cache ignored", field)
			}
		})
	}
}

func TestResearchCardsRejectCachedVersionForgery(t *testing.T) {
	s, topic, _ := researchFixture(t)
	mode := "ok"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	paper := paperCreate(t, s, "Metadata")
	paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"]}`, 200)
	run := researchRunFixture(t, s, topic)
	card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
	if err != nil {
		t.Fatal(err)
	}
	card.Revision = "forged-revision"
	s.Store.DB.Exec(`UPDATE research_cards SET revision=?,body=? WHERE cache_key=?`, card.Revision, jsonText(card), card.CacheKey)
	if _, err = s.analyzeResearchPaper(t.Context(), run.ID, paper); err == nil {
		t.Fatal("cache revision not bound to snapshot")
	}
}

func TestResearchCardsCacheRequiresHistoricalSnapshotMembership(t *testing.T) {
	s, topic, paper := researchFixture(t)
	mode := "ok"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	if _, err := s.analyzeResearchPaper(t.Context(), run.ID, paper); err != nil {
		t.Fatal(err)
	}
	var raw string
	s.Store.DB.QueryRow(`SELECT body FROM research_snapshots WHERE id=?`, run.SnapshotID).Scan(&raw)
	var snapshot ResearchSnapshot
	json.Unmarshal([]byte(raw), &snapshot)
	snapshot.Members = nil
	s.Store.DB.Exec(`UPDATE research_snapshots SET body=? WHERE id=?`, jsonText(snapshot), snapshot.ID)
	fresh := researchRunFixture(t, s, topic)
	if _, err := s.analyzeResearchPaper(t.Context(), fresh.ID, paper); err == nil {
		t.Fatal("cache trusted source outside its historical snapshot")
	}
}

func TestResearchCardsFinalSaveRejectsReplacement(t *testing.T) {
	for _, modeValue := range []string{"replace", "interrupt"} {
		t.Run(modeValue, func(t *testing.T) {
			s, topic, paper := researchFixture(t)
			mode := modeValue
			calls := 0
			researchCardModel(t, s, &mode, &calls)
			run := researchRunFixture(t, s, topic)
			if _, err := s.analyzeResearchPaper(t.Context(), run.ID, paper); err == nil {
				t.Fatal("saved model facts after source replacement or interruption")
			}
			var n int
			s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards`).Scan(&n)
			if n != 0 {
				t.Fatal("saved invalidated card")
			}
		})
	}
}

func TestResearchCardsLongPaperFrozenModelAndCompletedBatches(t *testing.T) {
	s, topic, paper := researchFixture(t)
	researchLongPDF(t, s, 35)
	mode := "freeze"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	reserved := 0
	ctx := context.WithValue(t.Context(), researchModelReservationKey{}, func(context.Context) error { reserved++; return nil })
	card, err := s.analyzeResearchPaper(ctx, run.ID, paper)
	if err != nil || calls < 2 || reserved != calls || card.ReadCoverage.ReadUnits != 1 || card.ReadCoverage.TotalUnits != 1 || len(card.ReadCoverage.Ranges) != 35 || len(card.EvidenceIDs) != 35 {
		t.Fatal(card, err, calls, reserved)
	}
	if !strings.Contains(card.Problem.Text, "Fact 0 ") || !strings.Contains(card.Problem.Text, "Fact 30 ") {
		t.Fatal("lost completed batches", card.Problem.Text)
	}
}

func TestResearchCardsCoverageCacheAndInvalidation(t *testing.T) {
	s, topic, paper := researchFixture(t)
	mode := "ok"
	calls := 0
	endpoint := researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	card, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
	if err != nil || card.Level != "fulltext" || card.ReadCoverage.ReadUnits != card.ReadCoverage.TotalUnits || card.ReadCoverage.ReadUnits < 2 || len(card.Problem.EvidenceIDs) == 0 {
		t.Fatal(card, err)
	}
	firstCalls := calls
	secondRun := researchRunFixture(t, s, topic)
	cached, err := s.analyzeResearchPaper(t.Context(), secondRun.ID, paper)
	if err != nil || calls != firstCalls || cached.Problem.Text != card.Problem.Text || cached.EvidenceIDs[0] == card.EvidenceIDs[0] {
		t.Fatal("unsafe cache adoption", cached, err, calls)
	}
	if err = s.validateResearchSources(t.Context(), secondRun.ID, cached.EvidenceIDs); err != nil {
		t.Fatal(err)
	}
	if err = s.validateResearchSources(t.Context(), secondRun.ID, card.EvidenceIDs); err == nil {
		t.Fatal("old run references accepted")
	}
	_, err = s.saveNativeAIConfig(nativeUpdate(t, `{"version":2,"connection":{"protocol":"openai","url":"`+endpoint.URL+`/v1"},"models":{"chat":"model-b"}}`))
	if err != nil {
		t.Fatal(err)
	}
	changed, err := s.analyzeResearchPaper(t.Context(), run.ID, paper)
	if err != nil || calls <= firstCalls || changed.CacheKey == card.CacheKey {
		t.Fatal("model cache identity", changed, err, calls)
	}
	beforeChange := calls
	researchSetLayoutSource(t, s, "doc", "new-source-bytes")
	newRun := researchRunFixture(t, s, topic)
	newCard, err := s.analyzeResearchPaper(t.Context(), newRun.ID, paper)
	if err != nil || calls <= beforeChange || newCard.CacheKey == changed.CacheKey {
		t.Fatal("original hash cache identity", newCard, err, calls)
	}
	raw, err := os.ReadFile(filepath.Join(s.analysisDir("doc"), "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	raw = []byte(strings.ReplaceAll(string(raw), "Introduction", "Changed parser heading"))
	os.WriteFile(filepath.Join(s.analysisDir("doc"), "manifest.json"), raw, 0600)
	beforeChange = calls
	newRun = researchRunFixture(t, s, topic)
	parsedCard, err := s.analyzeResearchPaper(t.Context(), newRun.ID, paper)
	if err != nil || calls <= beforeChange || parsedCard.CacheKey == newCard.CacheKey {
		t.Fatal("parser cache identity", parsedCard, err, calls)
	}
	paperCall(t, s, "DELETE", "/api/documents/doc", "", 204)
	before := calls
	if _, err = s.analyzeResearchPaper(t.Context(), secondRun.ID, paper); err == nil || calls != before {
		t.Fatal("removed cache resurrected", err, calls)
	}
}

func TestResearchCardsAbstractMetadataAndCompletion(t *testing.T) {
	for _, modeValue := range []string{"ok", "forged", "partial"} {
		t.Run(modeValue, func(t *testing.T) {
			s, topic, _ := researchFixture(t)
			mode := modeValue
			calls := 0
			researchCardModel(t, s, &mode, &calls)
			paper := paperCreate(t, s, "Abstract paper")
			meta := paperCreate(t, s, "Metadata paper")
			paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"folders":["ML"],"metadata":{"abstract":"Actual abstract claim."}}`, 200)
			paperCall(t, s, "PATCH", "/api/papers/"+meta, `{"folders":["ML"]}`, 200)
			run := researchRunFixture(t, s, topic)
			card, err := s.analyzeResearchPaper(t.Context(), run.ID, meta)
			if err != nil || card.Level != "metadata" || card.Method.Text != "" || card.Problem.Text != "" || card.ReadCoverage.ReadUnits != 0 || calls != 0 {
				t.Fatal("title turned into fact", card, err, calls)
			}
			card, err = s.analyzeResearchPaper(t.Context(), run.ID, paper)
			if mode == "ok" {
				if err != nil || card.Level != "abstract" || card.ReadCoverage.ReadUnits != 1 || card.Problem.Text != "Actual abstract claim." {
					t.Fatal(card, err)
				}
				paperCall(t, s, "PATCH", "/api/papers/"+paper, `{"metadata":{"abstract":"Changed claim."}}`, 200)
				if _, err = s.analyzeResearchPaper(t.Context(), run.ID, paper); err == nil {
					t.Fatal("changed abstract cache hit")
				}
			} else {
				if err == nil {
					t.Fatal("saved unverified output", card)
				}
				var n int
				s.Store.DB.QueryRow(`SELECT count(*) FROM research_cards WHERE paper_id=?`, paper).Scan(&n)
				if n != 0 {
					t.Fatal("partial card checkpoint", n)
				}
			}
		})
	}
}

func TestResearchCardsReserveEveryModelCall(t *testing.T) {
	s, topic, paper := researchFixture(t)
	mode := "ok"
	calls := 0
	researchCardModel(t, s, &mode, &calls)
	run := researchRunFixture(t, s, topic)
	reserved := 0
	ctx := context.WithValue(t.Context(), researchModelReservationKey{}, func(context.Context) error { reserved++; return fmt.Errorf("budget exhausted") })
	if _, err := s.analyzeResearchPaper(ctx, run.ID, paper); err == nil || reserved != 1 || calls != 0 {
		t.Fatal("unaccounted model request", reserved, calls, err)
	}
}
