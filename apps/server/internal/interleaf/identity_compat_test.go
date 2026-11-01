package interleaf

import (
	"database/sql"
	"encoding/json"
	"github.com/gofrs/flock"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFreshLibraryUsesInterleafDatabase(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	if _, err := os.Stat(filepath.Join(root, "interleaf.sqlite")); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyLibraryPreservesStoredData(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "reader.sqlite")
	db, err := sql.Open("sqlite", legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("CREATE TABLE identity_sentinel(value TEXT); INSERT INTO identity_sentinel VALUES ('preserved')"); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	var got string
	if err := store.DB.QueryRow("SELECT value FROM identity_sentinel").Scan(&got); err != nil || got != "preserved" {
		t.Fatalf("legacy data: %q %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(root, "interleaf.sqlite")); !os.IsNotExist(err) {
		t.Fatalf("created competing database: %v", err)
	}
}

func TestLegacyLibraryKeepsOriginalWriterLock(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, legacyDatabaseName), nil, 0600); err != nil {
		t.Fatal(err)
	}
	old := flock.New(filepath.Join(root, legacyLockName))
	if err := old.Lock(); err != nil {
		t.Fatal(err)
	}
	defer old.Unlock()
	if unlock, err := LockLibrary(root); err == nil {
		unlock()
		t.Fatal("opened a library while its legacy writer still owns the lock")
	}
}

func TestCanonicalDatabaseNeverOverwritesLegacyDatabase(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"interleaf.sqlite", legacyDatabaseName} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if got := libraryDatabasePath(root); got != filepath.Join(root, "interleaf.sqlite") {
		t.Fatal(got)
	}
}

func TestLegacySettingsAreCopiedWithoutReplacingNewPreferences(t *testing.T) {
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, legacyDatabaseName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('reader','{"appearance":"dark","autoTranslatePDF":false}')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	var got string
	if err := store.DB.QueryRow("SELECT value FROM settings WHERE key='interleaf'").Scan(&got); err != nil || !strings.Contains(got, "dark") {
		t.Fatalf("settings lost: %q %v", got, err)
	}
	if _, err := store.DB.Exec(`UPDATE settings SET value='{"appearance":"light"}' WHERE key='interleaf'`); err != nil {
		t.Fatal(err)
	}
	store.DB.Close()
	store, err = OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	if err := store.DB.QueryRow("SELECT value FROM settings WHERE key='interleaf'").Scan(&got); err != nil || !strings.Contains(got, "light") {
		t.Fatalf("new settings replaced: %q %v", got, err)
	}
}

func TestLegacyNativeProtocolStateRemainsCompatible(t *testing.T) {
	// The stored connection identity is a protocol format, independent of product branding.
	if !strings.HasPrefix(nativeConnectionKey(nativeTaskSnapshot{}), "reader-native-v1:") {
		t.Error("invalidated existing document and research conversation identity")
	}
	var message toolCompletionMessage
	if err := json.Unmarshal([]byte(`{"role":"user","content":"original","readerImages":[{"sourceId":"attachment:original"}],"readerPageImages":[{"sourceId":"page:original","page":3}]}`), &message); err != nil {
		t.Fatal(err)
	}
	if len(message.NativeImages) != 1 || message.NativeImages[0].SourceID != "attachment:original" || len(message.PageImages) != 1 || message.PageImages[0].Page != 3 {
		t.Fatalf("lost original image context: %+v", message)
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), "interleafImages") || strings.Contains(string(encoded), "readerImages") {
		t.Fatal("new messages do not use the current format")
	}
}
