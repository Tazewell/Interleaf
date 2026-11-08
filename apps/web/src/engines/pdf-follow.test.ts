// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFBlock } from "@interleaf/core";
import { PDFReadingNavigation } from "./pdf-navigation";

let frames: Map<number, FrameRequestCallback>;
let frameId: number;
beforeEach(() => {
  frames = new Map();
  frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => vi.unstubAllGlobals());
function tick(time: number) {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(time));
}
function setup() {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { value: 600 },
    clientHeight: { value: 600 },
    scrollWidth: { value: 1000 },
    scrollHeight: { value: 6000 },
  });
  host.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  const page = document.createElement("div");
  page.getBoundingClientRect = () =>
    new DOMRect(-host.scrollLeft, 1200 - host.scrollTop, 800, 1000);
  const block: PDFBlock = {
    id: "paragraph",
    page: 1,
    label: "text",
    text: "Paragraph",
    bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 },
  };
  let blocks = [block];
  const readingAnchor = vi.fn();
  const nav = new PDFReadingNavigation(
    host,
    { getPageView: () => ({ div: page }) } as unknown as PDFViewer,
    vi.fn(),
    () => blocks,
    { location: vi.fn(), selection: vi.fn(), readingAnchor },
  );
  return {
    host,
    page,
    block,
    nav,
    readingAnchor,
    setBlocks(value: PDFBlock[]) {
      blocks = value;
    },
  };
}

function columns() {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { value: 600 },
    clientHeight: { value: 600 },
    scrollWidth: { value: 600 },
    scrollHeight: { value: 6000 },
  });
  host.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  const pages = [1, 2].map((number) => {
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = String(number);
    page.getBoundingClientRect = vi.fn(
      () =>
        new DOMRect(
          -host.scrollLeft,
          1200 + (number - 1) * 1100 - host.scrollTop,
          600,
          1000,
        ),
    );
    host.append(page);
    return page;
  });
  const blocks: PDFBlock[] = [1, 2].flatMap((page) =>
    ["left", "right"].flatMap((column) =>
      ["top", "bottom"].map((part) => ({
        id: `${page}-${column}-${part}`,
        page,
        label: "text",
        text: "Paragraph",
        bounds: {
          x: column === "left" ? 0.1 : 0.55,
          y: part === "top" ? 0.2 : 0.5,
          width: 0.35,
          height: 0.2,
        },
      })),
    ),
  );
  const readingAnchor = vi.fn();
  const loadPage = vi.fn();
  const nav = new PDFReadingNavigation(
    host,
    {
      getPageView: (i: number) => ({ div: pages[i] }),
      currentScale: 1,
    } as unknown as PDFViewer,
    loadPage,
    () => blocks,
    { location: vi.fn(), selection: vi.fn(), readingAnchor },
  );
  return { host, pages, nav, readingAnchor, loadPage };
}

it("keeps the followed right column when the source resumes small wheel scrolling", async () => {
  const s = columns();
  try {
    await s.nav.follow(
      { blockId: "1-right-bottom", fraction: 0.5 },
      { smooth: false },
    );
    expect(s.nav.anchor()).toEqual({
      blockId: "1-right-bottom",
      fraction: 0.5,
    });
    s.host.dispatchEvent(new WheelEvent("wheel", { deltaY: 10 }));
    s.host.scrollTop += 10;
    s.host.dispatchEvent(new Event("scroll"));
    tick(0);
    expect(s.readingAnchor).toHaveBeenLastCalledWith({
      blockId: "1-right-bottom",
      fraction: 0.55,
    });
  } finally {
    s.nav.destroy();
  }
});

it("lets a source click replace the followed column", async () => {
  const s = columns();
  try {
    await s.nav.follow(
      { blockId: "1-right-bottom", fraction: 0.5 },
      { smooth: false },
    );
    s.pages[0].dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: 150,
        clientY: 300,
      }),
    );
    s.host.scrollTop += 10;
    expect(s.nav.anchor()).toEqual({
      blockId: "1-left-bottom",
      fraction: 0.55,
    });
  } finally {
    s.nav.destroy();
  }
});

