import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { SelectionAnchor } from "@interleaf/core";

export function toolbarPosition(
  anchor: SelectionAnchor,
  pane: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
) {
  const gap = 10;
  const left = Math.max(
    pane.left + 8,
    Math.min(anchor.x - size.width / 2, pane.right - size.width - 8),
  );
  const below = anchor.bottom + gap;
  const top = Math.max(
    pane.top + 8,
    Math.min(
      below + size.height <= pane.bottom - 8
        ? below
        : anchor.top - gap - size.height,
      pane.bottom - size.height - 8,
    ),
  );
  return { left: left - pane.left, top: top - pane.top };
}
export function SelectionToolbar({
  anchor,
  pane,
  children,
  label = "选中文字操作",
  content,
  onClose,
}: {
  anchor: SelectionAnchor;
  pane: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  label?: string;
  content?: ReactNode;
  onClose?: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
  }>();
  useLayoutEffect(() => {
    if (!bar.current || !pane.current) return;
    const update = () => {
      if (bar.current && pane.current) {
        const bounds = pane.current.getBoundingClientRect();
        setPosition({
          ...toolbarPosition(
            anchor,
            bounds,
            bar.current.getBoundingClientRect(),
          ),
          maxHeight: Math.max(0, bounds.height - 16),
          maxWidth: Math.max(0, bounds.width - 16),
        });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(pane.current);
    observer.observe(bar.current);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchor, pane]);
  useEffect(() => {
    if (!onClose) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Element &&
      (!!bar.current?.contains(target) ||
        !!target.closest(
          '[data-selection-preserve], [data-slot="popover-content"], [data-slot="dropdown-menu-content"]',
        ));
    const outside = (event: Event) => {
      if (!inside(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    document.addEventListener("focusin", outside);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  return (
    <div
      ref={bar}
      className="selection-surface"
      data-selection-surface=""
      data-expanded={!!content || undefined}
      style={{ ...position, visibility: position ? "visible" : "hidden" }}
    >
      <div
        className="selection-bar"
        role="toolbar"
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
      >
        {children}
      </div>
      {content}
    </div>
  );
}
