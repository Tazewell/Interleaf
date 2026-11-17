// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Document,
  type ReaderAdapter,
  type ReaderEvents,
  type PDFBlock,
  type PDFLocation,
} from "@interleaf/core";
const fixture = vi.hoisted(() => ({
  nativeProps: undefined as Record<string, unknown> | undefined,
  source: {
    getLocation: () => ({ type: "pdf", page: 5 }),
    goTo: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    clearSelection: vi.fn(),
    focusSentences: vi.fn(),
    hoverBlock: vi.fn(),
    getTOC: async () => [],
  },
  native: {
    getLocation: vi.fn<() => PDFLocation>(() => ({ type: "pdf", page: 5 })),
    goTo: vi.fn(async () => {}),
    search: vi.fn(async () => [{ id: "native-only" }]),
    prepareAnnotation: vi.fn(async (value: unknown) => value),
    clearSelection: vi.fn(),
    hoverBlock: vi.fn(),
  },
}));
vi.mock("@interleaf/api", () => ({
  api: {
    assistance: vi.fn(async () => undefined),
    translationStream: vi.fn(async () => {}),
  },
  blockImageURL: () => "",
}));
vi.mock("./useTranslations", () => ({
  useTranslations: () => ({ translations: [], error: "" }),
}));
vi.mock("../InterleafView", () => ({
  InterleafView: ({
    onReady,
  }: {
    onReady: (adapter: ReaderAdapter, toc: []) => void;
  }) => {
    useEffect(
      () => onReady(fixture.source as unknown as ReaderAdapter, []),
      [],
    );
    return <div data-source-reader>原文阅读器</div>;
  },
}));
vi.mock("./NativePDFReadingView", () => ({
  NativePDFReadingView: (props: Record<string, unknown>) => {
    fixture.nativeProps = props;
    useEffect(() => {
      (props.onReady as (adapter: ReaderAdapter, toc: []) => void)(
        fixture.native as unknown as ReaderAdapter,
        [],
      );
    }, []);
    return <div data-native-reader>原版式阅读器</div>;
  },
}));
import { PDFReadingView } from "./PDFReadingView";
let root: Root, host: HTMLDivElement;
let facade: ReaderAdapter;
async function render(id = "doc", blocks: PDFBlock[] = []) {
  await act(async () =>
    root.render(
      <PDFReadingView
        document={{ id, type: "pdf" } as Document}
        theme={defaultTheme}
        annotations={[]}
        blocks={blocks}
        events={{ location: vi.fn(), selection: vi.fn() }}
        onReady={(adapter) => {
          facade = adapter;
        }}
      />,
    ),
  );
}
async function click(label: string) {
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click(),
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.clearAllMocks();
  fixture.native.getLocation.mockReturnValue({ type: "pdf", page: 5 });
  fixture.nativeProps = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("uses one derived PDF reader for 对照 and delegates native search and annotation preparation", async () => {
  await click("对照");
  expect(host.querySelector("[data-native-reader]")).not.toBeNull();
  expect(host.querySelector("[data-source-reader]")).toBeNull();
  expect(host.querySelector(".translation-document")).toBeNull();
  expect(fixture.nativeProps?.initialLocation).toMatchObject({
    type: "pdf",
    page: 5,
  });
  await facade.search("中文");
  expect(fixture.native.search).toHaveBeenCalledWith("中文");
  expect(facade.prepareAnnotation).toBe(fixture.native.prepareAnnotation);
});
it("keeps the existing two-pane flow and standalone HTML translation available", async () => {
  await click("流式对照");
  expect(host.querySelector("[data-source-reader]")).not.toBeNull();
  expect(host.querySelector(".translation-document")).not.toBeNull();
  await click("译文");
  expect(host.querySelector(".translation-document")).not.toBeNull();
});
it("returns from the derived reader at the original logical page", async () => {
  await click("对照");
  fixture.native.getLocation.mockReturnValue({ type: "pdf", page: 7, y: 0.4 });
  await act(async () =>
    (fixture.nativeProps?.events as ReaderEvents).location(
      { type: "pdf", page: 7, y: 0.4 },
      0.5,
    ),
  );
  await click("原页");
  expect(fixture.source.goTo).toHaveBeenCalledWith({
    type: "pdf",
    page: 7,
    y: 0.4,
  });
});
it("returns to the HTML translation at the current native paragraph", async () => {
  await render("doc", [
    {
      id: "p7-b1",
      page: 7,
      label: "text",
      text: "Current paragraph.",
      bounds: { x: 0.1, y: 0.2, width: 0.7, height: 0.4 },
    },
  ]);
  await click("对照");
  fixture.native.getLocation.mockReturnValue({ type: "pdf", page: 7, x: 0.2, y: 0.4 });
  await act(async () =>
    (fixture.nativeProps?.events as ReaderEvents).location(
      { type: "pdf", page: 7, x: 0.2, y: 0.4 },
      0.5,
    ),
  );
  await click("译文");
  expect(facade.getLocation()).toMatchObject({ type: "pdf", page: 7 });
});
it("snapshots the live native viewport on exit after scrolling within the same page", async () => {
  await click("对照");
  await act(async () =>
    (fixture.nativeProps?.events as ReaderEvents).location(
      { type: "pdf", page: 7 }, 0.5,
    ),
  );
  // PDF.js pagechanging does not emit again while scrolling within page 7.
  fixture.native.getLocation.mockReturnValue({ type: "pdf", page: 7, x: 0.2, y: 0.65 });
  await click("原页");
  expect(fixture.source.goTo).toHaveBeenCalledWith({ type: "pdf", page: 7, x: 0.2, y: 0.65 });
});
