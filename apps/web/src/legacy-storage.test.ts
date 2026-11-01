import { expect, it } from "vitest";
import { migrateLegacyStorage } from "./legacy-storage";

it("preserves saved sessions, export preferences and the browser auth session", () => {
  const values = new Map([
    ["reader.chat-session.doc", "session"],
    ["reader.notes-export", '["notes"]'],
    ["reader-session", "local-token"],
    ["unrelated", "keep"],
  ]);
  const storage = {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  migrateLegacyStorage(storage);
  expect(values.get("interleaf.chat-session.doc")).toBe("session");
  expect(values.get("interleaf.notes-export")).toBe('["notes"]');
  expect(values.get("interleaf-session")).toBe("local-token");
  expect(values.get("unrelated")).toBe("keep");
  expect(values.get("reader.notes-export")).toBe('["notes"]');
  values.set("reader.notes-export", "old");
  migrateLegacyStorage(storage);
  expect(values.get("interleaf.notes-export")).toBe('["notes"]');
});

it("lets the application start when browser storage is unavailable", () => {
  expect(() =>
    migrateLegacyStorage({
      get length(): number {
        throw new Error("storage denied");
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {},
    }),
  ).not.toThrow();
});
