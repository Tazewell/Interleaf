// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SearchResult } from "@interleaf/core";
import { useReaderSearch } from "./reader-search";

const result: SearchResult = {
  id: "match-2",
  excerpt: "Second match",
  location: { type: "pdf", page: 4 },
};
type Reader = { search: (query: string) => Promise<SearchResult[]> };
let host: HTMLDivElement, root: Root;
let search: ReturnType<typeof useReaderSearch>;
function Harness({ docId, reader }: { docId: string; reader?: Reader }) {
  search = useReaderSearch(docId, reader);
  return null;
}
async function render(reader?: Reader, docId = "paper") {
  await act(async () => root.render(<Harness docId={docId} reader={reader} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("reissues the submitted search for the replacement reader and preserves the selected match", async () => {
  const source = { search: vi.fn(async () => [result]) };
  const reanchored = {
    ...result,
    id: "source-match-2",
    side: "source" as const,
  };
  const split = {
    search: vi.fn(async () => [
      reanchored,
      {
        ...reanchored,
        id: "match-3",
        location: { type: "pdf" as const, page: 5 },
      },
    ]),
  };
  await render(source);
  await act(async () => search.submit("term"));
  await act(async () => search.select(result));

  await render();
  expect(search.status).toBe("waiting");
  await render(split);
  expect(split.search).toHaveBeenCalledExactlyOnceWith("term");
  expect(search.status).toBe("complete");
  expect(search.results).toHaveLength(2);
  expect(search.selectedId).toBe(reanchored.id);
});

it("ignores delayed results from a detached reader and clears the query on document change", async () => {
  let finish!: (results: SearchResult[]) => void;
  await render({ search: () => new Promise((resolve) => (finish = resolve)) });
  await act(async () => search.submit("old reader"));
  const next = { search: vi.fn(async () => []) };
  await render(next);
  await act(async () => finish([result]));
  expect(search.results).toEqual([]);
  expect(search.searchedQuery).toBe("old reader");

  await render(next, "new-doc");
  expect(next.search).toHaveBeenCalledTimes(1);
  expect(search.status).toBe("idle");
  expect(search.searchedQuery).toBe("");
});
