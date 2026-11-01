type StoredPreferences = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem"
>;

/** Copy once, preserving the old values and any newer Interleaf preferences. */
export function migrateLegacyStorage(storage: StoredPreferences): void {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    );
    for (const old of keys) {
      if (!old || !(old.startsWith("reader.") || old === "reader-session"))
        continue;
      const next = `interleaf${old.slice("reader".length)}`;
      const value = storage.getItem(old);
      if (value !== null && storage.getItem(next) === null)
        storage.setItem(next, value);
    }
  } catch {
    /* Reading remains available when browser storage is restricted. */
  }
}