it("keeps the followed column when source scrolling starts on the scrollbar", async () => {
  const s = columns();
  try {
    await s.nav.follow(
      { blockId: "1-right-bottom", fraction: 0.5 },
      { smooth: false },
    );
    s.host.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 599, clientY: 300 }),
    );
    s.host.scrollTop += 10;
    s.host.dispatchEvent(new Event("scroll"));
    tick(0);
    expect(s.readingAnchor).toHaveBeenLastCalledWith({
      blockId: "1-right-bottom",
      fraction: 0.55,
    });
  } finally {
    s.nav.destroy();
  }
});

it("keeps a followed column whose center is clipped but whose text is still visible", async () => {
  const s = columns();
  vi.mocked(s.pages[0].getBoundingClientRect).mockImplementation(
    () => new DOMRect(-s.host.scrollLeft, 1200 - s.host.scrollTop, 900, 1000),
  );
  try {
    await s.nav.follow(
      { blockId: "1-right-bottom", fraction: 0.5 },
      { smooth: false },
    );
    expect(s.nav.anchor()).toEqual({
      blockId: "1-right-bottom",
      fraction: 0.5,
    });
  } finally {
    s.nav.destroy();
  }
});

it("does not carry the followed column across pages or restore it on returning", async () => {
  const s = columns();
  try {
    await s.nav.follow(
      { blockId: "1-right-bottom", fraction: 0.5 },
      { smooth: false },
    );
    s.host.scrollTop = 2600;
    expect(s.nav.anchor()).toEqual({ blockId: "2-left-bottom", fraction: 0.5 });
    s.host.scrollTop = 1500;
    expect(s.nav.anchor()).toEqual({ blockId: "1-left-bottom", fraction: 0.5 });
  } finally {
    s.nav.destroy();
  }
});

it("lets explicit block focus replace the followed column", async () => {
  const s = columns();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  try {
    await s.nav.follow(
      { blockId: "1-right-bottom", fraction: 0.5 },
      { smooth: false },
    );
    const pending = s.nav.focusBlock("1-left-bottom");
    tick(0);
    await pending;
    expect(s.nav.anchor()?.blockId).toBe("1-left-bottom");
  } finally {
    s.nav.destroy();
  }
});

it("releases the followed column for an explicit page jump", async () => {
  const s = columns();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  try {
    await s.nav.follow(
      { blockId: "1-right-bottom", fraction: 0.5 },
      { smooth: false },
    );
    const pending = s.nav.goTo(1);
    tick(0);
    await pending;
    s.host.scrollTop = 1500;
    expect(s.nav.anchor()).toEqual({ blockId: "1-left-bottom", fraction: 0.5 });
  } finally {
    s.nav.destroy();
  }
});

it("does not keep the column of a cancelled asynchronous block focus", async () => {
  const s = columns();
  let loaded!: () => void;
  s.loadPage.mockReturnValue(
    new Promise<void>((resolve) => {
      loaded = resolve;
    }),
  );
  try {
    await s.nav.follow(
      { blockId: "1-right-bottom", fraction: 0.5 },
      { smooth: false },
    );
    const pending = s.nav.focusBlock("1-left-bottom", "parallel");
    s.host.dispatchEvent(new WheelEvent("wheel", { deltaY: 10 }));
    loaded();
    expect(await pending).toBe(false);
    expect(s.nav.anchor()).toEqual({
      blockId: "1-right-bottom",
      fraction: 0.5,
    });
  } finally {
    s.nav.destroy();
  }
});

it("emits a continuous gap anchor instead of changing paragraphs after two source pixels", () => {
  const s = setup();
  s.setBlocks([
    {
      ...s.block,
      id: "previous",
      bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
    },
    {
      ...s.block,
      id: "next",
      bounds: { x: 0.1, y: 0.8, width: 0.8, height: 0.1 },
    },
  ]);
  try {
    s.host.scrollTop = 1449;
    expect(s.nav.anchor()).toMatchObject({
      blockId: "previous",
      fraction: 1,
      gap: { nextBlockId: "next" },
    });
    expect(s.nav.anchor()?.gap?.fraction).toBeCloseTo(0.498);
    s.host.scrollTop = 1451;
    expect(s.nav.anchor()).toMatchObject({
      blockId: "previous",
      fraction: 1,
      gap: { nextBlockId: "next" },
    });
    expect(s.nav.anchor()?.gap?.fraction).toBeCloseTo(0.502);
  } finally {
    s.nav.destroy();
  }
});

