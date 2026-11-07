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
    block,
    nav,
    readingAnchor,
    setBlocks(value: PDFBlock[]) {
      blocks = value;
    },
  };
}

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
