package reader

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// This is a seeded-corpus HTTP integration scenario, not an ONNX/parser run.
// Production revision-prefixed IDs remain unchanged. Only this owned cache
// deliberately uses a supported bare block ID shared by two different papers.
func TestResearchSameBareBlockHTTPAttribution(t *testing.T) {
	s, _, _ := researchFixture(t)
	paperSeed(t, s.Store, "second")
	claims := []string{"A improves error from 8 to 4.", "B worsens error from 4 to 8."}
	documents := []string{"doc", "second"}
	expected := []map[string]string{}
	for i, document := range documents {
		d, err := s.Store.Document(document)
		if err != nil {
			t.Fatal(err)
		}
		paperCall(t, s, "PATCH", "/api/papers/"+d.PaperID, `{"folders":["Collision"],"title":"`+documents[i]+`"}`, 200)
		if err = os.MkdirAll(s.analysisDir(document), 0700); err != nil {
			t.Fatal(err)
		}
		manifest := layoutManifest{Pages: 1, Blocks: []PDFBlock{{ID: "p1-b1", Page: 1, Label: "text", Text: claims[i]}}}
		manifest.Blocks[0].Bounds.X, manifest.Blocks[0].Bounds.Y = .1, .3
		manifest.Blocks[0].Bounds.Width, manifest.Blocks[0].Bounds.Height = .6, .1
		if err = os.WriteFile(filepath.Join(s.analysisDir(document), "manifest.json"), []byte(jsonText(manifest)), 0600); err != nil {
			t.Fatal(err)
		}
		// Distinct owned synthetic original bytes and matching parser provenance.
		// They are controlled corpus fixtures, not claims of valid PDF parsing.
		researchSetLayoutSource(t, s, document, claims[i])
		corpus, err := s.prepareDocumentCorpus(t.Context(), document, nil, false)
		if err != nil || len(corpus.Passages) != 1 {
			t.Fatal(corpus, err)
		}
		corpus.Passages[0].ID = "p1-b1"
		tx, err := s.Store.DB.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec("UPDATE document_corpora SET body=? WHERE document_id=? AND fingerprint=?", jsonText(corpus), document, corpus.Fingerprint); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec("UPDATE document_passages_fts SET block_id=? WHERE document_id=?", "p1-b1", document); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(); err != nil {
			t.Fatal(err)
		}
		expected = append(expected, map[string]string{"paperId": d.PaperID, "documentId": document, "claim": claims[i], "originalSHA256": sourceKey(claims[i]), "corpusRevision": corpus.Revision, "fingerprint": corpus.Fingerprint})
	}

	var modelCalls atomic.Int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"data":[{"id":"fixture"}]}`)
			return
		}
		modelCalls.Add(1)
		var input struct {
			Messages []toolCompletionMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		var result string
		for _, message := range input.Messages {
			text, ok := message.Content.(string)
			if !ok {
				continue
			}
			if at := strings.Index(text, "RESEARCH_EVIDENCE_JSON\n"); at >= 0 {
				var evidence []struct {
					SourceID string `json:"sourceId"`
					Text     string `json:"text"`
				}
				if err := json.Unmarshal([]byte(text[at+len("RESEARCH_EVIDENCE_JSON\n"):]), &evidence); err != nil || len(evidence) != 1 {
					t.Errorf("evidence: %v %s", err, text)
					return
				}
				result = jsonText(researchCardFacts{Findings: ResearchFact{Text: evidence[0].Text, EvidenceIDs: []string{evidence[0].SourceID}}})
			}
			if at := strings.Index(text, "RESEARCH_CARDS_JSON\n"); at >= 0 {
				var items []researchCompositionItem
				if err := json.Unmarshal([]byte(text[at+len("RESEARCH_CARDS_JSON\n"):]), &items); err != nil {
					t.Error(err)
					return
				}
				section := researchReportSection{}
				for _, item := range items {
					if item.Fact.Text == "" {
						continue
					}
					section.Content += item.Fact.Text
					for _, sid := range item.Fact.EvidenceIDs {
						section.Content += " [" + sid + "]"
						section.SourceIDs = append(section.SourceIDs, sid)
					}
					section.Content += "\n\n"
				}
				result = jsonText(section)
			}
		}
		if result == "" {
			t.Error("unexpected model prompt")
			http.Error(w, "unexpected prompt", 400)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+jsonText(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": result}, "finish_reason": "stop"}}})+"\n\ndata: [DONE]\n\n")
	}))
	defer model.Close()
	defer s.Close()
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	client := &http.Client{Timeout: 10 * time.Second}
	call := func(method, path, body string, status int, auth bool) map[string]any {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if auth {
			req.Header.Set("Authorization", "Bearer test-secret")
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != status {
			t.Fatalf("%s %s: %d %s %v", method, path, resp.StatusCode, raw, err)
		}
		if !auth {
			return nil
		}
		var result map[string]any
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(string(raw), err)
		}
		return result
	}
	call("GET", "/api/ai/config", "", 401, false)
	call("PUT", "/api/ai/config", `{"version":2,"connection":{"protocol":"openai","url":"`+model.URL+`","key":null},"models":{"chat":"fixture"}}`, 200, true)
	topic := call("POST", "/api/research/topics", `{"title":"Collision","folder":"Collision"}`, 201, true)["id"].(string)
	session := call("POST", "/api/research/topics/"+topic+"/sessions", `{"title":"Opposite claims"}`, 201, true)["id"].(string)
	run := call("POST", "/api/research/topics/"+topic+"/sessions/"+session+"/runs", `{"userMessageId":"`+id()+`","question":"Compare both original conclusions","mode":"compare","network":"deny","budget":{"maxModelRequests":20}}`, 201, true)["id"].(string)
	call("POST", "/api/research/runs/"+run+"/start", `{"requestId":"`+id()+`"}`, 202, true)
	var done map[string]any
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		done = call("GET", "/api/research/runs/"+run, "", 200, true)
		if done["status"] == "completed" {
			break
		}
		if done["status"] == "failed" {
			t.Fatal(done)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if done["status"] != "completed" || modelCalls.Load() != 3 {
		t.Fatal(done, modelCalls.Load())
	}
	report := call("GET", "/api/research/reports/"+done["latestReportId"].(string), "", 200, true)
	sources := map[string]any{}
	for _, sid := range report["sourceIds"].([]any) {
		source := call("GET", "/api/research/sources/"+sid.(string), "", 200, true)
		if source["availability"] != "valid" || source["location"].(map[string]any)["blockId"] != "p1-b1" {
			t.Fatal(source)
		}
		sources[sid.(string)] = source
	}
	if len(sources) != 2 {
		t.Fatal("colliding evidence IDs", sources)
	}
	for _, want := range expected {
		matched := 0
		for sid, raw := range sources {
			ev := raw.(map[string]any)
			if ev["paperId"] != want["paperId"] {
				continue
			}
			if ev["documentId"] != want["documentId"] || ev["excerpt"] != want["claim"] || ev["contentHash"] != want["originalSHA256"] || !strings.Contains(report["content"].(string), want["claim"]+" ["+sid+"]") {
				t.Fatal("wrong claim attribution", want, ev, report)
			}
			matched++
		}
		if matched != 1 {
			t.Fatal("missing original attribution", want)
		}
	}
	// Optional evidence destination is test-only; no production switch or seam.
	if out := os.Getenv("READER_TEST_ATTRIBUTION_OUT"); out != "" {
		if !filepath.IsAbs(out) {
			t.Fatal("absolute owned output required")
		}
		if err := os.MkdirAll(out, 0700); err != nil {
			t.Fatal(err)
		}
		for i, doc := range documents {
			d, _ := s.Store.Document(doc)
			raw, err := os.ReadFile(s.Store.File(d))
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) != claims[i] {
				t.Fatal("original changed")
			}
			if err = os.WriteFile(filepath.Join(out, doc+"-controlled-original.txt"), raw, 0600); err != nil {
				t.Fatal(err)
			}
		}
		data := map[string]any{"scenario": "seeded-corpus HTTP; not ONNX", "report": report, "sources": sources, "expected": expected, "modelCalls": modelCalls.Load(), "unauthenticatedStatus": 401}
		if err := os.WriteFile(filepath.Join(out, "attribution-http.json"), []byte(jsonText(data)), 0600); err != nil {
			t.Fatal(err)
		}
	}
}
