package reader

import (
	"context"
	"errors"
	"io"
	"testing"
)

// The first check passes; cancellation becomes observable at the expensive
// fingerprint boundary. Losing ctx to Background makes the stale check pass.
type cancelAtHashContext struct {
	context.Context
	cancel context.CancelFunc
	checks int
}

func (c *cancelAtHashContext) Err() error {
	c.checks++
	if c.checks >= 2 {
		c.cancel()
	}
	return c.Context.Err()
}

func TestDocumentToolFingerprintPreservesCancellation(t *testing.T) {
	s, _, _ := researchFixture(t)
	corpus, err := s.documentCorpus(t.Context(), "doc", nil)
	if err != nil {
		t.Fatal(err)
	}
	a := &documentAgent{server: s, ctx: context.Background(), corpus: corpus}
	parent, cancel := context.WithCancel(t.Context())
	defer cancel()
	ctx := &cancelAtHashContext{Context: parent, cancel: cancel}
	if err = a.check(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("tool fingerprint discarded cancellation context", err)
	}
	if ctx.checks < 2 {
		t.Fatal("hash never checked task cancellation")
	}
}

type cancelAfterRead struct {
	cancel context.CancelFunc
	reads  int
	eof    bool
}

func (r *cancelAfterRead) Read(p []byte) (int, error) {
	r.reads++
	if r.reads > 1 {
		r.eof = true
		return 0, io.EOF
	}
	copy(p, "original bytes already being read")
	r.cancel()
	return len("original bytes already being read"), nil
}
func TestResearchHashStopsAfterCancellationDuringRead(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	reader := &cancelAfterRead{cancel: cancel}
	hash, err := researchHashReader(ctx, reader)
	if !errors.Is(err, context.Canceled) || hash != "" || reader.reads != 1 || reader.eof {
		t.Fatalf("continued original scan after cancel: %q %v reads=%d eof=%v", hash, err, reader.reads, reader.eof)
	}
}

func TestCopyLibraryFingerprintPreparationOutsideTransaction(t *testing.T) {
	s, _, _ := researchFixture(t)
	if _, err := s.documentCorpus(t.Context(), "doc", nil); err != nil {
		t.Fatal(err)
	}
	s.Store.DB.SetMaxOpenConns(1)
	// The SQL query in a hash callback uses the same sole connection; it cannot
	// succeed if relocation still starts its write transaction before hashing.
	checker := func(ctx context.Context, server *Server, d Document) (string, error) {
		if s.Store.DB.Stats().InUse != 0 {
			t.Error("full-file hash while SQLite transaction holds the connection")
			return "", errors.New("hash held SQLite connection")
		}
		var n int
		if err := s.Store.DB.QueryRowContext(ctx, `SELECT count(*) FROM document_corpora`).Scan(&n); err != nil {
			return "", err
		}
		return server.corpusFingerprintContext(ctx, d)
	}
	if err := relocateCorpusFingerprintsUsing(t.Context(), s.Store.DB, s.Store.Root, s.Store.Root, checker); err != nil {
		t.Fatal(err)
	}
}
