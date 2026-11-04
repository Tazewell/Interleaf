import type { ReactNode } from "react";
import {
  Copy,
  ArrowsOut as Expand,
  Quotes as Quote,
} from "@phosphor-icons/react";
import { Button } from "@interleaf/ui/components/button";
import type { PDFBlock, PDFBlockAction } from "@interleaf/core";
export function BlockActions({
  block,
  onAction,
}: {
  block: PDFBlock;
  onAction: (block: PDFBlock, action: PDFBlockAction) => void;
}) {
  const action = (name: PDFBlockAction, label: string, icon: ReactNode) => (
    <Button
      data-block-action={name}
      size="icon-xs"
      variant="secondary"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onAction(block, name);
      }}
    >
      {icon}
    </Button>
  );
  return (
    <div className="block-actions">
      {block.image && action("preview", "放大查看原图", <Expand />)}
      {action("copy", block.image ? "复制图片" : "复制此段", <Copy />)}
      {action(
        "attach",
        block.image ? "引用图片到 AI 对话" : "引用此段到 AI 对话",
        <Quote />,
      )}
    </div>
  );
}
