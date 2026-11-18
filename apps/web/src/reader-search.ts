import { useEffect, useState } from "react";
import type { ReaderAdapter, SearchResult } from "@interleaf/core";

type SearchReader = Pick<ReaderAdapter, "search">;
type SearchRequest = { documentId: string; query: string };
type SearchOutcome = {
  request: SearchRequest;
  reader: SearchReader;
  scope: number;
} & ({ results: SearchResult[] } | { error: string });
const noResults: SearchResult[] = [];

function sourceSide(result: SearchResult) {
  return (
    result.side ?? (result.location.translation ? "translation" : "source")
  );
}

function selectedResult(results: SearchResult[], previous?: SearchResult) {
  if (!previous) return undefined;
  const exact = results.find((result) => result.id === previous.id);
  if (exact) return exact.id;
  const origin = previous.location;
  const sameSection = results.filter((result) => {
    const target = result.location;
    if (sourceSide(result) !== sourceSide(previous)) return false;
    if (origin.type === "pdf")
      return target.type === "pdf" && target.page === origin.page;
    return target.type === "epub" && target.href === origin.href;
  });
  if (sameSection.length === 1) return sameSection[0].id;
  const matchesText = sameSection.filter(
    (result) =>
      result.excerpt === previous.excerpt &&
      (!previous.blockId ||
        !result.blockId ||
        previous.blockId === result.blockId),
  );
  if (matchesText.length === 1) return matchesText[0].id;
  return undefined;
}

export function useReaderSearch(
  documentId: string,
  reader?: SearchReader,
  scope = 0,
) {
  const [request, setRequest] = useState<SearchRequest>();
  const [outcome, setOutcome] = useState<SearchOutcome>();
  const [selected, setSelected] = useState<SearchResult>();
  const current = request?.documentId === documentId ? request : undefined;
  const settled =
    outcome?.request === current &&
    outcome?.reader === reader &&
    outcome?.scope === scope
      ? outcome
      : undefined;

  useEffect(() => {
    if (!current || !reader) return;
    let active = true;
    void (async () => {
      try {
        const results = await reader.search(current.query);
        if (active) setOutcome({ request: current, reader, scope, results });
      } catch (error) {
        if (active)
          setOutcome({
            request: current,
            reader,
            scope,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [current, reader, scope]);

  function clear() {
    setRequest(undefined);
    setOutcome(undefined);
    setSelected(undefined);
  }

  function submit(query: string) {
    const text = query.trim();
    clear();
    if (text) setRequest({ documentId, query: text });
  }

  const results = settled && "results" in settled ? settled.results : noResults;
  const error = settled && "error" in settled ? settled.error : undefined;
  const status = !current
    ? "idle"
    : !reader
      ? "waiting"
      : !settled
        ? "searching"
        : error !== undefined
          ? "error"
          : "complete";
  return {
    results,
    error,
    status,
    searchedQuery: status === "complete" ? (current?.query ?? "") : "",
    selectedId: selectedResult(results, selected),
    select: setSelected,
    submit,
    clear,
  };
}
