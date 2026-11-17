// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { NativePDFReadingDescriptor } from "./pdf-native-reading";
const state = vi.hoisted(() => ({
  urls: [] as string[],
  loads: [] as { url: string; disableRange?: boolean }[],
  documents: [] as unknown[],
  destroys: [] as ReturnType<typeof vi.fn>[],
  viewers: 0,
  renderedOriginal: [] as boolean[],
  defer: false,
  suppressPagesInit: false,
  annotations: [] as {
    subtype: string;
    rect: number[];
    url?: string;
    dest?: number[];
  }[],
  releases: [] as (() => void)[],
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: (options: { url: string; disableRange?: boolean }) => {
    const { url } = options;
    state.loads.push(options);
    state.urls.push(url);
    const original = state.urls.length % 2 === 0;
    const destroy = vi.fn(async () => {});
    state.destroys.push(destroy);
    const result = Promise.resolve({
      numPages: 1,
      getOutline: async () =>
        original ? [{ title: "Original heading", dest: [0], items: [] }] : null,
      getPage: async () => ({
        getViewport: () => ({
          width: original ? 600 : 1212,
          height: 800,
          convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
        }),
        getTextContent: async () => ({
          items: [
            {
              str: original ? "Original source context" : "Visible source 译文",
              transform: [1, 0, 0, 1, 672, 704],
              height: 16,
            },
          ],
        }),
        getAnnotations: async () => state.annotations,
        render: () => {
          state.renderedOriginal.push(original);
          return { promise: Promise.resolve(), cancel: vi.fn() };
        },
      }),
    });
    return {
      destroy,
      promise: state.defer
        ? new Promise((resolve) =>
            state.releases.push(() => result.then(resolve)),
          )
        : result,
    };
  },
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  EventBus: class {
    listeners = new Map<string, Set<(...args: any[]) => void>>();
    on(n: string, c: () => void) {
      if (!this.listeners.has(n)) this.listeners.set(n, new Set());
      this.listeners.get(n)!.add(c);
    }
    off(n: string, c: () => void) {
      this.listeners.get(n)?.delete(c);
    }
    dispatch(n: string) {
      this.listeners.get(n)?.forEach((c) => c());
    }
  },
  PDFLinkService: class {
    setViewer() {}
    setDocument() {}
  },
  PDFViewer: class {
    viewer: HTMLElement;
    bus: any;
    constructor(o: any) {
      state.viewers++;
      this.viewer = o.viewer;
      this.bus = o.eventBus;
    }
    setDocument(d: unknown) {
      state.documents.push(d);
      if (d && !state.suppressPagesInit)
        queueMicrotask(() => this.bus.dispatch("pagesinit"));
    }
    getPageView() {
      return { div: this.viewer.querySelector(".page") };
    }
  },
}));
import { PDFReaderAdapter } from "./pdf";
import { paper } from "../papers/fixtures";
let host: HTMLDivElement, adapter: PDFReaderAdapter;
const descriptor: NativePDFReadingDescriptor = {
  fileURL: "/native-file",
  translations: [
    {
      blockId: "b",
      sourceHash: "h",
      status: "complete",
      sentences: [{ source: "a", target: "译文" }],
    },
  ],
  metadata: {
    version: 1,
    documentId: "p",
    cacheKey: "k",
    originalSha256: "s",
    layoutRevision: "l",
    translationRevision: "t",
    rendererVersion: "r",
    pdfSha256: "s",
    pdfBytes: 1,
    translatedParagraphs: 1,
    originalParagraphs: 0,
    warnings: [],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        outputWidth: 1212,
        translationOffsetX: 612,
        paragraphs: [
          {
            id: "p",
            blockId: "b",
            sourceHash: "h",
            bounds: { x: 60, y: 80, width: 480, height: 160 },
            translated: true,
            target: "译文",
          },
        ],
      },
    ],
  },
};
beforeEach(() => {
  state.urls = [];
  state.loads = [];
  state.documents = [];
  state.destroys = [];
  state.viewers = 0;
  state.renderedOriginal = [];
  state.defer = false;
  state.suppressPagesInit = false;
  state.annotations = [];
  state.releases = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  adapter = new PDFReaderAdapter(
    host,
    { location: vi.fn(), selection: vi.fn() },
    descriptor,
  );
});
afterEach(async () => {
  await adapter.destroy();
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("uses one wide viewer and a raw original metadata proxy; releases both tasks", async () => {
  await adapter.open(paper());
  expect(state.urls[0]).toBe("/native-file");
  expect(state.urls[1]).toContain("original.pdf");
  expect(state.viewers).toBe(1);
  expect(state.documents.filter(Boolean)).toHaveLength(1);
  expect((await adapter.getTOC())[0].label).toBe("Original heading");
  expect(await adapter.getContext()).toBe("Original source context");
  expect(await adapter.search("译文")).toHaveLength(1);
  expect(await adapter.search("Original source context")).toHaveLength(0);
  await adapter.destroy();
  expect(state.destroys).toHaveLength(2);
  expect(state.destroys.every((d) => d.mock.calls.length === 1)).toBe(true);
});
it("loads the derived reading PDF without byte ranges while preserving original metadata loading defaults", async () => {
  await adapter.open(paper());
  expect(state.loads[0]).toMatchObject({
    url: "/native-file",
    disableRange: true,
  });
  expect(state.loads[1].disableRange).toBeUndefined();
});
it("preserves PDF.js byte-range defaults for ordinary PDFs", async () => {
  await adapter.destroy();
  adapter = new PDFReaderAdapter(host, {
    location: vi.fn(),
    selection: vi.fn(),
  });
  await adapter.open(paper());
  expect(state.loads).toHaveLength(1);
  expect(state.loads[0].url).toContain("original.pdf");
  expect(state.loads[0].disableRange).toBeUndefined();
});
it("returns source coordinates on the left and a legitimate translation anchor on the right", async () => {
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"><span>译文</span></div>';
  const page = host.querySelector(".page")!;
  vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1212, 800),
  );
  const select = (x: number) => {
    const range = document.createRange();
    range.selectNodeContents(page.firstChild!);
    Object.assign(range, {
      getClientRects: () => [new DOMRect(x, 80, 30, 20)],
    });
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    page.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  };
  select(60);
  expect(adapter.getSelection()?.location).toMatchObject({
    rects: [{ x: 0.1, y: 0.1, width: 0.05, height: 0.025 }],
  });
  select(672);
  const selection = adapter.getSelection()!;
  expect(selection.location).toMatchObject({
    translation: { blockId: "b", start: 0, end: 2 },
  });
  expect(selection.location).not.toHaveProperty("rects");
  expect(await adapter.prepareAnnotation!(selection)).toBe(selection);
  select(600);
  await expect(
    adapter.prepareAnnotation!(adapter.getSelection()!),
  ).rejects.toThrow();
});
it("projects original highlights left and existing HTML anchors right without mutating saved locations", async () => {
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"></div>';
  const base = {
    id: "a",
    kind: "highlight" as const,
    documentId: "p",
    quote: "译文",
    note: "",
    createdAt: "",
    color: "#123456",
  };
  const original = {
    ...base,
    location: {
      type: "pdf" as const,
      page: 1,
      rects: [{ x: 0.1, y: 0.1, width: 0.8, height: 0.2 }],
    },
  };
  await adapter.highlight([original]);
  expect(
    host.querySelector<HTMLElement>(".interleaf-highlight")!.style.left,
  ).toBe(`${(60 / 1212) * 100}%`);
  expect(original.location.rects[0].x).toBe(0.1);
  await adapter.highlight([
    {
      ...base,
      location: {
        type: "pdf",
        page: 1,
        translation: {
          blockId: "b",
          sourceHash: "h",
          start: 0,
          end: 2,
          sentenceIndexes: [0],
          targetText: "译文",
        },
      },
    },
  ]);
  expect(
    host.querySelector<HTMLElement>(".interleaf-highlight")!.style.left,
  ).toBe(`${(672 / 1212) * 100}%`);
  await adapter.highlight([
    {
      ...base,
      location: {
        type: "pdf",
        page: 1,
        translation: {
          blockId: "b",
          sourceHash: "stale",
          start: 0,
          end: 2,
          sentenceIndexes: [0],
          targetText: "译文",
        },
      },
    },
  ]);
  expect(host.querySelector(".interleaf-highlight")).toBeNull();
});
it("maps source navigation to the wide page while reporting source locations", async () => {
  await adapter.open(paper());
  const navigation = (
    adapter as unknown as { navigation: { goTo: ReturnType<typeof vi.fn> } }
  ).navigation;
  const go = vi.spyOn(navigation, "goTo").mockResolvedValue(true);
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"><span>Source passage</span></div>';
  const range = document.createRange();
  range.selectNodeContents(host.querySelector("span")!);
  window.getSelection()!.addRange(range);
  await adapter.goTo({ type: "pdf", page: 1, x: 0.5, y: 0.2 });
  expect(window.getSelection()!.rangeCount).toBe(0);
  expect(go).toHaveBeenCalledWith(1, {
    x: 300 / 1212,
    y: 0.2,
    width: 0,
    height: 0,
  });
  await adapter.goTo({
    type: "pdf",
    page: 1,
    translation: {
      blockId: "b",
      sourceHash: "h",
      start: 0,
      end: 2,
      sentenceIndexes: [0],
      targetText: "译文",
    },
  });
  expect(go.mock.lastCall?.[1]).toMatchObject({ x: 672 / 1212, y: 0.1 });
});
it("preserves figures on both halves in deep dark mode", () => {
  adapter.setBlocks([
    {
      id: "fig",
      page: 1,
      label: "image",
      text: "",
      bounds: { x: 0.1, y: 0.1, width: 0.4, height: 0.3 },
    },
  ]);
  const regions = (
    adapter as unknown as { figureRegions: (page: number) => unknown[] }
  ).figureRegions(1);
  expect(regions).toEqual([
    { x: 60 / 1212, y: 0.1, width: 240 / 1212, height: 0.3 },
    { x: 672 / 1212, y: 0.1, width: 240 / 1212, height: 0.3 },
  ]);
});
it("keeps cross-page text usable as a page citation but refuses a precise annotation", async () => {
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"><span>译文</span></div><div class="page" data-page-number="2"><span>另页</span></div>';
  const pages = host.querySelectorAll(".page");
  const range = document.createRange();
  range.setStart(pages[0].firstChild!.firstChild!, 0);
  range.setEnd(pages[1].firstChild!.firstChild!, 2);
  Object.assign(range, { getClientRects: () => [] });
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  pages[1].dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(adapter.getSelection()?.location).toEqual({
    type: "pdf",
    page: 1,
    quote: "译文另页",
  });
  await expect(
    adapter.prepareAnnotation(adapter.getSelection()!),
  ).rejects.toThrow();
});

