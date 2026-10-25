import { useEffect, useRef, useState } from "react";
import { researchAPI } from "@reader/api";
import type { ResearchCandidate, ResearchSearch } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import {
  finishResearchOperation,
  researchOperationID,
  researchSignal,
} from "./research-session";
import { MessageMarkdown } from "../chat/MessageMarkdown";
import { refreshLibrary } from "../store";
export function ResearchCandidates({
  topicId,
  candidates,
  searches,
}: {
  topicId: string;
  candidates: ResearchCandidate[];
  searches: ResearchSearch[];
}) {
  const locked = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [imported, setImported] = useState<string[]>([]);
  useEffect(() => () => controller.current?.abort(), [topicId]);
  const importCandidate = async (candidate: ResearchCandidate) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(candidate.id);
    setError("");
    const operation = `import:${topicId}:${candidate.id}`;
    const requestId = researchOperationID(operation);
    controller.current = new AbortController();
    const signal = AbortSignal.any([
      controller.current.signal,
      researchSignal(),
    ]);
    try {
      await researchAPI.importCandidate(
        topicId,
        candidate.id,
        requestId,
        signal,
      );
      if (signal.aborted) return;
      finishResearchOperation(operation, requestId);
      setImported((ids) => [...ids, candidate.id]);
      await refreshLibrary();
    } catch (error) {
      if (!signal.aborted) setError((error as Error).message);
    } finally {
      locked.current = false;
      if (!signal.aborted) setBusy("");
    }
  };
  return (
    <section aria-label="候选论文" className="space-y-3">
      <h3 className="font-medium">候选论文</h3>
      {!candidates.length && (
        <p className="text-sm text-muted-foreground">
          暂无候选。可使用“联网找论文”。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {candidates.map((candidate) => (
        <article key={candidate.id} className="space-y-2 rounded-lg border p-3">
          <h4>{candidate.title}</h4>
          <p className="text-sm text-muted-foreground">
            {candidate.authors} · {candidate.publishedAt} ·{" "}
            {candidate.doi || candidate.arxiv}
          </p>
          <p className="text-sm whitespace-pre-wrap">{candidate.abstract}</p>
          {candidate.landingUrl && (
            <MessageMarkdown content={candidate.landingUrl} animated={false} />
          )}
          <Button
            variant="outline"
            size="sm"
            aria-label={`导入${candidate.title}`}
            disabled={
              !!busy ||
              !!candidate.documentId ||
              imported.includes(candidate.id)
            }
            onClick={() => void importCandidate(candidate)}
          >
            {candidate.documentId || imported.includes(candidate.id)
              ? "已导入"
              : busy === candidate.id
                ? "导入中…"
                : "导入论文"}
          </Button>
        </article>
      ))}
      <details>
        <summary className="text-sm">检索记录与覆盖</summary>
        {searches.map((search) => (
          <p key={search.id} className="text-sm">
            {search.source} · {search.query} ·{" "}
            {search.status === "ok"
              ? "已返回"
              : search.status === "limited"
                ? "受限"
                : "失败"}{" "}
            · {search.fetchedAt} {search.error}
          </p>
        ))}
      </details>
    </section>
  );
}