it("interpolates immediate following through a source gap", async () => {
  const s = setup();
  s.setBlocks([
    {
      ...s.block,
      id: "previous",
      bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
    },
    {
      ...s.block,
      id: "next",
      bounds: { x: 0.1, y: 0.8, width: 0.8, height: 0.1 },
    },
  ]);
  const layout = vi.spyOn(s.page, "getBoundingClientRect");
  try {
    await s.nav.follow(
      {
        blockId: "previous",
        fraction: 1,
        gap: { nextBlockId: "next", fraction: 0.4 },
      },
      { smooth: false },
    );
    expect(s.host.scrollTop).toBe(1400);
    await s.nav.follow(
      {
        blockId: "previous",
        fraction: 1,
        gap: { nextBlockId: "next", fraction: 0.402 },
      },
      { smooth: false },
    );
    expect(s.host.scrollTop).toBe(1401);
    expect(layout).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  } finally {
    s.nav.destroy();
  }
});

it("does not create a gap between different columns even when their geometry moves downward", async () => {
  const s = setup();
  s.setBlocks([
    {
      ...s.block,
      id: "left",
      bounds: { x: 0.1, y: 0.2, width: 0.35, height: 0.1 },
    },
    {
      ...s.block,
      id: "right",
      bounds: { x: 0.55, y: 0.8, width: 0.35, height: 0.1 },
    },
  ]);
  try {
    s.host.scrollTop = 1450;
    expect(s.nav.anchor()?.gap).toBeUndefined();
    await s.nav.follow(
      {
        blockId: "left",
        fraction: 1,
        gap: { nextBlockId: "right", fraction: 0.5 },
      },
      { smooth: false },
    );
    expect(s.host.scrollTop).toBe(1200);
  } finally {
    s.nav.destroy();
  }
});

