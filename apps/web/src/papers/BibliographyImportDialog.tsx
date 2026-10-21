import { useState } from "react";
import type { BibliographyPreview, BibliographyDecision } from "@reader/core";
import { api } from "@reader/api";
import { toast } from "sonner";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
import { Checkbox } from "@reader/ui/components/checkbox";
import { Textarea } from "@reader/ui/components/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@reader/ui/components/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@reader/ui/components/dialog";
import { refreshLibrary, useReaderStore } from "../store";
export function BibliographyImportDialog({ onClose }: { onClose: () => void }) {
  const papers = useReaderStore((s) => s.paperItems) || [];
  const [text, setText] = useState(""),
    [preview, setPreview] = useState<BibliographyPreview | null>(null);
  const [decisions, setDecisions] = useState<
    Record<number, BibliographyDecision>
  >({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmed, setConfirmed] = useState(false);
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
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>导入 .bib</DialogTitle>
          <DialogDescription>
            预览后逐条选择新建、合并或跳过。手动填写的信息保留；合并默认保留已有引用键。
          </DialogDescription>
        </DialogHeader>
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
            <section key={e.index} className="space-y-2 rounded border p-3">
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
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !ready} onClick={() => void run(true)}>
            确认导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
