import { useEffect, useState } from "react";
import type {
  BibliographyPreview,
  BibliographyDecision,
} from "@interleaf/core";
import { api } from "@interleaf/api";
import { toast } from "sonner";
import { Button } from "@interleaf/ui/components/button";
import { Input } from "@interleaf/ui/components/input";
import { Checkbox } from "@interleaf/ui/components/checkbox";
import { Textarea } from "@interleaf/ui/components/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@interleaf/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@interleaf/ui/components/dialog";
import { refreshLibrary, useReaderStore } from "../store";
export function BibliographyImportDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="paper-import-dialog bibliography-import-dialog sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>导入 .bib</DialogTitle>
          <DialogDescription>
            预览后逐条选择新建、合并或跳过。手动填写的信息保留；合并默认保留已有引用键。
          </DialogDescription>
        </DialogHeader>
        <BibliographyImportForm onClose={onClose} onBusyChange={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

export function BibliographyImportForm({
  onClose,
  onBusyChange,
}: {
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const papers = useReaderStore((s) => s.paperItems) || [];
  const [text, setText] = useState(""),
    [preview, setPreview] = useState<BibliographyPreview | null>(null);
  const [decisions, setDecisions] = useState<
    Record<number, BibliographyDecision>
  >({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const changeText = (value: string) => {
    setText(value);
    setPreview(null);
    setDecisions({});
    setConfirmed(false);
    setError("");
  };
  const choose = (index: number, patch: Partial<BibliographyDecision>) => {
    setDecisions((d) => ({
      ...d,
      [index]: { ...d[index], index, ...patch } as BibliographyDecision,
    }));
    setConfirmed(false);
  };
  const keyChanges = Object.values(decisions).filter(
    (d) =>
      d.action === "merge" &&
      d.citationKey &&
      d.citationKey !== papers.find((p) => p.id === d.paperId)?.citationKey,
  );
  const ready =
    !!preview?.entries.length &&
    !preview.errors?.length &&
    preview.entries.every((e) => {
      const d = decisions[e.index];
      return d && (d.action !== "merge" || !!d.paperId);
    }) &&
    (!keyChanges.length || confirmed);
  const run = async (write = false) => {
    if (busy || (write ? !ready : !text.trim())) return;
    setBusy(true);
    setError("");
    try {
      if (write) {
        await api.importBibliography(
          text,
          preview!.entries.map((e) => decisions[e.index]),
          confirmed,
        );
        await refreshLibrary();
        toast.success("已导入文献");
        onClose();
      } else {
        setPreview(await api.previewBibliography(text));
        setDecisions({});
        setConfirmed(false);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bibliography-import-form">
      <p className="paper-import-help">
        导入文献信息与引用键。先预览条目，再选择新建、合并或跳过。
      </p>
      <Input
        type="file"
        accept=".bib,text/plain"
        aria-label="选择 BibTeX 文件"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f)
            void f
              .text()
              .then(changeText)
              .catch((e) => setError((e as Error).message));
        }}
      />
      <Textarea
        aria-label="BibTeX 内容"
        value={text}
        disabled={busy}
        onChange={(e) => changeText(e.target.value)}
        className="min-h-24 font-mono text-xs"
      />
      <Button
        variant="outline"
        disabled={busy || !text.trim()}
        onClick={() => void run()}
      >
        预览导入
      </Button>
      {preview?.errors?.map((e, i) => (
        <p key={i} role="alert" className="text-sm text-destructive">
          {e}
        </p>
      ))}
      {preview?.entries.map((e) => {
        const d = decisions[e.index];
        const matched = papers.find((p) => p.id === e.matchedId);
        return (
          <section
            key={e.index}
            className="bibliography-import-entry space-y-2 rounded border p-3"
          >
            <p className="truncate font-medium">{e.title || "无标题"}</p>
            <p className="text-xs">
              导入键：{e.key}{" "}
              {e.matchedId &&
                `· 匹配：${matched?.title || e.matchedId} · 已有键：${matched?.citationKey || "未分配"}`}
            </p>
            {e.warnings.map((w, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                {w}
              </p>
            ))}
            <div className="flex gap-2">
              {(["create", "merge", "skip"] as const).map((action, i) => (
                <Button
                  key={action}
                  size="sm"
                  variant={d?.action === action ? "secondary" : "outline"}
                  aria-pressed={d?.action === action}
                  disabled={busy}
                  onClick={() => {
                    setDecisions((prev) => ({
                      ...prev,
                      [e.index]: {
                        index: e.index,
                        action,
                        ...(action === "merge" && e.matchedId
                          ? { paperId: e.matchedId }
                          : {}),
                      },
                    }));
                    setConfirmed(false);
                  }}
                >
                  {["新建", "合并", "跳过"][i]}
                </Button>
              ))}
            </div>
            {d?.action === "merge" && (
              <Select
                value={d.paperId || ""}
                disabled={busy}
                onValueChange={(v) =>
                  choose(e.index, { paperId: v || undefined })
                }
              >
                <SelectTrigger aria-label={`合并目标 ${e.key}`}>
                  <SelectValue placeholder="选择已有文献" />
                </SelectTrigger>
                <SelectContent>
                  {papers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title} · {p.citationKey || "未分配"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {d && d.action !== "skip" && (
              <Input
                aria-label={`替换引用键 ${e.key}`}
                placeholder={
                  d.action === "merge"
                    ? "留空保留已有键；填写以显式修改"
                    : "留空使用导入键；冲突时填写新键"
                }
                value={d.citationKey || ""}
                disabled={busy}
                onChange={(ev) =>
                  choose(e.index, {
                    citationKey: ev.target.value || undefined,
                  })
                }
              />
            )}
          </section>
        );
      })}
      {keyChanges.length > 0 && (
        <label className="flex gap-2 text-sm">
          <Checkbox
            checked={confirmed}
            disabled={busy}
            onCheckedChange={(v) => setConfirmed(v === true)}
          />
          我确认替换已有引用键，会影响 LaTeX
          引用及关联的自动导出；原键将不再导出。
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter className="paper-import-footer">
        <Button variant="outline" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button
          className="paper-import-primary"
          disabled={busy || !ready}
          onClick={() => void run(true)}
        >
          确认导入
        </Button>
      </DialogFooter>
    </div>
  );
}
