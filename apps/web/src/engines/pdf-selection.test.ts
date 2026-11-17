// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1 },
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 1 }),
    destroy: async () => {},
  }),
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  EventBus: class {
    listeners = new Map<string, Set<() => void>>();
    on(name: string, callback: () => void) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(callback);
    }
    off(name: string, callback: () => void) {
      this.listeners.get(name)?.delete(callback);
    }
    dispatch(name: string) {
      this.listeners.get(name)?.forEach((callback) => callback());
    }
  },
  PDFLinkService: class {
    setViewer() {}
    setDocument() {}
  },
  PDFViewer: class {
    viewer: HTMLElement;
    eventBus: { dispatch(name: string): void };
    constructor(options: {
      viewer: HTMLElement;
      eventBus: { dispatch(name: string): void };
    }) {
      this.viewer = options.viewer;
      this.eventBus = options.eventBus;
      // PDFViewer._resetView clears lang both during construction and reload.
      this.viewer.removeAttribute("lang");
    }
    setDocument(pdf: unknown) {
      this.viewer.removeAttribute("lang");
      if (pdf) queueMicrotask(() => this.eventBus.dispatch("pagesinit"));
    }
  },
}));
import { PDFReaderAdapter } from "./pdf";
import { paper } from "../papers/fixtures";
let adapter: PDFReaderAdapter;
let host: HTMLDivElement;
const annotationChanged = vi.fn();
let changed: Mock<
  (selection: import("@interleaf/core").ReaderSelection | null) => void
>;
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
  changed = vi.fn();
  annotationChanged.mockClear();
  adapter = new PDFReaderAdapter(host, {
    location: vi.fn(),
    selection: changed,
    annotation: annotationChanged,
  });
  host.querySelector(".pdfViewer")!.innerHTML =
    '<div class="page" data-page-number="1"><span>Selected passage</span></div>';
  const page = host.querySelector(".page")!;
  vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
    new DOMRect(20, 40, 600, 800),
  );
  const range = document.createRange();
  range.selectNodeContents(page.firstChild!);
  Object.assign(range, {
    getClientRects: () => [new DOMRect(60, 100, 180, 20)],
  });
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  page.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, clientX: 240, clientY: 115 }),
  );
  expect(adapter.getSelection()?.text).toBe("Selected passage");
});
afterEach(async () => {
  await adapter.destroy();
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("clears the displayed selection after clicking blank PDF space", () => {
  window.getSelection()!.removeAllRanges();
  host.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(adapter.getSelection()).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(null);
});
it("keeps unknown PDF language independent of the app language after viewer resets", async () => {
  const previousLanguage = document.documentElement.lang;
  document.documentElement.lang = "zh-CN";
  try {
    await adapter.open(paper());
    expect(
      host.querySelector(".pdfViewer")!.closest("[lang]")?.getAttribute("lang"),
    ).toBe("");
  } finally {
    document.documentElement.lang = previousLanguage;
  }
});
it("clears the displayed selection when the browser collapses it without a mouseup", () => {
  window.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  expect(adapter.getSelection()).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(null);
});

it("clears native ranges on explicit dismissal so the next mouseup cannot restore the toolbar", () => {
  adapter.clearSelection();
  expect(window.getSelection()!.rangeCount).toBe(0);
  host.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(adapter.getSelection()).toBeNull();
});
it("records the release point near the selected line rather than the reader bottom", () => {
  expect(adapter.getSelection()?.anchor).toEqual({
    x: 240,
    top: 100,
    bottom: 120,
  });
});
it("preserves the selection for toolbar actions but clears it when clicking another panel", () => {
  const toolbar = document.createElement("div");
  toolbar.className = "selection-bar";
  document.body.append(toolbar);
  toolbar.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  expect(adapter.getSelection()?.text).toBe("Selected passage");
  document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  expect(adapter.getSelection()).toBeNull();
  expect(window.getSelection()!.rangeCount).toBe(0);
  toolbar.remove();
});

it("does not read global Selection or scan highlights during idle scroll", () => {
  adapter.clearSelection();
  const selection = vi.spyOn(window, "getSelection");
  const query = vi.spyOn(host, "querySelectorAll");
  for (let i = 0; i < 5; i++) host.dispatchEvent(new Event("scroll"));
  expect(selection).not.toHaveBeenCalled();
  expect(
    query.mock.calls.filter(([selector]) => selector.includes("highlight")),
  ).toHaveLength(0);
});
it("clears an unrecognized cross-page native selection on scroll", () => {
  adapter.clearSelection();
  const viewer = host.querySelector(".pdfViewer")!;
  viewer.insertAdjacentHTML(
    "beforeend",
    '<div class="page" data-page-number="2"><span>Other page</span></div>',
  );
  const spans = viewer.querySelectorAll("span");
  const range = document.createRange();
  range.setStart(spans[0].firstChild!, 0);
  range.setEnd(spans[1].firstChild!, 5);
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  expect(adapter.getSelection()).toBeNull();
  host.dispatchEvent(new Event("scroll"));
  expect(window.getSelection()!.rangeCount).toBe(0);
});
it.each([false, true])(
  "clears a native drag before mouseup (selectionchange delivered: %s)",
  (delivered) => {
    adapter.clearSelection();
    const text = host.querySelector("span")!;
    text.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.addRange(range);
    if (delivered) document.dispatchEvent(new Event("selectionchange"));
    expect(adapter.getSelection()).toBeNull();
    host.dispatchEvent(new Event("scroll"));
    expect(window.getSelection()!.rangeCount).toBe(0);
    text.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(adapter.getSelection()).toBeNull();
  },
);
it("preserves another reader's native selection while scrolling and explicitly clearing", () => {
  const other = document.createElement("div");
  other.textContent = "Other reader";
  document.body.append(other);
  const range = document.createRange();
  range.selectNodeContents(other);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  host.dispatchEvent(new Event("scroll"));
  adapter.clearSelection();
  expect(window.getSelection()!.toString()).toBe("Other reader");
  other.remove();
});
it("clears native selection with Escape", () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(window.getSelection()!.rangeCount).toBe(0);
  expect(adapter.getSelection()).toBeNull();
});

it("preserves an external input selection on reader scroll", () => {
  adapter.clearSelection();
  const input = document.createElement("input");
  input.value = "External input";
  document.body.append(input);
  input.focus();
  input.setSelectionRange(0, 8);
  host.dispatchEvent(new Event("scroll"));
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(8);
  input.remove();
});

it("dismisses an active annotation on scroll once and remains idle afterward", async () => {
  adapter.clearSelection();
  await adapter.highlight([
    {
      id: "a",
      documentId: "p",
      kind: "highlight",
      color: "#facc15",
      quote: "Selected",
      note: "",
      createdAt: "",
      location: {
        type: "pdf",
        page: 1,
        rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.1 }],
      },
    },
  ]);
  const text = host.querySelector("span")!;
  for (const type of ["pointerdown", "mouseup", "click"])
    text.dispatchEvent(
      new MouseEvent(type, { bubbles: true, clientX: 100, clientY: 130 }),
    );
  expect(annotationChanged.mock.lastCall?.[0]?.ids).toEqual(["a"]);
  annotationChanged.mockClear();
  for (let i = 0; i < 5; i++) host.dispatchEvent(new Event("scroll"));
  expect(annotationChanged).toHaveBeenCalledExactlyOnceWith(null);
});
