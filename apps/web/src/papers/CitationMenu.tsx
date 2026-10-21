import { Copy, Download, Link } from "lucide-react";
import type { Document } from "@reader/core";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@reader/ui/components/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@reader/ui/components/dropdown-menu";
import { toast } from "sonner";
import { copyText } from "../chat/clipboard";
import {
  citationStyles,
  missingFields,
  formatCitations,
  titleAndLink,
  type CitationStyle,
} from "./citation";
import { usePaperUI } from "./state";
import { ensurePaperCitationKeys } from "../store";

const quick: CitationStyle[] = ["gb7714", "apa", "bibtex"];

export async function copyCitationKeys(docs: Document[], latex = false) {
  try {
    if (docs.some((d) => !d.citationKey && missingFields(d, "bibtex").length))
      toast.info("部分文献缺少作者或年份，将分配稳定备用键；可稍后补充信息。");
    const items = await ensurePaperCitationKeys(
      docs.map((d) => d.paperId || d.id),
    );
    const keys = docs
      .map((d) => items.find((p) => p.id === (d.paperId || d.id))?.citationKey)
      .filter(Boolean)
      .join(",");
    if (!keys) throw new Error("未能分配引用键");
    await copyText(
      latex ? `\\cite{${keys}}` : keys,
      latex ? "已复制 LaTeX 引用" : "已复制引用键",
    );
  } catch (e) {
    toast.error((e as Error).message);
  }
}

export async function copyCitations(docs: Document[], style: CitationStyle) {
  try {
    const text = await formatCitations(docs, style);
    await copyText(text, `已复制 ${citationStyles[style].label} 引用`);
  } catch (e) {
    toast.error(`无法生成引用：${(e as Error).message}`);
  }
}

export const exportCitations = (docs: Document[], title: string) =>
  usePaperUI.getState().setExporting({ ids: docs.map((d) => d.id), title });

/** Copy items for a paper menu; `kind` picks dropdown or context menu parts. */
export function CitationMenuItems({
  kind,
  docs,
  nested = false,
}: {
  kind: "dropdown" | "context";
  docs: Document[];
  nested?: boolean;
}) {
  const Item = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Separator =
    kind === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
  const items = (
    <>
      <Item onClick={() => void copyCitationKeys(docs)}>复制引用键</Item>
      <Item onClick={() => void copyCitationKeys(docs, true)}>
        复制 LaTeX 引用
      </Item>
      {quick.map((style) => (
        <Item key={style} onClick={() => void copyCitations(docs, style)}>
          <Copy />
          复制 {citationStyles[style].label}
        </Item>
      ))}
      {docs.length === 1 && (
        <Item
          onClick={() =>
            void copyText(titleAndLink(docs[0]), "已复制标题和链接")
          }
        >
          <Link />
          复制标题和链接
        </Item>
      )}
      <Separator />
      <Item
        onClick={() =>
          exportCitations(
            docs,
            docs.length === 1 ? docs[0].title : `${docs.length} 篇论文`,
          )
        }
      >
        <Download />
        导出引用…
      </Item>
    </>
  );
  if (!nested) return items;
  if (kind === "dropdown")
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>引用</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          {items}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>引用</ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-48">{items}</ContextMenuSubContent>
    </ContextMenuSub>
  );
}
