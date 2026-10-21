package reader

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func exportFixture(t *testing.T) (*Server, string, string) {
	t.Helper()
	s := testServer(t)
	p := paperCreate(t, s, "Exported paper")
	paperCall(t, s, "PATCH", "/api/papers/"+p, `{"folders":["Project/Sub"],"metadata":{"date":"2025"}}`, 200)
	return s, p, filepath.Join(t.TempDir(), "references.bib")
}
func TestBibliographyExportOwnershipAndRefresh(t *testing.T) {
	s, p, path := exportFixture(t)
	e, err := s.Store.RegisterBibliographyExport(BibliographyExportRequest{Folder: "Project", IncludeChildren: true, Mode: "bibtex", Path: path})
	if err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	if !strings.Contains(string(before), "Exported paper") {
		t.Fatal(string(before))
	}
	paperCall(t, s, "PATCH", "/api/papers/"+p, `{"title":"Updated paper"}`, 200)
	if _, err = s.Store.RefreshBibliographyExport(e.ID); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if !strings.Contains(string(after), "Updated paper") {
		t.Fatal(string(after))
	}
	os.WriteFile(path, []byte("manual edit"), 0600)
	if _, err = s.Store.RefreshBibliographyExport(e.ID); err == nil {
		t.Fatal("external edit overwritten")
	}
	after, _ = os.ReadFile(path)
	if string(after) != "manual edit" {
		t.Fatal(string(after))
	}
	if _, err = s.Store.RegisterBibliographyExport(BibliographyExportRequest{Folder: "Elsewhere", Mode: "bibtex", Path: path, Takeover: true}); err == nil {
		t.Fatal("two exports own same path")
	}
}
func TestBibliographyExportTakeoverSymlinkAndFailure(t *testing.T) {
	s, _, path := exportFixture(t)
	os.WriteFile(path, []byte("original bibliography"), 0600)
	req := BibliographyExportRequest{Folder: "Project", IncludeChildren: true, Mode: "biblatex", Path: path}
	if _, err := s.Store.RegisterBibliographyExport(req); err == nil {
		t.Fatal("implicit takeover")
	}
	req.Takeover = true
	e, err := s.Store.RegisterBibliographyExport(req)
	if err != nil {
		t.Fatal(err)
	}
	matches, _ := filepath.Glob(path + ".reader-backup-*")
	if len(matches) != 1 {
		t.Fatal(matches)
	}
	saved, _ := os.ReadFile(matches[0])
	if string(saved) != "original bibliography" {
		t.Fatal(string(saved))
	}
	original, _ := os.ReadFile(path)
	// Removing ownership directory must preserve the last successfully exported bytes.
	moved := filepath.Dir(path) + "-moved"
	if err = os.Rename(filepath.Dir(path), moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Rename(moved, filepath.Dir(path)) })
	if _, err = s.Store.RefreshBibliographyExport(e.ID); err == nil {
		t.Fatal("missing directory accepted")
	}
	saved, _ = os.ReadFile(filepath.Join(moved, "references.bib"))
	if string(saved) != string(original) {
		t.Fatal("last good file damaged")
	}
	link := filepath.Join(t.TempDir(), "link.bib")
	if err = os.Symlink(filepath.Join(moved, "references.bib"), link); err != nil {
		t.Skip(err)
	}
	req.Path = link
	if _, err = s.Store.RegisterBibliographyExport(req); err == nil {
		t.Fatal("symlink accepted")
	}
}
func TestBibliographyExportFolderLifecycleAndEmpty(t *testing.T) {
	s, p, path := exportFixture(t)
	e, err := s.Store.RegisterBibliographyExport(BibliographyExportRequest{Folder: "Project", IncludeChildren: true, Mode: "bibtex", Path: path})
	if err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "POST", "/api/libraries/papers/folders", `{"from":"Project","to":"Renamed"}`, 200)
	if e, err = s.Store.RefreshBibliographyExport(e.ID); err != nil || e.Folder != "Renamed" {
		t.Fatal(e, err)
	}
	before, _ := os.ReadFile(path)
	paperCall(t, s, "POST", "/api/libraries/papers/folders", `{"from":"Renamed"}`, 200)
	if _, err = s.Store.RefreshBibliographyExport(e.ID); err == nil {
		t.Fatal("deleted folder not paused")
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(before) {
		t.Fatal("deleted folder cleared references")
	}
	empty := filepath.Join(t.TempDir(), "empty.bib")
	paperCall(t, s, "PATCH", "/api/papers/"+p, `{"folders":["Existing"]}`, 200)
	e, err = s.Store.RegisterBibliographyExport(BibliographyExportRequest{Folder: "Existing", Mode: "bibtex", Path: empty})
	if err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "PATCH", "/api/papers/"+p, `{"folders":[]}`, 200)
	if _, err = s.Store.RefreshBibliographyExport(e.ID); err != nil {
		t.Fatal(err)
	}
	after, _ = os.ReadFile(empty)
	if len(after) != 0 {
		t.Fatal("removed member remains in bibliography")
	}
}
func TestBibliographyExportCapabilityAndRestart(t *testing.T) {
	s, p, path := exportFixture(t)
	s.SetBibliographyExportCapability("main-only-secret")
	v, _ := json.Marshal(BibliographyExportRequest{Folder: "Project", IncludeChildren: true, Mode: "bibtex", Path: path})
	route := "/api/papers/exports"
	if got := request(t, s, "POST", route, strings.NewReader(string(v))); got.Code != 403 {
		t.Fatal(got.Code, got.Body.String())
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1:17840"+route, strings.NewReader(string(v)))
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("X-Reader-Export-Capability", "main-only-secret")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	paperCall(t, s, "PATCH", "/api/papers/"+p, `{"title":"After restart"}`, 200)
	root := s.Store.Root
	if err := s.Store.DB.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.DB.Close() })
	s.Store = reopened
	ctx, cancel := context.WithCancel(context.Background())
	done := s.StartBibliographyExports(ctx)
	deadline := time.Now().Add(4 * time.Second)
	for {
		b, _ := os.ReadFile(path)
		if strings.Contains(string(b), "After restart") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("startup refresh never ran")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	done()
}

