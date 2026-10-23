package scholar

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Clock keeps waiting cancellable and lets protocol tests advance virtual time.
type Clock interface {
	Now() time.Time
	Sleep(context.Context, time.Duration) error
}
type wallClock struct{}

func (wallClock) Now() time.Time { return time.Now() }
func (wallClock) Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

type sourceSlot struct {
	gate     chan struct{}
	next     time.Time
	interval time.Duration
}
type SourceLimiter struct {
	clock Clock
	mu    sync.Mutex
	slots map[string]*sourceSlot
}

func NewSourceLimiter(clock Clock) *SourceLimiter {
	if clock == nil {
		clock = wallClock{}
	}
	return &SourceLimiter{clock: clock, slots: map[string]*sourceSlot{}}
}

var globalSourceLimiter = NewSourceLimiter(wallClock{})

func (l *SourceLimiter) slot(source string) *sourceSlot {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.slots[source]
	if s == nil {
		interval := time.Second
		if source == "arxiv" {
			interval = 3 * time.Second
		}
		s = &sourceSlot{gate: make(chan struct{}, 1), interval: interval}
		l.slots[source] = s
	}
	return s
}
func (l *SourceLimiter) acquire(ctx context.Context, source string) (func(), error) {
	if source == "" {
		return func() {}, ctx.Err()
	}
	s := l.slot(source)
	select {
	case s.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	release := func() { <-s.gate }
	if err := ctx.Err(); err != nil {
		release()
		return nil, err
	}
	l.mu.Lock()
	wait := s.next.Sub(l.clock.Now())
	l.mu.Unlock()
	if wait > 0 {
		if err := l.clock.Sleep(ctx, wait); err != nil {
			release()
			return nil, err
		}
	}
	l.mu.Lock()
	s.next = l.clock.Now().Add(s.interval)
	l.mu.Unlock()
	return release, nil
}
func retryDelay(value string, now time.Time) time.Duration {
	if seconds, err := strconv.ParseUint(strings.TrimSpace(value), 10, 32); err == nil {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil && at.After(now) {
		return at.Sub(now)
	}
	return 0
}
func (l *SourceLimiter) observe(source string, h http.Header) {
	if source == "" {
		return
	}
	s := l.slot(source)
	l.mu.Lock()
	defer l.mu.Unlock()
	if source == "crossref" {
		interval, err := time.ParseDuration(h.Get("X-Rate-Limit-Interval"))
		n, e := strconv.Atoi(h.Get("X-Rate-Limit-Limit"))
		if err == nil && e == nil && n > 0 && interval/time.Duration(n) > s.interval {
			s.interval = interval / time.Duration(n)
		}
	}
	next := l.clock.Now().Add(s.interval)
	if next.After(s.next) {
		s.next = next
	}
	if delay := retryDelay(h.Get("Retry-After"), l.clock.Now()); delay > 0 && l.clock.Now().Add(delay).After(s.next) {
		s.next = l.clock.Now().Add(delay)
	}
}

type publicReservationKey struct{}

// WithPublicReservation charges each real GET (including retries/redirects)
// before I/O. A cache hit does not consume another network request.
func WithPublicReservation(ctx context.Context, reserve func(context.Context) error) context.Context {
	return context.WithValue(ctx, publicReservationKey{}, reserve)
}
func reservePublic(ctx context.Context) error {
	if f, ok := ctx.Value(publicReservationKey{}).(func(context.Context) error); ok {
		return f(ctx)
	}
	return ctx.Err()
}
