package interleaf

import (
	"fmt"
	"github.com/gofrs/flock"
	"os"
	"path/filepath"
)

// Keep the OS lock for the server lifetime. Kernel release also covers crashes.
func LockLibrary(root string) (func(), error) {
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	names := []string{"interleaf.lock"}
	if _, err := os.Stat(filepath.Join(root, legacyDatabaseName)); !os.IsNotExist(err) {
		names = append([]string{legacyLockName}, names...)
	}
	locks := []*flock.Flock{}
	unlock := func() {
		for i := len(locks) - 1; i >= 0; i-- {
			_ = locks[i].Unlock()
		}
	}
	for _, name := range names {
		lock := flock.New(filepath.Join(root, name))
		ok, err := lock.TryLock()
		if err != nil {
			unlock()
			return nil, err
		}
		if !ok {
			unlock()
			return nil, fmt.Errorf("书库已在另一个 Interleaf 实例中打开，请先关闭该实例")
		}
		locks = append(locks, lock)
	}
	return unlock, nil
}
