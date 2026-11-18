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
  {
    release,
    onActive,
  }: {
    release?: (previous: NativePane) => void;
    onActive?: (side: NativePane) => void;
  } = {},
) {
  const panes = {
    source: viewport(source),
    translation: viewport(translation),
  };
  let active: NativePane = "source";
  let enabled = true;
  let positions: Partial<Record<NativePane, Position>> = {};
  const listeners = new AbortController();
  const options = { passive: true, signal: listeners.signal };
  const activate = (side: NativePane) => {
    if (active === side) return;
    release?.(active);
    active = side;
    onActive?.(side);
  };
  const sync = () => {
    const position = panes[active].read();
    if (position === undefined) return;
    positions[active] = position;
    if (!enabled) return;
    const follower = active === "source" ? "translation" : "source";
    positions[follower] = position;
    panes[follower].write(position);
  };
  const capture = () => {
    if (enabled) {
      const position = panes[active].read() ?? positions[active];
      return { source: position, translation: position };
    }
    return {
      source: panes.source.read() ?? positions.source,
      translation: panes.translation.read() ?? positions.translation,
    };
  };
  const restore = () => {
    if (positions[active] === undefined) sync();
    if (positions.source !== undefined) panes.source.write(positions.source);
    if (positions.translation !== undefined)
      panes.translation.write(positions.translation);
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
    get enabled() {
      return enabled;
    },
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      if (enabled) sync();
      else positions = capture();
    },
    activate,
    sync,
    captureForSwap() {
      const anchors = capture();
      const sourceLeft = source.scrollLeft,
        translatedLeft = translation.scrollLeft;
      return () => {
        positions = anchors;
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
