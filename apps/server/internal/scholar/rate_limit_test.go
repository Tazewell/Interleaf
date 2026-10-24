package scholar

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestScholarGlobalLimiterAndCancel(t *testing.T) {
	var attempts atomic.Int32
	c, _, clock := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(429)
	})
	charged := 0
	ctx := WithPublicReservation(t.Context(), func(context.Context) error { charged++; return nil })
	_, err := c.Search(ctx, SearchQuery{Source: "crossref", Text: "test", Limit: 1})
	if err == nil || attempts.Load() != 3 || charged != 3 || clock.Now().Sub(time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)) < 10*time.Second {
		t.Fatal(err, attempts.Load(), charged, clock.Now())
	}
	budget := fmt.Errorf("budget")
	ctx = WithPublicReservation(t.Context(), func(context.Context) error { return budget })
	if _, err = c.Search(ctx, SearchQuery{Source: "crossref", Text: "other", Limit: 1}); err != budget {
		t.Fatal(err)
	}
	if attempts.Load() != 3 {
		t.Fatal("budget did not precede I/O")
	}
	release, err := c.Public.Limiter.acquire(t.Context(), "arxiv")
	if err != nil {
		t.Fatal(err)
	}
	other := New(64 << 20)
	other.Public = &PublicConfig{Clock: clock, Limiter: c.Public.Limiter}
	queued, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err = other.Public.Limiter.acquire(queued, "arxiv"); err == nil {
		t.Fatal("queue not canceled")
	}
	release()
	release2, err := other.Public.Limiter.acquire(t.Context(), "arxiv")
	if err != nil {
		t.Fatal(err)
	}
	release2()
	if len(clock.waits) == 0 || clock.waits[len(clock.waits)-1] < 3*time.Second {
		t.Fatal(clock.waits)
	}
	if New(1).publicConfig().Limiter != New(1).publicConfig().Limiter {
		t.Fatal("default clients do not share limiter")
	}
}

func TestScholarGlobalActualClientsSerializeBodyAndRespectHeaders(t *testing.T) {
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	calls := atomic.Int32{}
	c, _, clock := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		entered <- struct{}{}
		if n == 1 {
			<-release
		}
		fmt.Fprint(w, `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:o="http://a9.com/-/spec/opensearch/1.1/"><o:totalResults>0</o:totalResults><o:startIndex>0</o:startIndex><o:itemsPerPage>1</o:itemsPerPage></feed>`)
	})
	other := New(64 << 20)
	other.Public = c.Public
	other.ArXivAPI = c.ArXivAPI
	done := make(chan error, 2)
	go func() {
		_, err := c.Search(t.Context(), SearchQuery{Source: "arxiv", Text: "one", Limit: 1})
		done <- err
	}()
	<-entered
	go func() {
		_, err := other.Search(t.Context(), SearchQuery{Source: "arxiv", Text: "two", Limit: 1})
		done <- err
	}()
	select {
	case <-entered:
		t.Fatal("second request overlapped first body")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if clock.Now().Sub(time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)) < 3*time.Second {
		t.Fatal("global 3s interval missing")
	}
	h := http.Header{}
	h.Set("Retry-After", clock.Now().Add(9*time.Second).Format(http.TimeFormat))
	h.Set("X-Rate-Limit-Limit", "1")
	h.Set("X-Rate-Limit-Interval", "7s")
	clockBefore := clock.Now()
	c.Public.Limiter.observe("crossref", h)
	unlock, err := c.Public.Limiter.acquire(t.Context(), "crossref")
	if err != nil {
		t.Fatal(err)
	}
	unlock()
	if clock.Now().Sub(clockBefore) < 9*time.Second {
		t.Fatal("HTTP-date retry ignored")
	}
	clockBefore = clock.Now()
	unlock, err = c.Public.Limiter.acquire(t.Context(), "crossref")
	if err != nil {
		t.Fatal(err)
	}
	unlock()
	if clock.Now().Sub(clockBefore) < 7*time.Second {
		t.Fatal("stricter service quota ignored")
	}
}

func TestScholarGlobalCanonicalHostReads(t *testing.T) {
	for _, tc := range []struct {
		first, second string
		interval      time.Duration
	}{
		{"arxiv.org.", "arxiv.org", 3 * time.Second},
		{"ExPoRt.ArXiV.Org.", "ARXIV.ORG.", 3 * time.Second},
		{"API.CROSSREF.ORG.", "api.crossref.org", time.Second},
	} {
		t.Run(tc.first, func(t *testing.T) {
			entered := make(chan struct{}, 3)
			release := make(chan struct{})
			var calls atomic.Int32
			c, _, clock := publicFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Host != tc.first && r.Host != tc.second {
					t.Errorf("original Host lost: %s", r.Host)
				}
				entered <- struct{}{}
				if calls.Add(1) == 1 {
					<-release
				}
				fmt.Fprint(w, "<p>Article.</p>")
			})
			other := New(64 << 20)
			other.Public = c.Public
			start := clock.Now()
			first := make(chan error, 1)
			go func() { _, err := c.FetchPublic(t.Context(), "http://"+tc.first+"/paper", "html"); first <- err }()
			<-entered
			ctx, cancel := context.WithCancel(t.Context())
			queued := make(chan error, 1)
			go func() { _, err := other.FetchPublic(ctx, "http://"+tc.second+"/paper", "html"); queued <- err }()
			select {
			case <-entered:
				t.Error("equivalent source bypassed occupied global slot")
			case <-time.After(20 * time.Millisecond):
			}
			cancel()
			if err := <-queued; !errors.Is(err, context.Canceled) {
				t.Errorf("queued cancellation lost: %v", err)
			}
			close(release)
			if err := <-first; err != nil {
				t.Fatal(err)
			}
			if _, err := other.FetchPublic(t.Context(), "http://"+tc.second+"/next", "html"); err != nil {
				t.Fatal(err)
			}
			if elapsed := clock.Now().Sub(start); elapsed < tc.interval {
				t.Fatalf("source interval bypassed: %s", elapsed)
			}
			if calls.Load() != 2 {
				t.Fatalf("canceled queue issued network request: %d", calls.Load())
			}
		})
	}
}
