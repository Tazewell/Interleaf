import {
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import type {
  Annotation,
  Document,
  DocumentLocation,
  PDFBlock,
  ReaderAdapter,
  ReaderEvents,
  ReaderTheme,
  TOCItem,
  TranslationBlock,
  NativePDFReadingLayout,
} from "@interleaf/core";
import { api } from "@interleaf/api";
import { Button } from "@interleaf/ui/components/button";
import { CircleNotch } from "@phosphor-icons/react";
import { toast } from "sonner";
import { InterleafView } from "../InterleafView";
import { NativePDFPanes } from "./NativePDFPanes";
import type { TranslationSplit } from "./TranslationPanes";
import { useNativePDFReading } from "./useNativePDFReading";

export function NativePDFReadingView({
  document: doc,
  theme,
  annotations,
  blocks,
  translations,
  initialLocation,
  onReady,
  onRegenerate,
  events,
  onUseFlow,
  pageNavigation,
  split,
  layout = "side-by-side",
  syncEnabled = true,
}: {
  document: Document;
  theme: ReaderTheme;
  annotations: Annotation[];
  blocks: PDFBlock[];
  translations: TranslationBlock[];
  initialLocation?: DocumentLocation;
  onReady: (adapter: ReaderAdapter, toc: TOCItem[]) => void;
  onRegenerate?: (location: DocumentLocation) => void;
  events: ReaderEvents;
  onUseFlow: () => void;
  pageNavigation?: ReactNode;
  split: TranslationSplit;
  layout?: NativePDFReadingLayout;
  syncEnabled?: boolean;
}) {
  // Only completed text affects the derived PDF; queue updates should leave the viewport alone.
  const revision = useMemo(
    () =>
      JSON.stringify(
        translations
          .filter((block) => block.status === "complete")
          .sort((a, b) => a.blockId.localeCompare(b.blockId))
          .map((block) => [
            block.blockId,
            block.sourceHash,
            block.sentences,
            block.formulaMarkdown,
          ]),
      ),
    [translations],
  );
  // Both views read the same translated pages. Comparison opens the original in its own pane.
  const { job, busy, error, retry, cancel, cancelling } = useNativePDFReading(
    doc.id,
    revision,
    "translation-only",
  );
  const metadata =
    job?.status === "ready" &&
    job.metadata?.documentId === doc.id &&
    job.metadata.layout === "translation-only"
      ? job.metadata
      : undefined;
  const single = layout === "translation-only";
  const View = single ? InterleafView : NativePDFPanes;
  const label = single ? "原版式译文" : "原版式对照";
  const flowLabel = single ? "流式译文" : "流式对照";
  const identity = `${doc.id}:${metadata?.cacheKey ?? "loading"}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const initialized = useRef<string | undefined>(undefined);
  const liveAdapter = useRef<ReaderAdapter | undefined>(undefined);
  const location = useRef(initialLocation);
  const mounted = useRef(true);
  const [readyIdentity, setReadyIdentity] = useState<string>();
  const latest = useRef({ events, onReady, onRegenerate });
  latest.current = { events, onReady, onRegenerate };
  useLayoutEffect(() => {
    // Page events alone cannot capture a scroll within a page. The job hook
    // detaches in a passive effect, so the old viewport can still be measured here.
    if (!liveAdapter.current) return;
    const snapshot = liveAdapter.current.getLocation();
    liveAdapter.current = undefined;
    initialized.current = undefined;
    setReadyIdentity(undefined);
    location.current = snapshot;
    latest.current.onRegenerate?.(snapshot);
  }, [revision]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ready = async (adapter: ReaderAdapter, toc: TOCItem[]) => {
    const expected = identity;
    try {
      if (location.current) await adapter.goTo(location.current);
    } catch {
      if (mounted.current && currentIdentity.current === expected)
        toast.error("无法恢复此前阅读位置");
    }
    if (!mounted.current || currentIdentity.current !== expected) return;
    liveAdapter.current = adapter;
    initialized.current = expected;
    setReadyIdentity(expected);
    latest.current.onReady(adapter, toc);
  };
  return (
    <div className="native-pdf-reading" aria-label={label}>
      {metadata ? (
        <>
          {(metadata.originalParagraphs > 0 ||
            metadata.warnings.length > 0) && (
            <div className="native-pdf-notice" role="status">
              <span>
                {metadata.originalParagraphs > 0
                  ? `${metadata.originalParagraphs} 段保留原文${metadata.translatedParagraphs === 0 ? "，当前译文暂不能安全用于原版式排版" : `，可在${flowLabel}中查看译文`}`
                  : "部分内容有排版提示"}
              </span>
              <Button variant="ghost" size="sm" onClick={onUseFlow}>
                使用{flowLabel}
              </Button>
              {metadata.warnings.length > 0 && (
                <details>
                  <summary>排版提示</summary>
                  <ul>
                    {metadata.warnings.slice(0, 20).map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                    {metadata.warnings.length > 20 && (
                      <li>另有 {metadata.warnings.length - 20} 条排版提示</li>
                    )}
                  </ul>
                </details>
              )}
            </div>
          )}
          <View
            key={metadata.cacheKey}
            split={split}
            syncEnabled={syncEnabled}
            document={doc}
            theme={theme}
            annotations={annotations}
            blocks={blocks}
            nativeReading={{
              metadata,
              fileURL: api.nativePDFReadingFileURL(doc.id, metadata.cacheKey),
              translations,
              alongsideOriginal: !single,
            }}
            onReady={ready}
            events={{
              ...events,
              location: (next, percentage) => {
                if (initialized.current !== identity) return;
                location.current = next;
                latest.current.events.location(next, percentage);
              },
            }}
          />
          {readyIdentity === identity && pageNavigation && (
            <div className="pdf-reading-controls">
              <div className="pdf-page-navigation">{pageNavigation}</div>
            </div>
          )}
        </>
      ) : (
        <div className="native-pdf-state" role="status">
          {busy && (
            <CircleNotch
              size={22}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          <p>{error || (busy ? `正在生成${label}` : `${label}暂不可用`)}</p>
          {busy && (
            <p className="native-pdf-progress">
              {job?.total
                ? `${job.done} / ${job.total} 页`
                : "首次生成需要一点时间，完成后会保存在本机"}
            </p>
          )}
          <div className="native-pdf-state-actions">
            {!busy && (
              <Button variant="outline" size="sm" onClick={retry}>
                重试
              </Button>
            )}
            {busy && job?.id && (
              <Button
                variant="outline"
                size="sm"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? "正在取消…" : "取消生成"}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onUseFlow}>
              使用{flowLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
