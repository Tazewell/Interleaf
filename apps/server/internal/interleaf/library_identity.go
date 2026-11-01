package interleaf

import (
	"os"
	"path/filepath"
)

// Existing libraries keep their database in place, including SQLite WAL files.
// A new library always uses the Interleaf name. Never replace either database.
const legacyDatabaseName = "reader.sqlite"
const legacyLockName = "reader.lock"

func libraryDatabasePath(root string) string {
	current := filepath.Join(root, "interleaf.sqlite")
	if _, err := os.Lstat(current); !os.IsNotExist(err) {
		return current
	}
	legacy := filepath.Join(root, legacyDatabaseName)
	if _, err := os.Lstat(legacy); !os.IsNotExist(err) {
		return legacy
	}
	return current
}
