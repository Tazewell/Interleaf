import { useState } from "react";
import { toast } from "sonner";
import { Star, ChatText as MessageSquare } from "@phosphor-icons/react";
import { Button } from "@interleaf/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  onClose,
}: {
  open: boolean;
  version: string;
  items: ReleaseItem[];
  onClose: () => void;
}) {
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
        className="release-notes-dialog sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>纸间 Interleaf {version} 更新内容</DialogTitle>
          <DialogDescription>
            {items.length ? "本次更新的主要变化" : "已更新到新版本。"}
          </DialogDescription>
        </DialogHeader>
        {items.length > 0 && (
          <ul className="space-y-4">
            {items.map((item) => (
              <li key={item.title} className="space-y-1">
                <p className="font-medium">{item.title}</p>
                {item.body && (
                  <p className="leading-6 text-muted-foreground">{item.body}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm leading-6 text-muted-foreground">
          如果纸间对你有帮助，欢迎在 GitHub 点个
          Star。遇到问题或有建议，也欢迎提交 Issue。
        </p>
        <DialogFooter className="flex-col sm:flex-col">
          <Button variant="outline" aria-label="关闭更新说明" onClick={onClose}>
            关闭
          </Button>
          <Button
            autoFocus
            disabled={opening}
            onClick={() => void visitGitHub(false)}
          >
            <Star />去 GitHub 点 Star
          </Button>
          <Button
            variant="outline"
            disabled={opening}
            onClick={() => void visitGitHub(true)}
          >
            <MessageSquare />
            已点 Star，去提 Issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
