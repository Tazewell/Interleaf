import { useEffect, useRef, useState } from "react";
import { researchAPI } from "@reader/api";
import type { DocumentLocation, ResearchEvidence } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { researchSignal } from "./research-session";
import { ResearchCitationNavigation } from "./citations";
import { researchLocationLabel } from "./research-locations";

export function localResearchLocation(
  source: ResearchEvidence,
): DocumentLocation | undefined {
  if (
    source.availability !== "valid" ||
    !source.documentId ||
    !["local-page", "local-passage"].includes(source.kind)
  )
    return;
  const location = source.location as Partial<DocumentLocation> | null;
  if (!location || typeof location !== "object") return;
  if (
    location.type === "pdf" &&
    Number.isInteger(location.page) &&
    location.page! > 0
  )
    return location as DocumentLocation;
  if (
    location.type === "epub" &&
    typeof location.href === "string" &&
    location.href
  )
    return location as DocumentLocation;
}
export function ResearchSources({
  topicId,
  sourceIds,
  onOpenDocument,
  children,
}: {
  topicId: string;
  sourceIds: string[];
  onOpenDocument: (id: string, location: DocumentLocation) => Promise<void>;
  children?: React.ReactNode;
}) {
  const [source, setSource] = useState<ResearchEvidence>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setSource(undefined);
    setError("");
    setLoading(false);
    return () => pending.current?.abort();
  }, [topicId, sourceIds]);
  const navigate = async (id: string) => {
    if (!sourceIds.includes(id)) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const signal = AbortSignal.any([controller.signal, researchSignal()]);
    setLoading(true);
    setError("");
    setSource(undefined);
    try {
      const fresh = await researchAPI.getSource(id, signal);
      if (signal.aborted || fresh.id !== id || fresh.topicId !== topicId)
        return;
      setSource(fresh);
      const location = localResearchLocation(fresh);
      if (location) await onOpenDocument(fresh.documentId!, location);
      else if (fresh.availability !== "valid")
        setError("来源已失效，历史报告和用户笔记仍可查看和编辑。");
    } catch (error) {
      if (!signal.aborted) setError(`来源不可用：${(error as Error).message}`);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  };
  const labels = {
    "local-passage": "本地原文段落",
    "local-page": "本地 PDF 页",
    "remote-abstract": "仅摘要",
    "remote-html": "网页段落",
    "remote-page": "在线 PDF 页",
  };
  return (
    <ResearchCitationNavigation.Provider
      value={{ sourceIds, navigate: (id) => void navigate(id) }}
    >
      {children}
      <section aria-label="研究来源" className="space-y-2">
        <h3 className="text-sm font-medium">来源</h3>
        <div className="flex flex-wrap gap-1">
          {sourceIds.map((id, index) => (
            <Button
              key={id}
              size="xs"
              variant="outline"
              onClick={() => void navigate(id)}
              aria-label={`来源 ${index + 1}`}
            >
              [{index + 1}]
            </Button>
          ))}
        </div>
        {loading && <p role="status">正在校验来源…</p>}
        {error && <p role="alert">{error}</p>}
        {source && (
          <div className="rounded-md border p-3 text-sm">
            <p>
              {labels[source.kind]} ·{" "}
              {source.availability === "valid" ? "有效" : "已失效"} ·{" "}
              {source.readAt}
            </p>
            {source.kind !== "remote-abstract" && (
              <p>{researchLocationLabel(source.location)}</p>
            )}
            <p className="whitespace-pre-wrap">{source.excerpt}</p>
          </div>
        )}
      </section>
    </ResearchCitationNavigation.Provider>
  );
}
