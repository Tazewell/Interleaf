import { useRef, useState } from "react";
import { BookOpen, GearSix, MagnifyingGlass } from "@phosphor-icons/react";
import type { Document, LibraryMode, Processing } from "@interleaf/core";
import { Button } from "@interleaf/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@interleaf/ui/components/dialog";
import { Input } from "@interleaf/ui/components/input";
import { filterDocuments, initialFilters } from "./library";
import { libraryModes } from "./LibraryModeSwitcher";
import { filterPapers } from "./papers/model";

export function LibrarySearchDialog({
  open,
  onOpenChange,
  books,
  papers,
  mode,
  jobs,
  onSelect,
  onSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  books: Document[];
  papers: Document[];
  mode: LibraryMode;
  jobs: Map<string, Processing>;
  onSelect: (document: Document) => void;
  onSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | LibraryMode>("all");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const matches = {
    papers:
      open && scope !== "books"
        ? filterPapers(papers, "all", query, "opened", jobs)
        : [],
    books:
      open && scope !== "papers"
        ? filterDocuments(books, "all", query, initialFilters)
        : [],
  };
  const results = [
    ...matches[mode],
    ...matches[mode === "papers" ? "books" : "papers"],
  ];
  const select = (document: Document) => {
    onOpenChange(false);
    onSelect(document);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={input}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (
            event.key === "Enter" &&
            event.target === input.current &&
            results.length
          ) {
            event.preventDefault();
            select(results[0]);
          }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const options = Array.from(
            list.current?.querySelectorAll<HTMLButtonElement>("button") || [],
          );
          const index = options.findIndex((option) => option === event.target);
          if (event.target !== input.current && index < 0) return;
          const next = index + (event.key === "ArrowDown" ? 1 : -1);
          const target = next < 0 ? input.current : options[next];
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MagnifyingGlass className="size-5" />
            快速查找
          </DialogTitle>
          <DialogDescription>搜索论文库与图书库。</DialogDescription>
        </DialogHeader>
        <Input
          ref={input}
          aria-label="查找标题、作者或 DOI"
          placeholder="标题、作者或 DOI…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex gap-1" role="group" aria-label="搜索范围">
          {(["all", "papers", "books"] as const).map((item) => (
            <Button
              key={item}
              size="sm"
              variant={scope === item ? "secondary" : "ghost"}
              aria-pressed={scope === item}
              onClick={() => setScope(item)}
            >
              {item === "all" ? "全部" : libraryModes[item].label}
            </Button>
          ))}
        </div>
        <div ref={list} className="max-h-72 min-w-0 space-y-1 overflow-auto">
          {results.map((document) => (
            <Button
              key={document.id}
              variant="ghost"
              className="h-auto w-full min-w-0 justify-start py-2 text-left"
              onClick={() => select(document)}
            >
              <BookOpen />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{document.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {libraryModes[document.library].label} ·{" "}
                  {document.metadataOnly
                    ? "仅元数据"
                    : document.type.toUpperCase()}
                  {document.author ? ` · ${document.author}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {document.metadataOnly
                  ? "查看详情"
                  : document.percentage > 0
                    ? "继续阅读"
                    : "阅读"}
              </span>
            </Button>
          ))}
          {!results.length && (
            <p
              className="px-2 py-3 text-sm text-muted-foreground"
              role="status"
            >
              {query.trim() ? "没有找到匹配的文档" : "此范围内暂无文档"}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          className="w-fit justify-start"
          onClick={() => {
            onOpenChange(false);
            onSettings();
          }}
        >
          <GearSix />
          打开设置
        </Button>
      </DialogContent>
    </Dialog>
  );
}
