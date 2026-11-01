package interleaf

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
)

func TestConnectorIndependentDistribution(t *testing.T) {
	data, err := os.ReadFile("../../../connector/identity.json")
	if err != nil {
		t.Fatal(err)
	}
	var identity struct{ Port, DevelopmentKey, ExtensionID string }
	if err := json.Unmarshal(data, &identity); err != nil {
		t.Fatal(err)
	}
	key, err := base64.StdEncoding.DecodeString(identity.DevelopmentKey)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(key)
	id := []byte(hex.EncodeToString(digest[:16]))
	for i, c := range id {
		if c <= '9' {
			id[i] = 'a' + c - '0'
		} else {
			id[i] = 'a' + c - 'a' + 10
		}
	}
	if string(id) != identity.ExtensionID {
		t.Fatal("public key and extension ID differ")
	}
	s := testServer(t)
	r := httptest.NewRequest("GET", "http://127.0.0.1:"+identity.Port+"/v1/status", nil)
	r.Header.Set("Origin", "chrome-extension://"+string(id))
	w := httptest.NewRecorder()
	s.ConnectorHandler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("own extension cannot connect: %d %s", w.Code, w.Body.String())
	}
	// Another application on a different port must not be claimed as this bridge.
	r.Host = "127.0.0.1:17841"
	w = httptest.NewRecorder()
	s.ConnectorHandler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("foreign port accepted: %d", w.Code)
	}
}
