export type NativePane = "source" | "translation";

type Position =
  "start" | "end" | { index: number; fraction: number; gap: number };

function viewport(host: HTMLElement) {
  // Continuous PDF.js viewers have one direct child per logical page.
  const viewer = host.querySelector<HTMLElement>(".pdfViewer")!;
  const pages = viewer.children;
  const bounds = (index: number) => pages[index]?.getBoundingClientRect();
  const midpoint = () =>
    host.getBoundingClientRect().top + host.clientHeight / 2;
  let lastPage = 0;
  function read(): Position | undefined {
    if (!pages.length || !host.clientHeight) return;
    if (host.scrollTop <= 0) return "start";
    if (host.scrollTop >= host.scrollHeight - host.clientHeight - 1)
      return "end";
    const center = midpoint();
    let page = bounds(lastPage);
    if (!page || center < page.top || center > page.bottom) {
      let low = 0,
        high = pages.length - 1;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (bounds(middle)!.bottom < center) low = middle + 1;
        else high = middle;
      }
      lastPage = low;
      page = bounds(low);
    }
    if (!page?.height) return;
    const inside = Math.min(page.height, Math.max(0, center - page.top));
    return {
      index: lastPage,
      fraction: inside / page.height,
      gap: center - page.top - inside,
    };
  }
  function write(position: Position) {
    let top: number;
    if (position === "start") top = 0;
    else if (position === "end") top = host.scrollHeight - host.clientHeight;
    else {
      const page = bounds(position.index);
      if (!page?.height) return;
      lastPage = position.index;
      top =
        host.scrollTop +
        page.top +
        position.fraction * page.height +
        position.gap -
        midpoint();
    }
    if (Math.abs(host.scrollTop - top) >= 0.5) host.scrollTop = top;
  }
  return { host, viewer, read, write };
}

/** Only the input pane drives. Reflected scroll events never start a second follow. */
export function linkNativePDFPanes(
  source: HTMLElement,
  translation: HTMLElement,
  release?: (previous: NativePane) => void,
) {
  const panes = {
    source: viewport(source),
    translation: viewport(translation),
  };
  let active: NativePane = "source";
  let position: Position | undefined;
  const listeners = new AbortController();
  const options = { passive: true, signal: listeners.signal };
  const activate = (side: NativePane) => {
    if (active === side) return;
    release?.(active);
    active = side;
  };
  const sync = () => {
    position = panes[active].read();
    if (position !== undefined)
      panes[active === "source" ? "translation" : "source"].write(position);
  };
  const restore = () => {
    if (position === undefined) return sync();
    panes.source.write(position);
    panes.translation.write(position);
  };
  const observer = new ResizeObserver(restore);
  for (const side of ["source", "translation"] as const) {
    const { host, viewer } = panes[side];
    const takeOver = () => activate(side);
    for (const event of [
      "wheel",
      "pointerdown",
      "keydown",
      "touchstart",
      "focusin",
    ])
      host.addEventListener(event, takeOver, options);
    host.addEventListener(
      "scroll",
      () => {
        if (side === active) sync();
      },
      options,
    );
    observer.observe(host);
    observer.observe(viewer);
  }
  return {
    get active() {
      return active;
    },
    activate,
    sync,
    captureForSwap() {
      const anchor = panes[active].read() ?? position;
      const sourceLeft = source.scrollLeft,
        translatedLeft = translation.scrollLeft;
      return () => {
        position = anchor;
        restore();
        source.scrollLeft = sourceLeft;
        translation.scrollLeft = translatedLeft;
      };
    },
    destroy() {
      listeners.abort();
      observer.disconnect();
    },
  };
}
