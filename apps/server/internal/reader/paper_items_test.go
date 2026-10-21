package reader

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func paperCall(t *testing.T, s *Server, method, path, body string, status int) map[string]any {
	t.Helper()
	w := request(t, s, method, path, strings.NewReader(body))
	if w.Code != status {
		t.Fatalf("%s %s: %d %s (want %d)", method, path, w.Code, w.Body.String(), status)
	}
	var v map[string]any
	if status != 204 {
		if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
	}
	return v
}
func paperCreate(t *testing.T, s *Server, title string) string {
	t.Helper()
	return paperCall(t, s, "POST", "/api/papers", `{"title":"`+title+`","author":"Ada Lovelace","metadata":{"date":"2026","creators":[{"family":"Lovelace","given":"Ada"}]}}`, 201)["id"].(string)
}
func paperSeed(t *testing.T, s *Store, id string) {
	t.Helper()
	_, err := s.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library) VALUES(?,'pdf','Old','Ada',5,'2026','2026','papers')`, id)
	if err != nil {
		t.Fatal(err)
	}
}
func paperList(t *testing.T, s *Server) []map[string]any {
	t.Helper()
	w := request(t, s, "GET", "/api/papers", nil)
	if w.Code != 200 {
		t.Fatalf("papers: %d %s", w.Code, w.Body.String())
	}
	var list []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	return list
}
func paperKeys(t *testing.T, s *Server, ids ...string) []map[string]any {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"ids": ids})
	w := request(t, s, "POST", "/api/papers/citation-keys", strings.NewReader(string(b)))
	if w.Code != 200 {
		t.Fatalf("keys: %d %s", w.Code, w.Body.String())
	}
	var list []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	return list
}

func TestPaperMetadataOnlyAndCompatibility(t *testing.T) {
	s := testServer(t)
	p := paperCreate(t, s, "Computing")
	got := paperCall(t, s, "GET", "/api/papers/"+p, "", 200)
	if len(got["attachments"].([]any)) != 0 {
		t.Fatal(got)
	}
	paperSeed(t, s.Store, "one")
	list := paperList(t, s)
	if len(list) != 2 {
		t.Fatal(list)
	}
	var old string
	for _, v := range list {
		if v["id"] != p {
			old = v["id"].(string)
		}
	}
	paperCall(t, s, "PATCH", "/api/documents/one", `{"title":"New","tags":["ML"],"metadata":{"date":"2025"}}`, 200)
	got = paperCall(t, s, "GET", "/api/papers/"+old, "", 200)
	if got["title"] != "New" || got["metadata"].(map[string]any)["date"] != "2025" {
		t.Fatal(got)
	}
	if _, err := s.applyFound("one", PaperMetadata{Venue: "Proceedings"}, "Lookup title", "lookup", "done"); err != nil {
		t.Fatal(err)
	}
	got = paperCall(t, s, "GET", "/api/papers/"+old, "", 200)
	if got["title"] != "New" || got["metadata"].(map[string]any)["venue"] != "Proceedings" {
		t.Fatal(got)
	}
	paperCall(t, s, "PATCH", "/api/papers/"+old, `{"author":"Grace","favorite":true,"folders":["Project"]}`, 200)
	d, err := s.Store.Document("one")
	if err != nil || d.Author != "Grace" || !d.Favorite || len(d.Folders) != 1 {
		t.Fatalf("%+v %v", d, err)
	}
	paperCall(t, s, "PATCH", "/api/papers/"+old, `{"title":"must rollback","metadata":{"date":"bad"}}`, 400)
	got = paperCall(t, s, "GET", "/api/papers/"+old, "", 200)
	if got["title"] != "New" {
		t.Fatal(got)
	}
}
func TestPaperAttachmentMergeTrashAndDetach(t *testing.T) {
	s := testServer(t)
	paperSeed(t, s.Store, "one")
	paperSeed(t, s.Store, "two")
	list := paperList(t, s)
	a, b := list[0]["id"].(string), list[1]["id"].(string)
	docA := list[0]["primaryDocumentId"].(string)
	docB := list[1]["primaryDocumentId"].(string)
	paperCall(t, s, "PUT", "/api/papers/"+a+"/attachments/"+docB, `{"role":"translation"}`, 409)
	paperCall(t, s, "POST", "/api/papers/"+a+"/merge", `{"ids":["`+b+`"]}`, 200)
	paperCall(t, s, "PUT", "/api/papers/"+a+"/attachments/"+docB, `{"role":"translation","primary":true}`, 200)
	got := paperCall(t, s, "GET", "/api/papers/"+a, "", 200)
	if len(got["attachments"].([]any)) != 2 || got["primaryDocumentId"] != docB {
		t.Fatal(got)
	}
	alias := paperCall(t, s, "GET", "/api/papers/"+b, "", 200)
	if alias["id"] != a {
		t.Fatal(alias)
	}
	paperCall(t, s, "PATCH", "/api/documents/"+docA, `{"title":"Shared"}`, 200)
	d, _ := s.Store.Document(docB)
	if d.Title != "Shared" {
		t.Fatal(d)
	}
	paperCall(t, s, "POST", "/api/papers/"+a+"/trash", `{}`, 200)
	if len(paperList(t, s)) != 0 {
		t.Fatal("trash visible")
	}
	d, _ = s.Store.Document(docA)
	if d.DeletedAt == "" {
		t.Fatal(d)
	}
	paperCall(t, s, "POST", "/api/papers/"+a+"/restore", `{}`, 200)
	d, _ = s.Store.Document(docB)
	if d.DeletedAt != "" {
		t.Fatal(d)
	}
	paperCall(t, s, "DELETE", "/api/papers/"+a+"/attachments/"+docB, "", 200)
	d, err := s.Store.Document(docB)
	if err != nil || d.DeletedAt != "" {
		t.Fatalf("detach deleted document: %+v %v", d, err)
	}
	got = paperCall(t, s, "GET", "/api/papers/"+a, "", 200)
	if got["primaryDocumentId"] != docA {
		t.Fatal(got)
	}
	paperCall(t, s, "DELETE", "/api/papers/"+a, "", 409)
}
func TestCitationKeyStableAtomicConcurrentAndTombstones(t *testing.T) {
	s := testServer(t)
	a := paperCreate(t, s, "Computing")
	b := paperCreate(t, s, "Computing")
	first := paperKeys(t, s, a)[0]["citationKey"].(string)
	if first == "" {
		t.Fatal("empty key")
	}
	paperCall(t, s, "PATCH", "/api/papers/"+a, `{"title":"Changed","author":"Different"}`, 200)
	keys := paperKeys(t, s, b, a)
	if keys[1]["citationKey"] != first || strings.EqualFold(keys[0]["citationKey"].(string), first) {
		t.Fatal(keys)
	}
	paperCall(t, s, "POST", "/api/papers/"+a+"/merge", `{"ids":["`+b+`"]}`, 409)
	paperCall(t, s, "PATCH", "/api/papers/"+b, `{"citationKey":"`+strings.ToUpper(first)+`"}`, 409)
	c := paperCreate(t, s, "Computing")
	w := request(t, s, "POST", "/api/papers/citation-keys", strings.NewReader(`{"ids":["`+c+`","missing"]}`))
	if w.Code != 404 {
		t.Fatal(w.Code, w.Body.String())
	}
	got := paperCall(t, s, "GET", "/api/papers/"+c, "", 200)
	if got["citationKey"] != "" {
		t.Fatal("partial allocation", got)
	}
	paperCall(t, s, "DELETE", "/api/papers/"+b, "", 204)
	if paperKeys(t, s, c)[0]["citationKey"] == keys[0]["citationKey"] {
		t.Fatal("reused deleted key")
	}
	ids := []string{}
	for i := 0; i < 8; i++ {
		ids = append(ids, paperCreate(t, s, "Computing"))
	}
	var wg sync.WaitGroup
	errs := make(chan string, len(ids))
	for _, p := range ids {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			w := request(t, s, "POST", "/api/papers/citation-keys", strings.NewReader(`{"ids":["`+p+`"]}`))
			if w.Code != 200 {
				errs <- w.Body.String()
			}
		}(p)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	seen := map[string]bool{}
	for _, v := range paperKeys(t, s, ids...) {
		k := strings.ToLower(v["citationKey"].(string))
		if seen[k] {
			t.Fatal("duplicate", k)
		}
		seen[k] = true
	}
	root := s.Store.Root
	s.Close()
	s.Store.DB.Close()
	reopened, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	again := NewServer(reopened, "test-secret", "")
	defer again.Close()
	if paperKeys(t, again, a)[0]["citationKey"] != first {
		t.Fatal("reopen changed key")
	}
}
func TestPaperMigrationPreservesReaderDataAndSnapshot(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := store.DB.Query(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'paper_%'`)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for rows.Next() {
		var n string
		rows.Scan(&n)
		names = append(names, n)
	}
	rows.Close()
	for _, n := range names {
		if _, err = store.DB.Exec(`DROP TRIGGER ` + n); err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"paper_detached_documents", "paper_attachments", "paper_redirects", "paper_citation_keys", "paper_items"} {
		if _, err = store.DB.Exec(`DROP TABLE IF EXISTS ` + table); err != nil {
			t.Fatal(err)
		}
	}
	os.Remove(filepath.Join(root, "reader.pre-paper-items.sqlite"))
	paperSeed(t, store, "legacy")
	_, err = store.DB.Exec(`UPDATE documents SET progress='{"type":"pdf","page":7}',percentage=0.5 WHERE id='legacy'; INSERT INTO annotations VALUES('mark','legacy','{"id":"mark","kind":"highlight"}'); INSERT INTO document_notes VALUES('legacy','retained note','2026'); INSERT INTO messages VALUES('chat','legacy','{"content":"retained chat"}','2026')`)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "papers", "legacy.pdf")
	os.WriteFile(file, []byte("original bytes"), 0600)
	store.DB.Close()
	for i := 0; i < 2; i++ {
		store, err = OpenStore(root)
		if err != nil {
			t.Fatal(err)
		}
		s := NewServer(store, "test-secret", "")
		list := paperList(t, s)
		if len(list) != 1 || list[0]["primaryDocumentId"] != "legacy" {
			t.Fatal(list)
		}
		d, err := store.Document("legacy")
		if err != nil || d.Percentage != 0.5 || !strings.Contains(string(d.Progress), "7") || d.HighlightCount != 1 {
			t.Fatalf("%+v %v", d, err)
		}
		for _, table := range []string{"document_notes", "messages"} {
			var n int
			store.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&n)
			if n != 1 {
				t.Fatal(table, n)
			}
		}
		s.Close()
		store.DB.Close()
	}
	bytes, err := os.ReadFile(file)
	if err != nil || string(bytes) != "original bytes" {
		t.Fatal(string(bytes), err)
	}
	if _, err = os.Stat(filepath.Join(root, "reader.pre-paper-items.sqlite")); err != nil {
		t.Fatal("missing snapshot", err)
	}
}

