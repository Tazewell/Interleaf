import type { Processing } from "@interleaf/core";
import { Button } from "@interleaf/ui/components/button";

export function TranslationJobStatus({
  processing,
  error,
  retry,
}: {
  processing?: Processing;
  error?: string;
  retry: () => void;
}) {
  const paused =
    processing?.enabled === false || processing?.status === "paused";
  const status = paused
    ? "paused"
    : (processing?.translating?.status ?? processing?.status);
  if (!error && status !== "failed" && status !== "waiting") return null;
  const detail =
    error ||
    processing?.translating?.detail ||
    processing?.detail ||
    "翻译已停止，请重试";
  const message = [...new Set(detail.split(/\r?\n/).filter(Boolean))].join(
    "；",
  );
  return (
    <div
      className="translation-warning"
      role={error || status === "failed" ? "alert" : "status"}
    >
      {message}
      {status === "failed" && (
        <Button size="sm" variant="ghost" onClick={retry}>
          重试翻译
        </Button>
      )}
    </div>
  );
}
