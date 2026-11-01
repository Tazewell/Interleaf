package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadQuickPDFTextBeforeLayout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/text") {
			_ = json.NewEncoder(w).Encode(documentText{DocumentID: testDocuments[0].ID, Type: "pdf", Units: 2, Parsed: false, Blocks: []textBlock{{ID: "quick-1", Unit: 1, Text: "Quick native source."}}})
		} else {
			_ = json.NewEncoder(w).Encode(testDocuments)
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "server.json"), []byte(fmtJSON(discovery{URL: server.URL, Token: "secret"})), 0600)
	t.Setenv("INTERLEAF_DATA", dir)
	for _, side := range []string{"source", "both"} {
		out, err := runCLI(t, "read", "oze", "--side", side)
		if err != nil || !strings.Contains(out, "Quick native source.") {
			t.Fatalf("%s rejected quick source: %q %v", side, out, err)
		}
	}
	if _, err := runCLI(t, "read", "oze", "--side", "translation"); err == nil {
		t.Fatal("quick source was offered as a translation")
	}
}

func fmtJSON(value any) string { data, _ := json.Marshal(value); return string(data) }