func TestBibliographyExportCrossrefAndSymlinkDirectory(t *testing.T) {
	s := testServer(t)
	papers := paperBibImport(t, s, `@proceedings{parent,title={Proceedings},year=2025} @inproceedings{child,title={Child},crossref={parent}}`, []map[string]any{{"index": 0, "action": "create"}, {"index": 1, "action": "create"}})
	paperCall(t, s, "PATCH", "/api/papers/"+papers[1].ID, `{"folders":["Project/Sub"]}`, 200)
	parent := t.TempDir()
	dir := filepath.Join(parent, "target")
	os.Mkdir(dir, 0700)
	path := filepath.Join(dir, "refs.bib")
	e, err := s.Store.RegisterBibliographyExport(BibliographyExportRequest{Folder: "Project", Mode: "bibtex", IncludeChildren: true, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "@proceedings{parent") || !strings.Contains(string(b), "@inproceedings{child") {
		t.Fatal(string(b))
	}
	moved := filepath.Join(parent, "moved")
	if err = os.Rename(dir, moved); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(moved, dir); err != nil {
		t.Skip(err)
	}
	if _, err = s.Store.RefreshBibliographyExport(e.ID); err == nil {
		t.Fatal("replaced directory symlink accepted")
	}
	after, _ := os.ReadFile(filepath.Join(moved, "refs.bib"))
	if string(after) != string(b) {
		t.Fatal("symlink target modified")
	}
	excluded := filepath.Join(t.TempDir(), "exact.bib")
	if _, err = s.Store.RegisterBibliographyExport(BibliographyExportRequest{Folder: "Project", Mode: "bibtex", Path: excluded}); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(excluded)
	if len(b) != 0 {
		t.Fatal("child folder included without permission")
	}
}