it("interpolates across page boundaries with one geometry read per endpoint page", async () => {
  const s = columns();
  try {
    await s.nav.follow(
      {
        blockId: "1-right-bottom",
        fraction: 1,
        gap: { nextBlockId: "2-left-top", fraction: 0.5 },
      },
      { smooth: false },
    );
    expect(s.host.scrollTop).toBe(1900);
    expect(s.pages[0].getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(s.pages[1].getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(s.nav.anchor()).toEqual({
      blockId: "1-right-bottom",
      fraction: 1,
      gap: { nextBlockId: "2-left-top", fraction: 0.5 },
    });
  } finally {
    s.nav.destroy();
  }
});

it("does not interpolate upward when reading order moves to the next column", async () => {
  const s = setup();
  s.setBlocks([
    {
      ...s.block,
      id: "left-bottom",
      bounds: { x: 0.1, y: 0.8, width: 0.35, height: 0.1 },
    },
    {
      ...s.block,
      id: "right-top",
      bounds: { x: 0.55, y: 0.1, width: 0.35, height: 0.1 },
    },
  ]);
  try {
    s.host.scrollTop = 1400;
    expect(s.nav.anchor()?.gap).toBeUndefined();
    await s.nav.follow(
      {
        blockId: "left-bottom",
        fraction: 1,
        gap: { nextBlockId: "right-top", fraction: 0.5 },
      },
      { smooth: false },
    );
    expect(s.host.scrollTop).toBe(1800);
  } finally {
    s.nav.destroy();
  }
});

it("follows consecutive manual scroll anchors immediately without starting an animation", async () => {
  const s = setup();
  try {
    for (const [fraction, top] of [
      [0, 1100],
      [0.5, 1200],
      [1, 1300],
    ]) {
      const pending = s.nav.follow(
        { blockId: "paragraph", fraction },
        { smooth: false },
      );
      expect(s.host.scrollTop).toBe(top);
      expect(frames.size).toBe(0);
      await pending;
    }
  } finally {
    s.nav.destroy();
    tick(1000);
  }
});

it("clamps immediate following to both scrollable axes", async () => {
  const s = setup();
  s.setBlocks([
    {
      ...s.block,
      bounds: { x: 2, y: 10, width: 0.4, height: 0.2 },
    },
  ]);
  try {
    const pending = s.nav.follow(
      { blockId: "paragraph", fraction: 0.5 },
      { smooth: false },
    );
    expect(s.host.scrollLeft).toBe(400);
    expect(s.host.scrollTop).toBe(5400);
    await pending;
  } finally {
    s.nav.destroy();
    tick(1000);
  }
});

it("cancels an old smooth follow when a manual scroll anchor arrives", async () => {
  const s = setup();
  try {
    const previous = s.nav.follow({ blockId: "paragraph", fraction: 0 });
    tick(0);
    tick(80);
    expect(s.host.scrollTop).toBeGreaterThan(0);
    expect(s.host.scrollTop).toBeLessThan(1100);
    const latest = s.nav.follow(
      { blockId: "paragraph", fraction: 1 },
      { smooth: false },
    );
    expect(s.host.scrollTop).toBe(1300);
    tick(160);
    tick(400);
    await Promise.all([previous, latest]);
    expect(s.host.scrollTop).toBe(1300);
    expect(s.readingAnchor).not.toHaveBeenCalled();
  } finally {
    s.nav.destroy();
    tick(1000);
  }
});

it("does not feed immediate following back as input and resumes reporting manual scrolling", async () => {
  const s = setup();
  try {
    // A previously queued source anchor must not outlive the new follower move.
    s.host.dispatchEvent(new Event("scroll"));
    const pending = s.nav.follow(
      { blockId: "paragraph", fraction: 0.5 },
      { smooth: false },
    );
    s.host.dispatchEvent(new Event("scroll"));
    tick(0);
    tick(300);
    await pending;
    tick(400);
    expect(s.readingAnchor).not.toHaveBeenCalled();

    s.host.dispatchEvent(new WheelEvent("wheel", { deltaY: 50 }));
    s.host.scrollTop = 1250;
    s.host.dispatchEvent(new Event("scroll"));
    tick(500);
    expect(s.readingAnchor).toHaveBeenLastCalledWith({
      blockId: "paragraph",
      fraction: 0.75,
    });
  } finally {
    s.nav.destroy();
    tick(1000);
  }
});

it("keeps explicit following smooth by default", async () => {
  const s = setup();
  try {
    const pending = s.nav.follow({ blockId: "paragraph", fraction: 0.5 });
    expect(s.host.scrollTop).toBe(0);
    tick(0);
    tick(120);
    expect(s.host.scrollTop).toBeGreaterThan(0);
    expect(s.host.scrollTop).toBeLessThan(1200);
    tick(240);
    await pending;
    expect(s.host.scrollTop).toBe(1200);
  } finally {
    s.nav.destroy();
    tick(1000);
  }
});

it("finds the same middle block in a long document with a bounded number of page layout reads", () => {
  const host = document.createElement("div");
  host.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  let layoutReads = 0;
  const pages = Array.from({ length: 80 }, (_, i) => {
    const page = document.createElement("div");
    page.getBoundingClientRect = () => {
      layoutReads++;
      return new DOMRect(0, i * 1100 - host.scrollTop, 600, 1000);
    };
    return page;
  });
  let blocks: PDFBlock[] = Array.from({ length: 1600 }, (_, i) => ({
    id: `paragraph-${i}`,
    page: Math.floor(i / 20) + 1,
    label: "text",
    text: "Paragraph",
    bounds: { x: 0.1, y: (i % 20) * 0.05, width: 0.8, height: 0.04 },
  }));
  const nav = new PDFReadingNavigation(
    host,
    { getPageView: (i: number) => ({ div: pages[i] }) } as unknown as PDFViewer,
    vi.fn(),
    () => blocks,
    { location: vi.fn(), selection: vi.fn() },
  );
  try {
    expect(nav.anchor()?.blockId).toBe("paragraph-6");
    expect(layoutReads).toBeLessThanOrEqual(160);
    layoutReads = 0;
    host.scrollTop = 1100;
    expect(nav.anchor()?.blockId).toBe("paragraph-26");
    expect(layoutReads).toBeLessThanOrEqual(160);

    // Parsing can replace the block array; the next anchor must use fresh data.
    blocks = [
      {
        id: "replacement",
        page: 2,
        label: "text",
        text: "Replacement",
        bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.2 },
      },
    ];
    expect(nav.anchor()).toEqual({ blockId: "replacement", fraction: 0.5 });
  } finally {
    nav.destroy();
  }
});