func TestPaperLabelsIncludeMetadataOnlyAndAttachments(t *testing.T) {
	s := testServer(t)
	p := paperCreate(t, s, "Independent")
	paperCall(t, s, "PATCH", "/api/papers/"+p, `{"tags":["old"],"folders":["Old/Child"]}`, 200)
	paperCall(t, s, "POST", "/api/libraries/papers/tags", `{"from":"old","to":"new"}`, 200)
	paperCall(t, s, "POST", "/api/libraries/papers/folders", `{"from":"Old","to":"New"}`, 200)
	got := paperCall(t, s, "GET", "/api/papers/"+p, "", 200)
	if got["tags"].([]any)[0] != "new" || got["folders"].([]any)[0] != "New/Child" {
		t.Fatal(got)
	}
}
func TestPaperPurgeAndReimportPreservesUnrelatedItem(t *testing.T) {
	s := testServer(t)
	paperSeed(t, s.Store, "one")
	paperSeed(t, s.Store, "two")
	d, _ := s.Store.Document("one")
	var doc map[string]any
	b, _ := json.Marshal(d)
	json.Unmarshal(b, &doc)
	p, ok := doc["paperId"].(string)
	if !ok {
		t.Fatal("missing paperId", doc)
	}
	paperKeys(t, s, p)
	paperCall(t, s, "POST", "/api/papers/"+p+"/trash", `{}`, 200)
	paperCall(t, s, "DELETE", "/api/papers/"+p, "", 204)
	if _, err := s.Store.Document("one"); err == nil {
		t.Fatal("purge retained file record")
	}
	if _, err := s.Store.Document("two"); err != nil {
		t.Fatal(err)
	}
	paperSeed(t, s.Store, "one")
	if len(paperList(t, s)) != 2 {
		t.Fatal(paperList(t, s))
	}
}
func TestPaperImportDeduplicatesAndLegacyLibraryMoves(t *testing.T) {
	s := testServer(t)
	data := sample(t, "reading-notes.pdf")
	w := uploadToFolder(t, s, "reading-notes.pdf", data, "papers", "Project")
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var d Document
	json.Unmarshal(w.Body.Bytes(), &d)
	if len(paperList(t, s)) != 1 {
		t.Fatal("import did not create paper")
	}
	w = uploadToFolder(t, s, "again.pdf", data, "papers", "Other")
	if w.Code != 200 || len(paperList(t, s)) != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	paperCall(t, s, "PATCH", "/api/documents/"+d.ID, `{"library":"books"}`, 200)
	paperCall(t, s, "PATCH", "/api/documents/"+d.ID, `{"library":"papers","tags":["moved"]}`, 200)
	d, err := s.Store.Document(d.ID)
	if err != nil || len(d.Tags) != 1 {
		t.Fatal(d, err)
	}
	for _, p := range paperList(t, s) {
		if p["primaryDocumentId"] == d.ID && p["tags"].([]any)[0] != "moved" {
			t.Fatal(p)
		}
	}
}
func TestPaperMergeConfirmedKeysKeepsReadingData(t *testing.T) {
	s := testServer(t)
	paperSeed(t, s.Store, "one")
	paperSeed(t, s.Store, "two")
	list := paperList(t, s)
	a, b := list[0]["id"].(string), list[1]["id"].(string)
	key := paperKeys(t, s, a, b)[1]["citationKey"].(string)
	_, err := s.Store.DB.Exec(`INSERT INTO annotations VALUES('mark','two','{"kind":"highlight"}');UPDATE documents SET progress='{"type":"pdf","page":5}',percentage=0.4 WHERE id='two'`)
	if err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "POST", "/api/papers/"+a+"/merge", `{"ids":["`+b+`"],"citationKey":"`+key+`","confirmCitationChange":true}`, 200)
	got := paperCall(t, s, "GET", "/api/papers/"+a, "", 200)
	if got["citationKey"] != key {
		t.Fatal(got)
	}
	d, err := s.Store.Document("two")
	if err != nil || d.HighlightCount != 1 || d.Percentage != 0.4 {
		t.Fatal(d, err)
	}
	c := paperCreate(t, s, "Third")
	paperCall(t, s, "PATCH", "/api/papers/"+c, `{"citationKey":"`+key+`"}`, 409)
}

