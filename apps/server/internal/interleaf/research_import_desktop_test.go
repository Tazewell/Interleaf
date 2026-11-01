package interleaf

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"interleaf.local/server/internal/scholar"
)

type heldPDFReader struct {
	io.ReaderAt
	once sync.Once
	dir  string
}

func (r *heldPDFReader) ReadAt(p []byte, offset int64) (int, error) {
	r.once.Do(func() {
		_ = os.WriteFile(filepath.Join(r.dir, "count-entered"), []byte("inside pdf.NewReader ReaderAt"), 0600)
		until := time.Now().Add(20 * time.Second)
		for time.Now().Before(until) {
			if _, err := os.Stat(filepath.Join(r.dir, "release-count")); err == nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
	return r.ReaderAt.ReadAt(p, offset)
}

// Opt-in helper for the Node acceptance runner. This is an instrumented test
// server, not cmd/interleaf-server: its only seam holds a real PDF ReaderAt call.
func TestResearchImportDesktopHelper(t *testing.T) {
	dir := os.Getenv("INTERLEAF_TEST_COUNT_JOIN_DIR")
	if dir == "" {
		t.Skip("run native-ai-research-acceptance/run.sh for the desktop subprocess combination")
	}
	store, err := OpenStore(filepath.Join(dir, "library"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	s := NewServer(store, "test-secret", "")
	defer s.Close()
	w := uploadTo(t, s, "papers", "existing.pdf", testPDF(1))
	var original Document
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &original) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	paperCall(t, s, "PATCH", "/api/papers/"+original.PaperID, `{"folders":["ML"],"citationKey":"CountJoin2026"}`, 200)
	if _, err = store.DB.Exec(`INSERT INTO document_notes VALUES(?,?,?)`, original.ID, "Preserve nonempty original note", now()); err != nil {
		t.Fatal(err)
	}
	topic := paperCall(t, s, "POST", "/api/research/topics", `{"title":"Count join","folder":"ML"}`, 201)["id"].(string)
	run := researchRunFixture(t, s, topic)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write(testPDF(2))
	}))
	defer remote.Close()
	s.scholar = scholar.New(64 << 20)
	s.scholar.Public = &scholar.PublicConfig{LookupIP: func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("93.184.216.34")}, nil }, Proxy: func(*http.Request) (*url.URL, error) { return nil, nil }, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "93.184.216.34:80" {
			return nil, fmt.Errorf("unpinned %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, remote.Listener.Addr().String())
	}}
	c := ResearchCandidate{ID: id(), TopicID: topic, IdentityKey: "doi:10.1000/count-join", DOI: "10.1000/count-join", Title: "Candidate held in count", PDFURL: "http://paper.example/held.pdf"}
	remoteRegister(t, s, run, c)
	s.importPDFPageCount = func(path string) (int, error) {
		f, err := os.Open(path)
		if err != nil {
			return 0, err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return 0, err
		}
		return pdfPageCountReader(&heldPDFReader{ReaderAt: f, dir: dir}, info.Size())
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpServer := &http.Server{Handler: s.Handler(), BaseContext: func(net.Listener) context.Context { return ctx }}
	go func() { _ = httpServer.Serve(listener) }()
	ready := map[string]string{"url": "http://" + listener.Addr().String(), "token": s.Token, "path": "/api/research/topics/" + topic + "/candidates/" + c.ID + "/import", "original": original.ID}
	if err = os.WriteFile(filepath.Join(dir, "ready.json"), []byte(jsonText(ready)), 0600); err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	cancel()
	_ = os.WriteFile(filepath.Join(dir, "shutdown-requested"), []byte("stdin EOF and context canceled"), 0600)
	// Close must join the candidate owner even if synchronous parsing does not
	// observe cancellation. The desktop runner checks no copy starts before this.
	s.Close()
	shutdown, done := context.WithTimeout(context.Background(), time.Second)
	defer done()
	_ = httpServer.Shutdown(shutdown)
	var imports, documents int
	store.DB.QueryRow(`SELECT count(*) FROM research_units WHERE kind='candidate-import'`).Scan(&imports)
	store.DB.QueryRow(`SELECT count(*) FROM documents`).Scan(&documents)
	if imports != 0 || documents != 1 {
		t.Fatal("late import publication", imports, documents)
	}
	if err = os.WriteFile(filepath.Join(dir, "joined.json"), []byte(jsonText(map[string]int{"imports": imports, "documents": documents})), 0600); err != nil {
		t.Fatal(err)
	}
}
