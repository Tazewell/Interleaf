import { Button } from "@interleaf/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@interleaf/ui/components/dialog";
import { libraryModes } from "./LibraryModeSwitcher";
import type { ImportEntry } from "./library-import";

export function ImportResultsDialog({
  open,
  entries,
  busy,
  refreshError,
  onClose,
  onRetry,
  onRead,
}: {
  open: boolean;
  entries: ImportEntry[];
  busy: boolean;
  refreshError: boolean;
  onClose: () => void;
  onRetry: () => void;
  onRead: (entry: ImportEntry) => void;
}) {
  const success = entries.filter(
    ({ result }) => result.status === "imported",
  ).length;
  const failed = entries.filter(
    ({ result }) => result.status === "failed",
  ).length;
  const existing = entries.filter(
    ({ result }) =>
      result.status === "existing" || result.status === "elsewhere",
  ).length;
  const retryable = entries.some(
    ({ result, file }) =>
      result.status === "failed" && (file || result.retryId),
  );
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导入结果</DialogTitle>
          <DialogDescription role="status">
            {busy
              ? "正在处理文件…"
              : `已导入 ${success} 项，${existing ? `已存在 ${existing} 项，` : ""}失败 ${failed} 项。`}
          </DialogDescription>
        </DialogHeader>
        {refreshError && (
          <p className="text-sm text-muted-foreground" role="status">
            文件已保存，暂时无法刷新书库。
          </p>
        )}
        <ul className="max-h-72 divide-y overflow-auto">
          {entries.map((entry, index) => {
            const { result, target } = entry;
            const library =
              libraryModes[result.library ?? target.library].label;
            const status =
              result.status === "imported"
                ? `已导入${library}`
                : result.status === "elsewhere" || result.status === "existing"
                  ? `已在${library}`
                  : result.status === "failed"
                    ? "导入失败"
                    : "已跳过";
            return (
              <li key={index} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm" title={result.name}>
                    {result.name}
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    {status}
                    {result.message ? ` · ${result.message}` : ""}
                  </p>
                </div>
                {result.documentId && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onRead(entry)}
                    aria-label={`阅读原文 ${result.name}`}
                  >
                    阅读原文
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          {retryable && (
            <Button variant="outline" disabled={busy} onClick={onRetry}>
              重试失败项
            </Button>
          )}
          <Button disabled={busy} onClick={onClose}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
