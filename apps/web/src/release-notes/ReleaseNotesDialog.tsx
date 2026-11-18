import { useRef, useState } from "react";
import { toast } from "sonner";
import { CaretRight, ChatText, Star } from "@phosphor-icons/react";
import { Button } from "@interleaf/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@interleaf/ui/components/dialog";
import type { ReleaseItem } from "./releases";
import "./release-notes.css";

export function ReleaseNotesDialog({
  open,
  version,
  items,
  earlierItems,
  onClose,
}: {
  open: boolean;
  version: string;
  items: ReleaseItem[];
  earlierItems: ReleaseItem[];
  onClose: () => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const [opening, setOpening] = useState(false);
  const visitGitHub = async (issues: boolean) => {
    const url = `https://github.com/Tazewell/Interleaf${issues ? "/issues/new/choose" : ""}`;
    setOpening(true);
    try {
      if (window.interleafDesktop?.openExternal) {
        await window.interleafDesktop.openExternal(url);
      } else {
        const opened = window.open(url, "_blank");
        if (!opened) throw new Error("无法打开浏览器，请允许弹出窗口后重试。");
        opened.opener = null;
      }
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "无法打开链接，请重试。",
      );
    } finally {
      setOpening(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="release-notes-dialog"
        initialFocus={title}
      >
        <DialogHeader className="release-notes-header">
          <DialogTitle
            ref={title}
            tabIndex={-1}
            className="text-lg leading-snug font-semibold outline-none"
          >
            纸间 Interleaf {version} 更新内容
          </DialogTitle>
        </DialogHeader>
        <div
          className="release-notes-scroll outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45"
          role="region"
          aria-label="更新条目"
          tabIndex={0}
        >
          {items.length > 0 ? (
            <ReleaseNoteList items={items} />
          ) : (
            <p className="py-4 text-muted-foreground">已更新到此版本。</p>
          )}
          {earlierItems.length > 0 && (
            <details className="release-notes-history group">
              <summary className="flex cursor-pointer items-center gap-2 py-3 text-muted-foreground hover:text-foreground focus-visible:outline-ring">
                <CaretRight
                  aria-hidden
                  className="size-3.5 group-open:rotate-90"
                />
                较早的更新
              </summary>
              <ReleaseNoteList items={earlierItems} />
            </details>
          )}
        </div>
        <DialogFooter className="release-notes-footer">
          <div className="flex flex-wrap gap-1">
            <Button
              variant="ghost"
              disabled={opening}
              className="text-muted-foreground"
              aria-label="去 GitHub 点 Star"
              onClick={() => void visitGitHub(false)}
            >
              <Star />点 Star
            </Button>
            <Button
              variant="ghost"
              disabled={opening}
              className="text-muted-foreground"
              aria-label="在 GitHub 提交问题反馈"
              onClick={() => void visitGitHub(true)}
            >
              <ChatText />
              问题反馈
            </Button>
          </div>
          <Button
            className="release-notes-close"
            aria-label="关闭更新说明"
            onClick={onClose}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseNoteList({ items }: { items: ReleaseItem[] }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => (
        <li key={item.title} className="space-y-0.5 py-2.5">
          <p className="font-medium">{item.title}</p>
          {item.body && (
            <p className="leading-relaxed text-muted-foreground">{item.body}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
