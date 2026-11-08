// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFBlock } from "@interleaf/core";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { ENABLE: 1, DISABLE: 0 },
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => ({
  EventBus: class {
    on() {}
    off() {}
  },
  PDFLinkService: class {
    setViewer() {}
  },
  PDFViewer: class {
    setDocument() {}
    getPageView() {}
  },
}));
import { PDFReaderAdapter } from "./pdf";

let adapter: PDFReaderAdapter;
let host: HTMLDivElement;
const block: PDFBlock = {
  id: "p1-b1",
  page: 1,
  label: "image",
  text: "",
  image: "assets/p1-b1.png",
  bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function page(render: (options: unknown) => unknown) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: vi.fn(render),
  };
}
function documentWith(getPage: () => Promise<unknown>) {
  (adapter as unknown as { pdf: unknown }).pdf = { getPage };
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob()),
  );
  host = document.createElement("div");
  document.body.append(host);
  adapter = new PDFReaderAdapter(host, {
    location: vi.fn(),
    selection: vi.fn(),
  });
  adapter.setBlocks([block]);
});
afterEach(async () => {
  await adapter.destroy();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("rejects cancellation during PNG encoding and releases the canvas", async () => {
  let encode!: BlobCallback;
  let canvas!: HTMLCanvasElement;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
  ) {
    canvas = this;
    encode = callback;
  });
  documentWith(async () =>
    page(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  );
  const controller = new AbortController();
  const result = adapter.renderBlockImage(block.id, controller.signal, 600);
  const settled = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(encode).toBeTypeOf("function"));
  controller.abort();
  encode(new Blob());
  await settled;
  expect(canvas.width).toBe(0);
  expect(canvas.height).toBe(0);
});

it("does not start a crop after adapter destruction while fetching its page", async () => {
  const pending = deferred<unknown>();
  const target = page(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  documentWith(() => pending.promise);
  const result = adapter.renderBlockImage(
    block.id,
    new AbortController().signal,
    600,
  );
  const settled = expect(result).rejects.toThrow();
  await adapter.destroy();
  pending.resolve(target);
  await settled;
  expect(target.render).not.toHaveBeenCalled();
});

it("cancels active crop tasks when the adapter is destroyed", async () => {
  const pending = deferred<void>();
  const cancel = vi.fn(() =>
    pending.reject(new DOMException("cancelled", "AbortError")),
  );
  documentWith(async () => page(() => ({ promise: pending.promise, cancel })));
  const result = adapter.renderBlockImage(
    block.id,
    new AbortController().signal,
    600,
  );
  const settled = expect(result).rejects.toThrow();
  await vi.waitFor(() =>
    expect(
      (adapter as unknown as { pdf: { getPage: unknown } }).pdf,
    ).toBeTruthy(),
  );
  await Promise.resolve();
  await adapter.destroy();
  try {
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    pending.reject(new DOMException("cleanup", "AbortError"));
    await settled;
  }
});

it("releases the canvas if PDF.js rejects rendering synchronously", async () => {
  let canvas!: HTMLCanvasElement;
  const target = page(() => {
    throw new Error("render unavailable");
  });
  target.render.mockImplementation((options: unknown) => {
    canvas = (options as { canvas: HTMLCanvasElement }).canvas;
    throw new Error("render unavailable");
  });
  documentWith(async () => target);
  await expect(
    adapter.renderBlockImage(block.id, new AbortController().signal, 600),
  ).rejects.toThrow("render unavailable");
  expect(canvas.width).toBe(0);
  expect(canvas.height).toBe(0);
});
