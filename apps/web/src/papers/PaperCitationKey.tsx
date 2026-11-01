import { useState } from "react";
import type { Document, BibliographyExport } from "@interleaf/core";
import { api } from "@interleaf/api";
import { toast } from "sonner";
import { Button } from "@interleaf/ui/components/button";
import { Input } from "@interleaf/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@interleaf/ui/components/dialog";
import { refreshLibrary } from "../store";
import { copyCitationKeys } from "./CitationMenu";
import { withinCategory } from "./model";
export function affectedExports(
  documents: Document[],
  targets: BibliographyExport[],
) {
  return targets.filter((t) =>
    documents.some((d) =>
      d.folders.some((f) =>
        t.includeChildren
          ? withinCategory(f, t.folder)
          : f.toLowerCase() === t.folder.toLowerCase(),
      ),
    ),
  );
}
export function PaperCitationKey({ doc }: { doc: Document }) {
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(""),
    [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<BibliographyExport[]>([]);
  const [error, setError] = useState("");
  if (!doc.paperId) return null;
  const edit = async () => {
    setValue(doc.citationKey || "");
    setError("");
    setEditing(true);
    setBusy(true);
    try {
      setTargets(affectedExports([doc], await api.bibliographyExports()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.updatePaper(doc.paperId!, { citationKey: value.trim() });
      await refreshLibrary();
      setEditing(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="paper-citation-key space-y-2 py-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">引用键</h3>
        <span
          className="paper-citation-key-value"
          data-empty={!doc.citationKey || undefined}
          title={doc.citationKey}
        >
          {doc.citationKey || "未分配"}
        </span>
        <Button size="xs" variant="ghost" onClick={() => void edit()}>
          修改
        </Button>
      </div>
      <div className="flex gap-1">
        <Button
          size="xs"
          variant="outline"
          onClick={() => void copyCitationKeys([doc])}
        >
          复制引用键
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void copyCitationKeys([doc], true)}
        >
          复制 LaTeX 引用
        </Button>
      </div>
      <Dialog open={editing} onOpenChange={(v) => !busy && setEditing(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改引用键</DialogTitle>
            <DialogDescription>
              原键 {doc.citationKey || "尚未分配"} 将不再导出。已有 LaTeX
              引用需要手动修改；纸间不修改 .tex 文件。
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="新引用键"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            支持 ASCII 字母、数字、下划线、连字符、冒号和句点。
          </p>
          <p className="text-sm">
            受影响的自动导出：
            {targets.length ? targets.map((t) => t.path).join("、") : "无"}
          </p>
          {error && <p role="alert">无法读取导出影响：{error}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              取消
            </Button>
            <Button
              disabled={
                busy || !!error || !value.trim() || value === doc.citationKey
              }
              onClick={() => void save()}
            >
              确认引用影响并保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
