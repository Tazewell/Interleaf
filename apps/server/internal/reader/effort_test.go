package reader

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestEffortPersistsAndRejectsNativeOnlyValues(t *testing.T) {
	s := testServer(t)
	body := `{"version":2,"connection":{"protocol":"openai","url":"http://127.0.0.1:1","key":null},"models":{"chat":"model"},"efforts":{"chat":"max"}}`
	if r := request(t, s, "PUT", "/api/ai/config", strings.NewReader(body)); r.Code != 200 {
		t.Fatal(r.Body)
	}
	omitted := strings.Replace(body, `,"efforts":{"chat":"max"}`, "", 1)
	if r := request(t, s, "PUT", "/api/ai/config", strings.NewReader(omitted)); r.Code != 200 {
		t.Fatal(r.Body)
	}
	saved, err := s.nativeAIConfig()
	if err != nil || saved.Efforts[taskChat] != "max" {
		t.Fatal("effort lost", saved, err)
	}
	for _, v := range []string{"xhigh", "ultra", "on", "invalid"} {
		if r := request(t, s, "PUT", "/api/ai/config", strings.NewReader(strings.Replace(body, "max", v, 1))); r.Code != 400 {
			t.Fatal("accepted", v)
		}
	}

}

func configJSON(c AIConfig) *bytes.Reader { b, _ := json.Marshal(c); return bytes.NewReader(b) }
