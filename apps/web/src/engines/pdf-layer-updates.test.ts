// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Annotation, PDFBlock } from "@interleaf/core";

const fixture = vi.hoisted(() => ({
  dispatch: undefined as ((name: string, event: unknown) => void) | undefined,
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  EventBus: class {
    listeners = new Map<string, Set<(event: unknown) => void>>();
    constructor() {
      fixture.dispatch = (name, event) => {
        this.listeners.get(name)?.forEach((callback) => callback(event));
      };
    }
    on(name: string, callback: (event: unknown) => void) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(callback);
    }
  },
  PDFLinkService: class {
    setViewer() {}
  },
  PDFViewer: class {
    setDocument() {}
  },
}));

import { PDFReaderAdapter } from "./pdf";

let host: HTMLDivElement;
let adapter: PDFReaderAdapter;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  adapter = new PDFReaderAdapter(host, {
    location: vi.fn(),
    selection: vi.fn(),
  });
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"><div class="textLayer"><span>Figure 3</span></div></div>' +
    '<div class="page" data-page-number="2"><div class="textLayer"><span>Figure 3</span></div></div>';
});
afterEach(async () => {
  await adapter.destroy();
  host.remove();
  vi.unstubAllGlobals();
});

it("reconciles annotations only on the page reported by PDF.js", async () => {
  const annotations: Annotation[] = [1, 2].map((page) => ({
    id: `mark-${page}`,
    kind: "highlight",
    documentId: "book",
    quote: "Figure 3",
    note: "",
    color: "#facc15",
    createdAt: "",
    location: {
      type: "pdf",
      page,
      rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.05 }],
    },
  }));
  await adapter.highlight(annotations);
  host
    .querySelectorAll(".interleaf-annotation")
    .forEach((group) => group.remove());
  fixture.dispatch!("pagerendered", { pageNumber: 1, source: {} });
  expect(host.querySelector('[data-annotation-id="mark-1"]')).not.toBeNull();
  expect(host.querySelector('[data-annotation-id="mark-2"]')).toBeNull();
  fixture.dispatch!("pagerendered", { pageNumber: 2, source: {} });
  expect(host.querySelector('[data-annotation-id="mark-2"]')).not.toBeNull();
});

it("relinks only the text layer whose PDF.js render has completed", () => {
  const figure: PDFBlock = {
    id: "figure-3",
    page: 2,
    label: "image",
    text: "",
    caption: "Figure 3. Result",
    bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
  };
  adapter.setBlocks([figure]);
  const layers = host.querySelectorAll(".textLayer");
  for (const layer of layers) layer.innerHTML = "<span>Figure 3</span>";
  fixture.dispatch!("textlayerrendered", { pageNumber: 1, source: {} });
  expect(layers[0].querySelector("a[data-figure-reference]")).not.toBeNull();
  expect(layers[1].querySelector("a[data-figure-reference]")).toBeNull();
  fixture.dispatch!("textlayerrendered", { pageNumber: 2, source: {} });
  expect(layers[1].querySelector("a[data-figure-reference]")).not.toBeNull();
});
