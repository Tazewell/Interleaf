import { useCallback, useEffect, useRef, useState } from "react";
import type { ReaderSelection } from "@interleaf/core";
import { api } from "@interleaf/api";
import {
  CircleNotch,
  Translate,
  X,
  ArrowClockwise,
} from "@phosphor-icons/react";
import { Button } from "@interleaf/ui/components/button";
import { Popover, PopoverContent } from "@interleaf/ui/components/popover";

/** Viewport movement does not change the text or context sent to the model. */
export function selectionTranslationKey(selection: ReaderSelection) {
  return JSON.stringify([
    selection.text,
    selection.context?.before ?? "",
    selection.context?.after ?? "",
    selection.location,
  ]);
}

export function SelectionTranslation({
  selection,
  onClose,
  inline = false,
  delayMs = 0,
}: {
  selection: ReaderSelection | null;
  onClose: () => void;
  /** The caller positions the card under the selection toolbar. */
  inline?: boolean;
  /** Automatic translation waits for a settled selection; manual requests use 0. */
  delayMs?: number;
}) {
  const [result, setResult] = useState<{
    key: string;
    text?: string;
    error?: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const source = useRef(selection);
  source.current = selection;
  const key = selection ? selectionTranslationKey(selection) : "";
  const anchor = selection?.anchor;
  const visible = !!selection && (inline || !!anchor);
  const text = selection?.text.trim() ?? "";
  const validationError = !text
    ? "请选择文字后再翻译。"
    : [...text].length > 12000
      ? "划词翻译每次最多支持 12000 个字符，请缩小选区。"
      : undefined;
  const close = useCallback(() => {
    controller.current?.abort();
    onClose();
  }, [onClose]);
  useEffect(() => {
    if (!visible || validationError || !source.current) return;
    const current = new AbortController();
    controller.current = current;
    const selected = source.current;
    setResult({ key });
    const run = async () => {
      if (current.signal.aborted) return;
      try {
        const { text } = await api.translateSelection(selected, current.signal);
        if (!current.signal.aborted) setResult({ key, text });
      } catch (error) {
        if (!current.signal.aborted)
          setResult({
            key,
            error: error instanceof Error ? error.message : "翻译失败，请重试",
          });
      }
    };
    const timer =
      delayMs > 0 ? setTimeout(() => void run(), delayMs) : undefined;
    if (delayMs <= 0) void run();
    return () => {
      clearTimeout(timer);
      current.abort();
      if (controller.current === current) controller.current = undefined;
    };
    // Semantic key intentionally excludes the transient viewport anchor.
  }, [key, visible, validationError, delayMs, attempt]);
  useEffect(() => {
    if (!visible || inline) return;
    const interrupt = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-selection-translation]")
      )
        return;
      close();
    };
    window.addEventListener("scroll", interrupt, true);
    window.addEventListener("resize", interrupt);
    return () => {
      window.removeEventListener("scroll", interrupt, true);
      window.removeEventListener("resize", interrupt);
    };
  }, [visible, inline, close]);
  if (!visible) return null;
  const current = result?.key === key ? result : undefined;
  const error = validationError || current?.error;
  const loading = !error && !current?.text;
  const card = (
    <section
      className="selection-translation-card"
      data-selection-translation=""
      data-inline={inline || undefined}
      role="region"
      aria-label="划词翻译"
      aria-busy={loading}
    >
      <div className="selection-translation-header">
        <span className="selection-translation-title">
          <Translate size={16} aria-hidden="true" />
          划词翻译
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="selection-translation-close"
          title="关闭划词翻译"
          aria-label="关闭划词翻译"
          onClick={close}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </div>
      <div
        className="selection-translation-body"
        role={error ? "alert" : loading ? "status" : undefined}
        aria-live="polite"
      >
        {loading ? (
          <span className="selection-translation-loading">
            <CircleNotch
              size={16}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            正在翻译…
          </span>
        ) : (
          error || current?.text
        )}
      </div>
      {current?.error && !validationError && (
        <div className="selection-translation-actions">
          <Button
            variant="outline"
            size="sm"
            aria-label="重试翻译"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <ArrowClockwise size={14} aria-hidden="true" />
            重试
          </Button>
        </div>
      )}
    </section>
  );
  if (inline) return card;
  return (
    <Popover
      open={!!anchor}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {anchor && (
        <PopoverContent
          anchor={{
            getBoundingClientRect: () =>
              new DOMRect(
                anchor.x,
                anchor.top,
                1,
                Math.max(1, anchor.bottom - anchor.top),
              ),
          }}
          side="right"
          align="start"
          sideOffset={12}
          finalFocus={false}
          aria-label="翻译"
          className="selection-translation-popover p-0 gap-0"
        >
          {card}
        </PopoverContent>
      )}
    </Popover>
  );
}