func TestPaperLegacyPurgeReimportCanCreateNewItem(t *testing.T) {
	s := testServer(t)
	paperSeed(t, s.Store, "same")
	paperCall(t, s, "DELETE", "/api/documents/same", "", 204)
	paperSeed(t, s.Store, "same")
	d, err := s.Store.Document("same")
	if err != nil || d.ID != "same" {
		t.Fatal(d, err)
	}
}
func TestPaperTrashCancelsEachAttachmentTask(t *testing.T) {
	s := testServer(t)
	paperSeed(t, s.Store, "one")
	paperSeed(t, s.Store, "two")
	list := paperList(t, s)
	a, b := list[0]["id"].(string), list[1]["id"].(string)
	paperCall(t, s, "POST", "/api/papers/"+a+"/merge", `{"ids":["`+b+`"]}`, 200)
	for _, id := range []string{"one", "two"} {
		ctx, finish, err := s.beginDocumentTask(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		go func() { <-ctx.Done(); finish() }()
	}
	paperCall(t, s, "POST", "/api/papers/"+a+"/trash", `{}`, 200)
	for _, id := range []string{"one", "two"} {
		if _, _, err := s.beginDocumentTask(context.Background(), id); err == nil {
			t.Fatal("started trashed task")
		}
	}
	paperCall(t, s, "DELETE", "/api/papers/"+a, "", 204)
}
func TestPaperMigrationRejectsUnusableSnapshot(t *testing.T) {
	root := t.TempDir()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := s.DB.Query(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'paper_%'`)
	names := []string{}
	for rows.Next() {
		var n string
		rows.Scan(&n)
		names = append(names, n)
	}
	rows.Close()
	for _, n := range names {
		s.DB.Exec(`DROP TRIGGER ` + n)
	}
	for _, table := range []string{"paper_detached_documents", "paper_attachments", "paper_redirects", "paper_citation_keys", "paper_items"} {
		if _, err = s.DB.Exec(`DROP TABLE ` + table); err != nil {
			t.Fatal(err)
		}
	}
	s.DB.Close()
	path := filepath.Join(root, "reader.pre-paper-items.sqlite")
	os.Remove(path)
	if err = os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(root)
	if err == nil {
		reopened.DB.Close()
		t.Fatal("migration accepted directory as recovery snapshot")
	}
}

func TestPaperLegacyLibraryMoveHidesAndRestoresSameKey(t *testing.T) {
	s := testServer(t)
	paperSeed(t, s.Store, "one")
	p := paperList(t, s)[0]["id"].(string)
	key := paperKeys(t, s, p)[0]["citationKey"].(string)
	paperCall(t, s, "PATCH", "/api/documents/one", `{"library":"books"}`, 200)
	if len(paperList(t, s)) != 0 {
		t.Fatal("moved paper remains visible", paperList(t, s))
	}
	paperCall(t, s, "PATCH", "/api/documents/one", `{"library":"papers"}`, 200)
	list := paperList(t, s)
	if len(list) != 1 || list[0]["id"] != p || list[0]["citationKey"] != key {
		t.Fatal(list)
	}
}
func TestPaperLegacyMergeKeepsAttachmentsAndKeys(t *testing.T) {
	s := testServer(t)
	paperSeed(t, s.Store, "one")
	paperSeed(t, s.Store, "two")
	paperCall(t, s, "POST", "/api/documents/one/merge", `{"from":["two"]}`, 200)
	list := paperList(t, s)
	if len(list) != 1 || len(list[0]["attachments"].([]any)) != 2 {
		t.Fatal(list)
	}
	d, err := s.Store.Document("two")
	if err != nil || d.DeletedAt != "" {
		t.Fatal(d, err)
	}
}

func TestPaperAttachBookPreservesTargetMetadata(t *testing.T) {
	s := testServer(t)
	p := paperCreate(t, s, "Target authority")
	_, err := s.Store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,library) VALUES('book','epub','File title','File author',5,'2026','2026','books')`)
	if err != nil {
		t.Fatal(err)
	}
	got := paperCall(t, s, "PUT", "/api/papers/"+p+"/attachments/book", `{"role":"supplement","primary":true}`, 200)
	if got["title"] != "Target authority" {
		t.Fatal(got)
	}
}

func TestPaperMigrationFailureRollsBackSchemaAndReaderData(t *testing.T) {
	root := t.TempDir()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.DB.Query(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'paper_%'`)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	rows.Close()
	for _, name := range names {
		if _, err = s.DB.Exec(`DROP TRIGGER ` + name); err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"paper_detached_documents", "paper_attachments", "paper_redirects", "paper_citation_keys", "paper_items"} {
		if _, err = s.DB.Exec(`DROP TABLE ` + table); err != nil {
			t.Fatal(err)
		}
	}
	paperSeed(t, s, "legacy")
	if _, err = s.DB.Exec(`CREATE INDEX paper_items_key ON documents(title)`); err != nil {
		t.Fatal(err)
	}
	if err = s.migratePaperItems(); err == nil {
		t.Fatal("expected conflicting schema to reject migration")
	}
	var n int
	if err = s.DB.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name='paper_items'`).Scan(&n); err != nil || n != 0 {
		t.Fatal("partial migration", n, err)
	}
	if err = s.DB.QueryRow(`SELECT count(*) FROM documents WHERE id='legacy'`).Scan(&n); err != nil || n != 1 {
		t.Fatal("lost legacy document", n, err)
	}
	if _, err = s.DB.Exec(`DROP INDEX paper_items_key`); err != nil {
		t.Fatal(err)
	}
	if err = s.migratePaperItems(); err != nil {
		t.Fatal(err)
	}
	items, err := s.PaperItems()
	if err != nil || len(items) != 1 {
		t.Fatal(items, err)
	}
	s.DB.Close()
}

func assertPaperAuthority(t *testing.T, s *Server, want PaperItem, documentIDs ...string) {
	t.Helper()
	got, err := s.Store.PaperItem(want.ID)
	if err != nil {
		t.Fatal(err)
	}
	got.Attachments, want.Attachments = nil, nil
	got.PrimaryDocumentID, want.PrimaryDocumentID = "", ""
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("paper authority overwritten:\n got %+v\nwant %+v", got, want)
	}
	for _, id := range documentIDs {
		d, err := s.Store.Document(id)
		if err != nil {
			t.Fatal(err)
		}
		if d.Title != want.Title || d.Author != want.Author || !reflect.DeepEqual(d.Metadata, want.Metadata) || !reflect.DeepEqual(d.Tags, want.Tags) || !reflect.DeepEqual(d.Folders, want.Folders) || d.Favorite != want.Favorite || d.CitationKey != want.CitationKey || d.PaperID != want.ID {
			t.Fatalf("attachment %s did not receive authority: %+v", id, d)
		}
	}
}
func TestPaperReturnDetachedAttachmentKeepsCuratedAuthority(t *testing.T) {
	s := testServer(t)
	paperSeed(t, s.Store, "one")
	paperSeed(t, s.Store, "two")
	paperCall(t, s, "POST", "/api/documents/one/merge", `{"from":["two"]}`, 200)
	d, err := s.Store.Document("one")
	if err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "PATCH", "/api/documents/two", `{"library":"books"}`, 200)
	paperCall(t, s, "PATCH", "/api/papers/"+d.PaperID, `{"title":"New curated title","author":"Curated author","metadata":{"date":"2026","venue":"Curated venue","doi":"10.1234/curated","remark":"Keep this note"},"tags":["curated"],"folders":["Project/Curated"],"favorite":true,"citationKey":"Curated2026"}`, 200)
	want, err := s.Store.PaperItem(d.PaperID)
	if err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "PATCH", "/api/documents/two", `{"library":"papers"}`, 200)
	assertPaperAuthority(t, s, want, "one", "two")
	// Returning and explicitly editing in one request must apply just those edits
	// on top of the current paper, not resurrect the detached metadata snapshot.
	paperCall(t, s, "PATCH", "/api/documents/two", `{"library":"books"}`, 200)
	paperCall(t, s, "PATCH", "/api/papers/"+want.ID, `{"metadata":{"venue":"More recent venue"}}`, 200)
	paperCall(t, s, "PATCH", "/api/documents/two", `{"library":"papers","title":"Explicit title","author":"Explicit author","metadata":{"remark":"Explicit note"},"tags":["explicit"],"folders":["Project/Explicit"],"favorite":false}`, 200)
	want.Title = "Explicit title"
	want.Author = "Explicit author"
	want.Metadata.Venue = "More recent venue"
	want.Metadata.Remark = "Explicit note"
	want.Tags = []string{"explicit"}
	want.Folders = []string{"Project/Explicit"}
	want.Favorite = false
	assertPaperAuthority(t, s, want, "one", "two")
}
func TestPaperAttachPreviouslyDetachedBookKeepsTargetAuthority(t *testing.T) {
	s := testServer(t)
	paperSeed(t, s.Store, "old")
	paperCall(t, s, "PATCH", "/api/documents/old", `{"library":"books"}`, 200)
	p := paperCreate(t, s, "Target authority")
	paperCall(t, s, "PATCH", "/api/papers/"+p, `{"author":"Target author","metadata":{"date":"2025","venue":"Target venue","doi":"10.1234/target","remark":"Target note"},"tags":["target"],"folders":["Project/Target"],"favorite":true,"citationKey":"Target2025"}`, 200)
	want, err := s.Store.PaperItem(p)
	if err != nil {
		t.Fatal(err)
	}
	paperCall(t, s, "PUT", "/api/papers/"+p+"/attachments/old", `{"role":"translation","primary":true}`, 200)
	assertPaperAuthority(t, s, want, "old")
}