it("disposes both pending document loads and never binds a stale result to the viewer", async () => {
  state.defer = true;
  const pending = adapter.open(paper());
  expect(state.urls).toHaveLength(2);
  await adapter.destroy();
  for (const release of state.releases) release();
  await pending;
  expect(state.documents.filter(Boolean)).toHaveLength(0);
  expect(state.destroys.every((d) => d.mock.calls.length === 1)).toBe(true);
});
it("revalidates right anchors at annotation preparation after visible translations change", async () => {
  const selection = {
    text: "译文",
    location: {
      type: "pdf" as const,
      page: 1,
      quote: "译文",
      translation: {
        blockId: "b",
        sourceHash: "stale",
        start: 0,
        end: 2,
        sentenceIndexes: [0],
        targetText: "译文",
      },
    },
  };
  await expect(adapter.prepareAnnotation(selection)).rejects.toThrow();
});

it("settles an open waiting for pagesinit when the adapter is destroyed", async () => {
  state.suppressPagesInit = true;
  let opened = false;
  const pending = adapter.open(paper()).then(() => {
    opened = true;
  });
  await vi.waitFor(() =>
    expect(state.documents.filter(Boolean)).toHaveLength(1),
  );
  await adapter.destroy();
  await vi.waitFor(() => expect(opened).toBe(true), { timeout: 100 });
  await pending;
});
it("restores safe original link rectangles on the source half and drops active URLs", async () => {
  await adapter.open(paper());
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"></div>';
  state.annotations = [
    { subtype: "Link", rect: [60, 700, 180, 720], url: "https://example.com" },
    { subtype: "Link", rect: [60, 700, 180, 720], url: "javascript:alert(1)" },
    { subtype: "Link", rect: [60, 700, 180, 720], dest: [0] },
  ];
  await (
    adapter as unknown as { paintNativeLinks: (n: number) => Promise<void> }
  ).paintNativeLinks(1);
  const links = host.querySelectorAll<HTMLAnchorElement>(
    ".interleaf-native-link",
  );
  expect(links).toHaveLength(2);
  expect(links[0].href).toBe("https://example.com/");
  expect(links[0].style.left).toBe(`${(60 / 1212) * 100}%`);
  expect(links[0].style.top).toBe("10%");
});
it("persists horizontal progress from either half in original page coordinates", () => {
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"></div>';
  vi.spyOn(
    host.querySelector(".page")!,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(-672, 0, 1212, 800));
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 300, 800),
  );
  expect(adapter.getLocation().x).toBeCloseTo(0.1);
});
it("follows Chinese-only native search hits to right-side text without persisting wide coordinates", async () => {
  await adapter.open(paper());
  const hits = await adapter.search("译文");
  const navigation = (
    adapter as unknown as {
      navigation: {
        goTo: (
          page: number,
          point?: { x: number; y: number },
        ) => Promise<boolean>;
      };
    }
  ).navigation;
  const go = vi.spyOn(navigation, "goTo").mockResolvedValue(true);
  await adapter.goTo(hits[0].location);
  expect(go.mock.lastCall?.[1]).toMatchObject({ x: 672 / 1212, y: 80 / 800 });
  expect(hits[0].location).not.toHaveProperty("rects");
  expect(hits[0].location).not.toHaveProperty("x");
});
it("previews restored original internal links on hover and navigates the source page on click", async () => {
  await adapter.open(paper());
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"></div>';
  state.annotations = [
    { subtype: "Link", rect: [60, 700, 180, 720], dest: [0] },
  ];
  await (
    adapter as unknown as { paintNativeLinks: (n: number) => Promise<void> }
  ).paintNativeLinks(1);
  const shown = vi.fn(),
    follow = vi.fn();
  Object.assign((adapter as unknown as { events: object }).events, {
    linkPreview: shown,
    internalLink: follow,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,preview",
  );
  const go = vi.spyOn(adapter, "goTo").mockResolvedValue();
  const link = host.querySelector<HTMLAnchorElement>(".interleaf-native-link")!;
  vi.useFakeTimers();
  link.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(300);
  expect(shown).toHaveBeenCalledWith(
    expect.objectContaining({
      page: 1,
      image: "data:image/png;base64,preview",
      location: { type: "pdf", page: 1, x: 0, y: 0 },
    }),
  );
  expect(state.renderedOriginal).toEqual([true]);
  link.click();
  await Promise.resolve();
  expect(go).toHaveBeenCalledWith({ type: "pdf", page: 1 });
  expect(follow).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
