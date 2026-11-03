import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import { TabsList } from "@interleaf/ui/components/tabs";
import { cn } from "@interleaf/ui/lib/utils";

type Drag = {
  id: number;
  x: number;
  y: number;
  active: HTMLElement;
  bounds: DOMRect;
  moved: boolean;
  cancelled?: boolean;
};

/** Base UI owns selection and keyboard navigation; dragging only previews its indicator. */
export function SlidingTabsList({
  ref,
  className,
  onPointerDownCapture,
  onClickCapture,
  ...props
}: ComponentProps<typeof TabsList>) {
  const element = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const blockClick = useRef(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      element.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref],
  );

  useEffect(() => {
    const list = element.current;
    if (!list) return;
    const tabs = () =>
      [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter(
        (tab) => tab.closest('[role="tablist"]') === list,
      );
    const clear = () => {
      drag.current = null;
      delete list.dataset.dragging;
      list.style.removeProperty("--tabs-drag-offset");
    };
    const suppressClick = () => {
      blockClick.current = true;
      clearTimeout(clickTimer.current);
      clickTimer.current = setTimeout(() => {
        blockClick.current = false;
      }, 0);
    };
    const valid = (state: Drag) => {
      const bounds = list.getBoundingClientRect();
      return (
        state.active.isConnected &&
        state.active.getAttribute("aria-selected") === "true" &&
        bounds.left === state.bounds.left &&
        bounds.top === state.bounds.top &&
        bounds.width === state.bounds.width &&
        bounds.height === state.bounds.height
      );
    };
    const move = (event: PointerEvent) => {
      const state = drag.current;
      if (!state || state.cancelled || event.pointerId !== state.id) return;
      if (
        !valid(state) ||
        Math.abs(event.clientY - state.y) >
          Math.abs(event.clientX - state.x) + 6
      ) {
        state.cancelled = true;
        delete list.dataset.dragging;
        list.style.removeProperty("--tabs-drag-offset");
        return;
      }
      const delta = event.clientX - state.x;
      if (!state.moved && Math.abs(delta) < 5) return;
      state.moved = true;
      list.dataset.dragging = "true";
      const bounds = state.active.getBoundingClientRect();
      const offset = Math.max(
        state.bounds.left - bounds.left,
        Math.min(delta, state.bounds.right - bounds.right),
      );
      list.style.setProperty("--tabs-drag-offset", `${offset}px`);
      if (event.cancelable) event.preventDefault();
    };
    const end = (event: PointerEvent) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.id) return;
      const commit =
        !state.cancelled &&
        state.moved &&
        event.type === "pointerup" &&
        valid(state) &&
        event.clientX >= state.bounds.left &&
        event.clientX <= state.bounds.right &&
        event.clientY >= state.bounds.top &&
        event.clientY <= state.bounds.bottom;
      if (state.cancelled || state.moved || !valid(state)) suppressClick();
      clear();
      if (!commit) return;
      const target = tabs().reduce<HTMLElement | undefined>((best, tab) => {
        const distance = (item: HTMLElement) => {
          const rect = item.getBoundingClientRect();
          return Math.abs(event.clientX - (rect.left + rect.right) / 2);
        };
        return !best || distance(tab) < distance(best) ? tab : best;
      }, undefined);
      if (
        target &&
        !target.hasAttribute("disabled") &&
        target.getAttribute("aria-disabled") !== "true"
      ) {
        // The release-generated click is blocked; this explicit click uses the normal Base UI path.
        blockClick.current = false;
        target.click();
        target.focus({ preventScroll: true });
        suppressClick();
      }
    };
    const cancel = () => {
      if (!drag.current) return;
      drag.current.cancelled = true;
      delete list.dataset.dragging;
      list.style.removeProperty("--tabs-drag-offset");
    };
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(cancel)
        : undefined;
    observer?.observe(list);
    const mutation = new MutationObserver(() => {
      if (drag.current && !valid(drag.current)) cancel();
    });
    mutation.observe(list, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected", "disabled", "aria-disabled"],
    });
    const doc = list.ownerDocument;
    doc.addEventListener("pointermove", move, { passive: false });
    doc.addEventListener("pointerup", end);
    doc.addEventListener("pointercancel", end);
    list.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    return () => {
      clear();
      clearTimeout(clickTimer.current);
      observer?.disconnect();
      mutation.disconnect();
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", end);
      doc.removeEventListener("pointercancel", end);
      list.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
    };
  }, []);

  return (
    <TabsList
      {...props}
      ref={setRef}
      className={cn("sliding-tabs-list", className)}
      onPointerDownCapture={(event) => {
        onPointerDownCapture?.(event);
        const list = element.current;
        if (
          !list ||
          event.defaultPrevented ||
          !event.isPrimary ||
          event.button !== 0 ||
          list.getAttribute("aria-orientation") === "vertical"
        )
          return;
        const target = (event.target as HTMLElement).closest<HTMLElement>(
          '[role="tab"]',
        );
        if (
          target?.hasAttribute("disabled") ||
          target?.getAttribute("aria-disabled") === "true"
        )
          return;
        const active = list.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        );
        if (!active) return;
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          active,
          bounds: list.getBoundingClientRect(),
          moved: false,
        };
        // Avoid focus-triggered activation before release when activateOnFocus is enabled.
        event.preventDefault();
      }}
      onClickCapture={(event) => {
        if (blockClick.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClickCapture?.(event);
      }}
    />
  );
}