func removePaperSchema(t *testing.T, s *Store) {
	t.Helper()
	rows, err := s.DB.Query(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'paper_%'`)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	for _, name := range names {
		if _, err = s.DB.Exec(`DROP TRIGGER ` + name); err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"paper_detached_documents", "paper_attachments", "paper_redirects", "paper_citation_keys", "paper_items"} {
		if _, err = s.DB.Exec(`DROP TABLE ` + table); err != nil {
			t.Fatal(err)
		}
	}
}
func TestPaperSnapshotRejectsCorruptEmptyAndSymlink(t *testing.T) {
	for _, kind := range []string{"corrupt", "empty", "symlink", "unrelated"} {
		t.Run(kind, func(t *testing.T) {
			s := testServer(t)
			removePaperSchema(t, s.Store)
			paperSeed(t, s.Store, "keep")
			path := filepath.Join(s.Store.Root, "reader.pre-paper-items.sqlite")
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "corrupt":
				if err := os.WriteFile(path, []byte("not a SQLite backup"), 0600); err != nil {
					t.Fatal(err)
				}
			case "empty":
				if err := os.WriteFile(path, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "unrelated":
				unrelated, err := sql.Open("sqlite", path)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = unrelated.Exec(`CREATE TABLE unrelated(id TEXT)`); err != nil {
					t.Fatal(err)
				}
				if err = unrelated.Close(); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink(filepath.Join(s.Store.Root, "reader.sqlite"), path); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.Store.migratePaperItems(); err == nil {
				t.Fatal("accepted unsafe snapshot", kind)
			}
			var n int
			if err := s.Store.DB.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name='paper_items'`).Scan(&n); err != nil || n != 0 {
				t.Fatal("migration mutated schema", n, err)
			}
			if err := s.Store.DB.QueryRow(`SELECT count(*) FROM documents WHERE id='keep'`).Scan(&n); err != nil || n != 1 {
				t.Fatal("migration lost original data", n, err)
			}
		})
	}
}
func TestPaperSnapshotRetryCapturesNewReaderData(t *testing.T) {
	s := testServer(t)
	removePaperSchema(t, s.Store)
	paperSeed(t, s.Store, "before")
	path := filepath.Join(s.Store.Root, "reader.pre-paper-items.sqlite")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec(`CREATE INDEX paper_items_key ON documents(title)`); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.migratePaperItems(); err == nil {
		t.Fatal("expected failed migration")
	}
	old, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	paperSeed(t, s.Store, "after")
	if _, err = s.Store.DB.Exec(`INSERT INTO document_notes VALUES('after','new reader note','2026');DROP INDEX paper_items_key`); err != nil {
		t.Fatal(err)
	}
	if err = s.Store.migratePaperItems(); err != nil {
		t.Fatal(err)
	}
	retained, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(old, retained) {
		t.Fatal("overwrote previous snapshot", err)
	}
	snapshots, err := filepath.Glob(filepath.Join(s.Store.Root, "reader.pre-paper-items.*.sqlite"))
	if err != nil || len(snapshots) != 1 {
		t.Fatal("missing fresh retry snapshot", snapshots, err)
	}
	backup, err := sql.Open("sqlite", snapshots[0]+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	var note string
	if err = backup.QueryRow(`SELECT body FROM document_notes WHERE document_id='after'`).Scan(&note); err != nil || note != "new reader note" {
		t.Fatal("retry snapshot missing new reader data", note, err)
	}
	var n int
	if err = backup.QueryRow(`SELECT count(*) FROM documents`).Scan(&n); err != nil || n != 2 {
		t.Fatal("retry snapshot wrong documents", n, err)
	}
}
