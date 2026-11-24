import styles from "./scrollbars.css?inline";

/** Capture also covers scroll events from portals and nested scroll containers. */
export function installScrollbars(doc: Document) {
  const style = doc.createElement("style");
  style.textContent = styles;
  doc.head.append(style);
  const active = new Map<
    Element,
    { deadline: number; timer: ReturnType<typeof setTimeout> }
  >();
  const onScroll = (event: Event) => {
    const target = event.target === doc ? doc.scrollingElement : event.target;
    // Avoid instanceof: EPUB elements belong to a different Window.
    if (!target || !("nodeType" in target) || target.nodeType !== 1) return;
    const element = target as Element;
    // PDF scrollbar visibility is static. Avoid inherited color changes that
    // would invalidate the PDF text layer during scrolling.
    if (element.matches(".interleaf-engine.pdf-container")) return;
    const deadline = performance.now() + 1000;
    const current = active.get(element);
    if (current) {
      current.deadline = deadline;
      return;
    }
    element.setAttribute("data-interleaf-scrolling", "");
    const state = { deadline, timer: setTimeout(onIdle, 1000) };
    active.set(element, state);
    function onIdle() {
      const remaining = state.deadline - performance.now();
      if (remaining > 0) {
        state.timer = setTimeout(onIdle, remaining);
        return;
      }
      element.removeAttribute("data-interleaf-scrolling");
      active.delete(element);
    }
  };
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("scroll", onScroll, true);
    for (const [element, state] of active) {
      clearTimeout(state.timer);
      element.removeAttribute("data-interleaf-scrolling");
    }
    active.clear();
    style.remove();
  };
}
