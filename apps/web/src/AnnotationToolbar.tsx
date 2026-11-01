import type { RefObject } from "react";
import type { Annotation, SelectionAnchor } from "@interleaf/core";
import {
  Trash,
  Note as StickyNote,
  NotePencil as SquarePen,
  Sparkle as Sparkles,
} from "@phosphor-icons/react";
import { Button } from "@interleaf/ui/components/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@interleaf/ui/components/tooltip";
import { SelectionToolbar } from "./SelectionToolbar";
import { ColorSwatchPicker } from "./ColorSwatches";

export const annotationLabels = {
  highlight: "高亮",
  underline: "下划线",
  note: "批注",
  question: "问题",
  bookmark: "书签",
};

export function AnnotationToolbar({
  annotation,
  anchor,
  pane,
  deleting = false,
  onDelete,
  onNote,
  onAskAI,
  onAnswer,
  onColor,
}: {
  annotation: Annotation;
  anchor: SelectionAnchor;
  pane: RefObject<HTMLDivElement | null>;
  deleting?: boolean;
  onDelete: (id: string) => void;
  onNote: (annotation: Annotation) => void;
  onAskAI: (annotation: Annotation) => void;
  onAnswer?: (annotation: Annotation) => void;
  onColor?: (annotation: Annotation, color: string) => void;
}) {
  const hasNote = !!annotation.note.trim();
  const question = annotation.kind === "question";
  const note = {
    label: question ? "编辑问题" : hasNote ? "编辑批注" : "添加批注",
    Icon: hasNote ? SquarePen : StickyNote,
    onClick: () => onNote(annotation),
  };
  const ai =
    question && onAnswer && !annotation.answerId
      ? {
          label: "让 AI 回答",
          Icon: Sparkles,
          onClick: () => onAnswer(annotation),
        }
      : { label: "问 AI", Icon: Sparkles, onClick: () => onAskAI(annotation) };
  const action = ({
    label,
    Icon,
    onClick,
  }: {
    label: string;
    Icon: typeof Trash;
    onClick: () => void;
  }) => (
    <Tooltip key={label}>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={deleting}
            onClick={onClick}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
  return (
    <SelectionToolbar anchor={anchor} pane={pane} label="批注操作">
      {onColor && annotation.kind !== "bookmark" && (
        <ColorSwatchPicker
          color={annotation.color}
          action="标记"
          disabled={deleting}
          onPick={(color) => onColor(annotation, color)}
        />
      )}
      {action(note)}
      {action(ai)}
      <span className="selection-bar-divider" />
      {action({
        label: `删除${annotationLabels[annotation.kind]}`,
        Icon: Trash,
        onClick: () => onDelete(annotation.id),
      })}
    </SelectionToolbar>
  );
}
