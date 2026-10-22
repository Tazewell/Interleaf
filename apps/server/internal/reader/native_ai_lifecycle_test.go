package reader

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNativeCloseJoinsAllAIIO(t *testing.T) {
	started := make(chan struct{})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			fmt.Fprint(w, `{"data":[{"id":"model"}]}`)
			return
		}
		close(started)
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
		}
	}))
	defer endpoint.Close()
	s := nativeTestServer(t)
	raw := `{"version":2,"connection":{"protocol":"openai","url":"` + endpoint.URL + `/v1","key":null},"models":{"chat":"model"}}`
	request(t, s, "PUT", "/api/ai/config", bytes.NewBufferString(raw))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		r := httptest.NewRequest("POST", "/api/ai/check", bytes.NewBufferString(`{"role":"chat","model":"model"}`)).WithContext(ctx)
		s.checkNativeAI(httptest.NewRecorder(), r)
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("probe never reached API")
	}
	s.Close()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		cancel()
		<-done
		t.Fatal("Close returned while model check I/O was still running")
	}
}
