import { useEffect, useState } from "react";
import type {
  Document,
  PaperPatch,
  PaperMetadataField,
  BibliographyExport,
} from "@interleaf/core";
import { api } from "@interleaf/api";
import { Button } from "@interleaf/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@interleaf/ui/components/dialog";
import { RadioGroup, RadioGroupItem } from "@interleaf/ui/components/radio-group";
import { Checkbox } from "@interleaf/ui/components/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@interleaf/ui/components/select";
import { toast } from "sonner";
import { refreshLibrary, refreshTrash } from "../store";
import { paperByline } from "./format";
import { usePaperUI } from "./state";
import { affectedExports } from "./PaperCitationKey";

const filled = (doc: Document) =>
  Object.entries(doc.metadata).filter(
    ([key, value]) =>
      !["sources", "lookup", "lookedUpAt"].includes(key) &&
      (Array.isArray(value) ? value.length : value),
  ).length;

/** The version with the most reading work, then the fullest metadata. */
export function preferredVersion(group: Document[]) {
  const work = (d: Document) => d.noteCount + d.highlightCount;
  return [...group].sort(
    (a, b) =>
      work(b) - work(a) ||
      filled(b) - filled(a) ||
      a.createdAt.localeCompare(b.createdAt),
  )[0];
}

const sizeLabel = (bytes: number) =>
  bytes >= 1 << 20
    ? `${(bytes / (1 << 20)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const labels: Record<PaperMetadataField | "title" | "author", string> = {
  title: "标题",
  translatedTitle: "译名",
  author: "作者显示名",
  creators: "作者",
  date: "日期",
  venue: "出处",
  doi: "DOI",
  arxiv: "arXiv",
  url: "链接",
  itemType: "类型",
  volume: "卷",
  issue: "期",
  pages: "页码",
  publisher: "出版者",
  isbn: "ISBN",
  abstract: "摘要",
  affiliation: "单位",
  shortTitle: "短标题",
  remark: "备注",
  language: "语言",
};
const fieldValue = (d: Document, k: string): unknown =>
  k === "title"
    ? d.title
    : k === "author"
      ? d.author
      : d.metadata[k as PaperMetadataField];
const valueText = (v: unknown) =>
  typeof v === "string" ? v : JSON.stringify(v);
/** Select metadata and a retained citation key; every file remains intact. */
export function MergeDialog({
  group,
  onClose,
}: {
  group: Document[];
  onClose: () => void;
}) {
  const [master, setMaster] = useState(() => preferredVersion(group).id);
  const [saving, setSaving] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const keys = [
    ...new Set(group.map((d) => d.citationKey).filter((k): k is string => !!k)),
  ];
  const [citationKey, setKey] = useState(keys.length === 1 ? keys[0] : "");
  const [confirmed, setConfirmed] = useState(false);
  const [targets, setTargets] = useState<BibliographyExport[]>([]);
  const [impactError, setImpactError] = useState("");
  const [loadingImpact, setLoadingImpact] = useState(true);
  useEffect(() => {
    let alive = true;
    void api
      .bibliographyExports()
      .then((v) => alive && setTargets(affectedExports(group, v)))
      .catch((e) => alive && setImpactError(e.message))
      .finally(() => alive && setLoadingImpact(false));
    return () => {
      alive = false;
    };
  }, [group]);
  const conflicts = (Object.keys(labels) as (keyof typeof labels)[]).filter(
    (k) =>
      new Set(
        group
          .map((d) => valueText(fieldValue(d, k)))
          .filter((v) => v && v !== "[]"),
      ).size > 1,
  );
  const choice = (k: string) =>
    choices[k] ||
    (fieldValue(
      group.find((d) => d.id === master)!,
      k,
    )
      ? master
      : group.find((d) => fieldValue(d, k))!.id);
  const merge = async () => {
    setSaving(true);
    try {
      const target = group.find((d) => d.id === master)!;
      const others = group
        .filter((d) => d.id !== master)
        .map((d) => d.paperId || d.id);
      const patch: Pick<PaperPatch, "title" | "author" | "metadata"> = {};
      for (const field of conflicts) {
        const value = fieldValue(
          group.find((d) => d.id === choice(field))!,
          field,
        );
        if (field === "title" || field === "author")
          patch[field] = value as string;
        else patch.metadata = { ...patch.metadata, [field]: value };
      }
      await api.mergePapers(target.paperId || target.id, {
        ids: others,
        ...(citationKey ? { citationKey } : {}),
        confirmCitationChange: confirmed,
        patch,
      });
      toast.success(`已合并 ${group.length} 个版本`);
      usePaperUI.getState().select(master);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
      await Promise.all([refreshLibrary(), refreshTrash()]).catch(() => {});
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>合并 {group.length} 个版本</DialogTitle>
          <DialogDescription>
            保留全部附件及各自的阅读记录、批注、笔记和对话。选择目标条目，核对冲突字段；其余信息补缺，分类与星标合并。
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={master}
          onValueChange={(value) => {
            setMaster(value as string);
            setChoices({});
          }}
          aria-label="保留的版本"
          className="min-w-0 grid-cols-[minmax(0,1fr)] gap-1"
        >
          {group.map((doc) => (
            <label key={doc.id} className="paper-merge-option">
              <RadioGroupItem value={doc.id} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-sm font-medium"
                  title={doc.title}
                >
                  {doc.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {paperByline(doc) || "无论文信息"}
                </span>
                <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {[
                    sizeLabel(doc.size),
                    `添加于 ${new Date(doc.createdAt).toLocaleDateString("zh-CN")}`,
                    doc.noteCount && `${doc.noteCount} 条批注`,
                    doc.highlightCount && `${doc.highlightCount} 处划线`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
        {conflicts.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">冲突字段</h3>
            {conflicts.map((k) => (
              <div key={k}>
                <p className="text-xs text-muted-foreground">{labels[k]}</p>
                <Select
                  value={choice(k)}
                  onValueChange={(v) =>
                    v && setChoices((c) => ({ ...c, [k]: v }))
                  }
                >
                  <SelectTrigger
                    aria-label={`保留${labels[k]}`}
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {group
                      .filter((d) => fieldValue(d, k))
                      .map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {valueText(fieldValue(d, k))}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </section>
        )}
        {keys.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">保留的引用键</h3>
            <RadioGroup
              value={citationKey}
              onValueChange={(v) => {
                setKey(v as string);
                setConfirmed(false);
              }}
              aria-label="保留的引用键"
            >
              {keys.map((k) => (
                <label key={k} className="flex gap-2 text-sm">
                  <RadioGroupItem value={k} />
                  <code>{k}</code>
                </label>
              ))}
            </RadioGroup>
            <p className="text-xs">
              不再导出的旧键：
              {citationKey
                ? keys.filter((k) => k !== citationKey).join("、") || "无"
                : "请先选择保留的键"}
            </p>
          </section>
        )}
        <p className="text-xs">
          受影响的自动导出：
          {loadingImpact
            ? "读取中…"
            : targets.map((t) => t.path).join("、") || "无"}
        </p>
        {impactError && (
          <p role="alert" className="text-sm text-destructive">
            无法读取导出影响：{impactError}
          </p>
        )}
        {keys.length > 1 && (
          <label className="flex gap-2 text-sm">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(v === true)}
            />
            我确认旧键不再导出，需要手动更新 LaTeX 引用；纸间不修改 .tex 文件。
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              saving ||
              loadingImpact ||
              !!impactError ||
              (keys.length > 1 && (!citationKey || !confirmed))
            }
            onClick={() => void merge()}
          >
            合并
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
