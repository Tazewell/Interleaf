package interleaf

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func catalogRequest(s *Server, refresh bool) *httptest.ResponseRecorder {
	path := "/api/ai/models?role=chat"
	if refresh {
		path += "&refresh=1"
	}
	w := httptest.NewRecorder()
	s.agentModels(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

func TestCatalogSuccessExcludesSavedHistory(t *testing.T) {
	s := nativeTestServer(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data":[{"id":"current"}]}`)
	}))
	defer upstream.Close()
	stored := nativeAIStored{Connection: APIConnection{URL: upstream.URL + "/v1", Key: "fake-key", Protocol: "openai"}, Config: NativeAIConfig{APIModels: []string{"historical"}}}
	models, err := s.nativeAIModels(t.Context(), stored)
	if err != nil || len(models) != 1 || models[0].ID != "current" {
		t.Fatalf("successful catalog contains history: %+v, %v", models, err)
	}
	if len(stored.Config.APIModels) != 1 || stored.Config.APIModels[0] != "historical" {
		t.Fatal("listing changed saved history")
	}
}

func TestCatalogFailureDoesNotBecomeHistoricalSuccess(t *testing.T) {
	s := nativeTestServer(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer upstream.Close()
	stored := nativeAIStored{Connection: APIConnection{URL: upstream.URL + "/v1", Key: "fake-key", Protocol: "openai"}, Config: NativeAIConfig{APIModels: []string{"historical"}}}
	models, err := s.nativeAIModels(t.Context(), stored)
	if err == nil || len(models) != 0 {
		t.Fatalf("failed catalog presented as success: %+v, %v", models, err)
	}
}

func TestCatalogRefreshBypassesCacheAndEvictsFailedRefresh(t *testing.T) {
	s := nativeTestServer(t)
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := requests.Add(1)
		if n == 3 {
			w.WriteHeader(503)
			return
		}
		fmt.Fprintf(w, `{"data":[{"id":"model-%d"}]}`, n)
	}))
	defer upstream.Close()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, fmt.Sprintf(`{"version":2,"connection":{"protocol":"openai","url":%q,"key":"fake-key"}}`, upstream.URL+"/v1")))
	if err != nil {
		t.Fatal(err)
	}
	for _, refresh := range []bool{false, false, true} {
		if w := catalogRequest(s, refresh); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("refresh reused five-minute cache: %d upstream requests", got)
	}
	if w := catalogRequest(s, true); w.Code != 502 {
		t.Fatalf("failed refresh returned %d: %s", w.Code, w.Body.String())
	}
	w := catalogRequest(s, false)
	if w.Code != 200 || requests.Load() != 4 {
		t.Fatalf("failed refresh retained previous cache: %d requests, %d %s", requests.Load(), w.Code, w.Body.String())
	}
}

func TestCatalogRefreshPreventsOlderDiscoveryRecaching(t *testing.T) {
	s := nativeTestServer(t)
	var requests atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := requests.Add(1)
		if n == 1 {
			close(started)
			<-release
		}
		fmt.Fprintf(w, `{"data":[{"id":"model-%d"}]}`, n)
	}))
	defer upstream.Close()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, fmt.Sprintf(`{"version":2,"connection":{"protocol":"openai","url":%q,"key":"fake-key"}}`, upstream.URL+"/v1")))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- catalogRequest(s, false) }()
	<-started
	fresh := catalogRequest(s, true)
	close(release)
	<-done
	cached := catalogRequest(s, false)
	if fresh.Code != 200 || cached.Body.String() != fresh.Body.String() || requests.Load() != 2 {
		t.Fatalf("older discovery overwrote refresh: fresh=%s cached=%s calls=%d", fresh.Body.String(), cached.Body.String(), requests.Load())
	}
}

func TestCatalogFailedRefreshPreventsOlderDiscoveryRecaching(t *testing.T) {
	s := nativeTestServer(t)
	var requests atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := requests.Add(1)
		if n == 1 {
			close(started)
			<-release
		}
		if n == 2 {
			w.WriteHeader(503)
			return
		}
		fmt.Fprintf(w, `{"data":[{"id":"model-%d"}]}`, n)
	}))
	defer upstream.Close()
	_, err := s.saveNativeAIConfig(nativeUpdate(t, fmt.Sprintf(`{"version":2,"connection":{"protocol":"openai","url":%q,"key":"fake-key"}}`, upstream.URL+"/v1")))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- catalogRequest(s, false) }()
	<-started
	failed := catalogRequest(s, true)
	close(release)
	<-done
	cached := catalogRequest(s, false)
	if failed.Code != 502 || cached.Code != 200 || requests.Load() != 3 {
		t.Fatalf("older discovery restored failed refresh: refresh=%d cached=%s calls=%d", failed.Code, cached.Body.String(), requests.Load())
	}
}

func TestCatalogRefreshOnlyInvalidatesExactConnection(t *testing.T) {
	s := nativeTestServer(t)
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"data":[{"id":"model-%d"}]}`, requests.Add(1))
	}))
	defer upstream.Close()
	connections := []APIConnection{
		{URL: upstream.URL + "/v1", Protocol: "openai", Key: "key-a"},
		{URL: upstream.URL + "/v2", Protocol: "openai", Key: "key-a"},
		{URL: upstream.URL + "/v1", Protocol: "anthropic", Key: "key-a"},
		{URL: upstream.URL + "/v1", Protocol: "openai", Key: "key-b"},
	}
	for _, conn := range connections {
		if _, err := s.apiCatalog(conn)(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if requests.Load() != 4 {
		t.Fatal("connection identity reused another catalog", requests.Load())
	}
	if _, err := s.apiCatalog(connections[0], true)(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, conn := range connections {
		if _, err := s.apiCatalog(conn)(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if requests.Load() != 5 {
		t.Fatal("refresh invalidated unrelated connections", requests.Load())
	}
}
