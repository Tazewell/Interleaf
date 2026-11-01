import { useEffect, useState } from "react";
import type {
  Document,
  BibliographyMode,
  BibliographyExport,
} from "@interleaf/core";
import { api } from "@interleaf/api";
import { Button } from "@interleaf/ui/components/button";
import { Checkbox } from "@interleaf/ui/components/checkbox";
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
} from "@interleaf/ui/components/dialog";
import { downloadText } from "../download";
import { ensurePaperCitationKeys, useReaderStore } from "../store";
import { savePaperPreferences } from "./actions";
import { withinCategory } from "./model";
export function BibliographyExportDialog({
  folder,
  documents,
  onClose,
}: {
  folder: string;
  documents: Document[];
  onClose: () => void;
}) {
  const prefs = useReaderStore((s) => s.libraryPreferences.papers);
  const [mode, setMode] = useState<BibliographyMode>(
    prefs?.bibliographyModes?.[folder] || "bibtex",
  );
  const [includeChildren, setChildren] = useState(true),
    [targets, setTargets] = useState<BibliographyExport[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => setTargets(await api.bibliographyExports());
  useEffect(() => {
    let alive = true;
    void api
      .bibliographyExports()
      .then((v) => alive && setTargets(v))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const selected = documents.filter(
    (d) =>
      !folder ||
      d.folders.some((f) =>
        includeChildren
          ? withinCategory(f, folder)
          : f.toLowerCase() === folder.toLowerCase(),
      ),
  );
  const native = window.interleafDesktop?.configureBibliographyExport;
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>参考文献 · {folder || "全部文献"}</DialogTitle>
          <DialogDescription>
            导出 {selected.length} 篇文献，包含无附件条目。上传生成的 .bib 到
            Overleaf 后使用相同的引用键。
          </DialogDescription>
        </DialogHeader>
        <Select
          value={mode}
          onValueChange={(v) => {
            if (v) {
              setMode(v as BibliographyMode);
              void savePaperPreferences((p) => ({
                ...p,
                bibliographyModes: {
                  ...p.bibliographyModes,
                  [folder]: v as BibliographyMode,
                },
              }));
            }
          }}
        >
          <SelectTrigger aria-label="参考文献模式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bibtex">BibTeX</SelectItem>
            <SelectItem value="biblatex">BibLaTeX</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex gap-2 text-sm">
          <Checkbox
            checked={includeChildren}
            onCheckedChange={(v) => setChildren(v === true)}
          />
          包含子文件夹
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const ids = selected.map((d) => d.paperId || d.id);
                if (ids.length) await ensurePaperCitationKeys(ids);
                const result = await api.exportBibliography(ids, mode);
                downloadText(
                  result.text,
                  `${(folder || "references").replace(/[<>:"/\\|?*]/g, "_")}.bib`,
                  "application/x-bibtex",
                );
              })
            }
          >
            保存 .bib
          </Button>
          {native && folder && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const target = await native({
                    folder,
                    includeChildren,
                    mode,
                  });
                  if (target) await load();
                })
              }
            >
              设置自动导出位置
            </Button>
          )}
        </div>
        {!native && (
          <p className="text-xs text-muted-foreground">
            浏览器版通过下载保存文件；本地自动导出在桌面版设置。
          </p>
        )}
        {targets
          .filter((t) => !folder || t.folder === folder || t.paused)
          .map((t) => (
            <section key={t.id} className="space-y-1 rounded border p-3">
              <p className="break-all text-sm">{t.path}</p>
              <p className="text-xs text-muted-foreground">
                {t.folder} · {t.mode} ·{" "}
                {t.includeChildren ? "包含子文件夹" : "仅此文件夹"} ·{" "}
                {t.paused
                  ? "已暂停（文件夹已删除）"
                  : t.lastExportedAt
                    ? `上次成功：${new Date(t.lastExportedAt).toLocaleString()}`
                    : "等待导出"}
              </p>
              {t.error && (
                <p role="alert" className="text-sm text-destructive">
                  {t.error}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || t.paused}
                  onClick={() =>
                    void run(async () => {
                      await api.refreshBibliographyExport(t.id);
                      await load();
                    })
                  }
                >
                  立即更新
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.removeBibliographyExport(t.id);
                      await load();
                    })
                  }
                >
                  停止管理（保留文件）
                </Button>
              </div>
            </section>
          ))}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
