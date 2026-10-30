import { useState } from "react";
import { Check } from "@phosphor-icons/react";
import { Button } from "@reader/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@reader/ui/components/popover";
import { highlightPalette } from "./annotations";
import { useReaderStore } from "./store";

/** One button per highlight color; `current` is marked as pressed. */
export function ColorSwatches({
  action,
  current,
  disabled,
  onPick,
}: {
  action: string;
  current?: string;
  disabled?: boolean;
  onPick: (color: string) => void;
}) {
  const palette = highlightPalette(useReaderStore((s) => s.theme));
  return (
    <span className="color-swatches" role="group" aria-label={action}>
      {palette.map((color) => {
        const on = current?.toLowerCase() === color.value;
        return (
          <Button
            key={color.value}
            size="icon-xs"
            variant="ghost"
            aria-label={`${color.label}${action}`}
            title={`${color.label}${action}`}
            aria-pressed={current ? on : undefined}
            disabled={disabled}
            onClick={() => onPick(color.value)}
          >
            <span className="color-swatch" style={{ background: color.value }}>
              {on && <Check />}
            </span>
          </Button>
        );
      })}
    </span>
  );
}

/** The active color as one dot; the palette opens on demand. */
export function ColorSwatchPicker({
  color,
  action = "高亮",
  disabled,
  onPick,
}: {
  color: string;
  action?: string;
  disabled?: boolean;
  onPick: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`选择${action}颜色`}
            title={`选择${action}颜色`}
            disabled={disabled}
          />
        }
      >
        <span
          className="color-swatch color-swatch-current"
          style={{ background: color }}
        />
      </PopoverTrigger>
      {/* Keep the page selection alive while the palette is open. */}
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-auto gap-0 p-2"
        initialFocus={(openType) => openType === "keyboard"}
        onMouseDown={(event) => event.preventDefault()}
      >
        <ColorSwatches
          action={action}
          current={color}
          onPick={(next) => {
            onPick(next);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
