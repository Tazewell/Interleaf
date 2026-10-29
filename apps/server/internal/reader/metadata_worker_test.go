package reader

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"reader.local/server/internal/scholar"
)

func queuedMetadataPaper(t *testing.T, s *Server, pages int, arxiv string) Document {
	t.Helper()
	w := uploadTo(t, s, "papers", "paper.pdf", testPDF(pages))
	var d Document
	if w.Code != http.StatusCreated || json.Unmarshal(w.Body.Bytes(), &d) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	if arxiv != "" {
		w = request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"metadata":{"arxiv":"`+arxiv+`"}}`))
		if w.Code != http.StatusOK {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if err := s.Store.saveProcessing(Processing{DocumentID: d.ID, Phase: "translating", Status: "complete"}); err != nil {
		t.Fatal(err)
	}
	return d
}

func startMetadataWorker(t *testing.T, s *Server) (context.CancelFunc, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); s.metadataWorker(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("metadata worker did not stop")
		}
	})
	return cancel, done
}

func awaitMetadataState(t *testing.T, s *Server, id, state string) Document {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		d, err := s.Store.Document(id)
		if err != nil {
			t.Fatal(err)
		}
		if d.Metadata.Lookup == state {
			return d
		}
		if time.Now().After(deadline) {
			t.Fatalf("lookup remained %q, want %q", d.Metadata.Lookup, state)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestMetadataWorkerFinishesUnsuccessfulLookupAndContinues(t *testing.T) {
	for _, tc := range []struct{ name, arxiv, response, want string }{
		{"invalid response", "0000.00000", "invalid XML", "failed"},
		{"not found", "0000.00000", `<feed xmlns="http://www.w3.org/2005/Atom"/>`, "notFound"},
		{"no identifier", "", "", "notFound"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testServer(t)
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/atom+xml")
				if r.URL.Query().Get("id_list") == "1706.03762" {
					_, _ = w.Write([]byte(lookupAtom))
				} else {
					_, _ = w.Write([]byte(tc.response))
				}
			}))
			t.Cleanup(endpoint.Close)
			client := scholar.New(maxImportBytes)
			client.AllowPrivateHosts = true
			client.ArXivAPI = endpoint.URL
			s.scholar = client
			first := queuedMetadataPaper(t, s, 2, tc.arxiv)
			second := queuedMetadataPaper(t, s, 3, "1706.03762")
			if _, err := s.Store.DB.Exec("UPDATE documents SET created_at='2000-01-01T00:00:00Z' WHERE id=?", first.ID); err != nil {
				t.Fatal(err)
			}
			startMetadataWorker(t, s)
			got := awaitMetadataState(t, s, first.ID, tc.want)
			if got.Title != first.Title || got.Author != "" || got.Metadata.LookedUpAt == "" {
				t.Fatalf("unsuccessful lookup changed bibliographic fields: %+v", got)
			}
			got = awaitMetadataState(t, s, second.ID, "done")
			if got.Title != "Attention Is All You Need" || got.Author != "Ashish Vaswani" {
				t.Fatalf("later paper was not enriched: %+v", got)
			}
		})
	}
}

func TestMetadataWorkerCancellationDoesNotPublishTerminalState(t *testing.T) {
	s := testServer(t)
	entered := make(chan struct{})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
	}))
	t.Cleanup(endpoint.Close)
	client := scholar.New(maxImportBytes)
	client.AllowPrivateHosts = true
	client.ArXivAPI = endpoint.URL
	s.scholar = client
	d := queuedMetadataPaper(t, s, 2, "1706.03762")
	cancel, done := startMetadataWorker(t, s)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("lookup did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("canceled lookup did not stop")
	}
	got, err := s.Store.Document(d.ID)
	if err != nil || got.Metadata.Lookup != "pending" || got.Metadata.LookedUpAt != "" {
		t.Fatalf("cancellation persisted a false lookup result: %+v %v", got, err)
	}
	s.documentMu.Lock()
	defer s.documentMu.Unlock()
	if len(s.documentTasks[d.ID]) != 0 {
		t.Fatal("canceled metadata task retained its document owner")
	}
}
