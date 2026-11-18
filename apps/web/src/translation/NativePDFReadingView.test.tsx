// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  defaultTheme,
  type Document,
  type NativePDFReadingManifest,
  type NativePDFReadingLayout,
  type ReaderAdapter,
  type TranslationBlock,
} from "@interleaf/core";
const fixture = vi.hoisted(() => ({
  state: {
    busy: true,
    cancelling: false,
    error: "",
    job: undefined as unknown,
    retry: vi.fn(),
    cancel: vi.fn(),
  },
  props: undefined as Record<string, unknown> | undefined,
  goTo: vi.fn(async () => {}),
  translationGoTo: vi.fn(async () => {}),
  getLocation: vi.fn(() => ({ type: "pdf", page: 7, y: 0.65 })),
}));
vi.mock("./useNativePDFReading", () => ({
  useNativePDFReading: () => fixture.state,
}));
vi.mock("@interleaf/api", () => ({
  api: {
    nativePDFReadingFileURL: (id: string, key: string) =>
      `/cached/${id}/${key}`,
  },
}));
vi.mock("../InterleafView", () => ({
  InterleafView: (props: Record<string, unknown>) => {
    fixture.props = props;
    useEffect(() => {
      const translated = !!props.nativeReading;
      (props.onReady as (adapter: ReaderAdapter, toc: []) => void)(
        {
          goTo:
            translated &&
            (props.nativeReading as { alongsideOriginal?: boolean })
              .alongsideOriginal
              ? fixture.translationGoTo
              : fixture.goTo,
          getLocation: fixture.getLocation,
          search: async (query: string) => [
            {
              id: "7",
              excerpt: query,
              location: { type: "pdf", page: 7, quote: query },
            },
          ],
          getContext: async (at?: { page: number }) =>
            (translated ? "译文" : "原文") + (at?.page ?? 3),
          clearSelection() {},
        } as unknown as ReaderAdapter,
        [],
      );
    }, []);
    return (
      <div className="pdf-container">
        <div className="pdfViewer" />
        {props.nativeReading ? "缓存的 PDF 译页" : "原始 PDF 页面"}
      </div>
    );
  },
}));
import { NativePDFReadingView } from "./NativePDFReadingView";
import { useTranslationSplit } from "./TranslationPanes";
let root: Root, host: HTMLDivElement;
const onFlow = vi.fn(),
  onReady = vi.fn(),
  onRegenerate = vi.fn();
const metadata = {
  version: 1,
  layout: "translation-only",
  documentId: "doc",
  cacheKey: "key",
  pages: [],
  translatedParagraphs: 3,
  originalParagraphs: 2,
  warnings: [],
} as unknown as NativePDFReadingManifest;
function Harness({
  layout,
  translations,
}: {
  layout?: NativePDFReadingLayout;
  translations: TranslationBlock[];
}) {
  const split = useTranslationSplit();
  return (
    <NativePDFReadingView
      split={split}
      layout={layout}
      document={{ id: "doc", type: "pdf" } as Document}
      theme={defaultTheme}
      blocks={[]}
      translations={translations}
      annotations={[]}
      initialLocation={{ type: "pdf", page: 3 }}
      onReady={onReady}
      onRegenerate={onRegenerate}
      events={{ location: vi.fn(), selection: vi.fn() }}
      onUseFlow={onFlow}
      pageNavigation={<button>原文页码导航</button>}
    />
  );
}
async function render(
  layout?: NativePDFReadingLayout,
  translations: TranslationBlock[] = [],
) {
  await act(async () =>
    root.render(<Harness layout={layout} translations={translations} />),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.clearAllMocks();
  fixture.state = {
    busy: true,
    cancelling: false,
    error: "",
    job: undefined,
    retry: vi.fn(),
    cancel: vi.fn(),
  };
  fixture.props = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("shows generation state without mounting another reader", async () => {
  await render();
  expect(host.textContent).toContain("正在生成原版式对照");
  expect(fixture.props).toBeUndefined();
});
it("gives the two native pages a real separator and swaps the live panes without reopening them", async () => {
  fixture.state.job = {
    status: "ready",
    metadata: { ...metadata, layout: "translation-only" },
  };
  await render("side-by-side");
  const divider = host.querySelector(
    '[role="separator"][aria-label="调整原文和译文宽度"]',
  );
  expect(divider).not.toBeNull();
  const panes = () => [...host.querySelectorAll("[data-panel]")];
  const [source, translation] = panes();
  expect(source.textContent).toContain("原始 PDF 页面");
  expect(translation.textContent).toContain("缓存的 PDF 译页");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="交换原文和译文"]')!
      .click(),
  );
  expect(panes()[0]).toBe(translation);
  expect(panes()[1]).toBe(source);
  expect(onReady).toHaveBeenCalledTimes(1);
});
it("opens a shared search term on its selected side and quotes the original of the active page", async () => {
  fixture.state.job = { status: "ready", metadata };
  await render("side-by-side");
  const [reader] = onReady.mock.lastCall! as [ReaderAdapter];
  const results = await reader.search("2026");
  expect(results.map((r) => r.side)).toEqual(["source", "translation"]);
  expect(results[0].id).not.toBe(results[1].id);
  fixture.goTo.mockClear();
  await reader.focusLocation!(results[1].location, results[1].side);
  expect(fixture.translationGoTo).toHaveBeenCalledWith(results[1].location);
  expect(fixture.goTo).not.toHaveBeenCalled();
  expect(await reader.getContext()).toBe("原文7");
});
it("loads the original document identity with cached geometry and restores its page", async () => {
  fixture.state = {
    ...fixture.state,
    busy: false,
    job: { status: "ready", metadata },
  };
  await render();
  expect(host.textContent).toContain("缓存的 PDF 译页");
  expect(host.textContent).toContain("原始 PDF 页面");
  expect(host.textContent).toContain("2 段保留原文");
  expect(fixture.props?.document).toMatchObject({ id: "doc" });
  expect(fixture.props?.nativeReading).toMatchObject({
    metadata,
    fileURL: "/cached/doc/key",
  });
  expect(fixture.goTo).toHaveBeenCalledWith({ type: "pdf", page: 3 });
  expect(onReady).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("原文页码导航");
});
it("offers retry and a working flow fallback after failure", async () => {
  fixture.state = { ...fixture.state, busy: false, error: "版面尚未解析完成" };
  await render();
  expect(host.textContent).toContain("版面尚未解析完成");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "重试")!
      .click(),
  );
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "使用流式对照")!
      .click(),
  );
  expect(fixture.state.retry).toHaveBeenCalledOnce();
  expect(onFlow).toHaveBeenCalledOnce();
});
it("captures the live viewport before a translation revision replaces the file and restores that point", async () => {
  const single = { ...metadata, cacheKey: "old", layout: "translation-only" };
  fixture.state.job = { status: "ready", metadata: single };
  await render("translation-only");
  const translations: TranslationBlock[] = [
    {
      blockId: "p7",
      sourceHash: "h",
      status: "complete",
      sentences: [{ source: "Later", target: "之后" }],
    },
  ];
  await render("translation-only", translations);
  expect(onRegenerate).toHaveBeenCalledWith({ type: "pdf", page: 7, y: 0.65 });
  fixture.state.job = undefined;
  await render("translation-only", translations);
  fixture.state.job = {
    status: "ready",
    metadata: { ...single, cacheKey: "updated" },
  };
  await render("translation-only", translations);
  expect(fixture.goTo).toHaveBeenLastCalledWith({
    type: "pdf",
    page: 7,
    y: 0.65,
  });
});
it("keeps the current viewer when a queued block starts translating", async () => {
  const running: TranslationBlock = {
    blockId: "p7",
    sourceHash: "h",
    status: "pending",
    sentences: [],
  };
  fixture.state.job = { status: "ready", metadata };
  await render("side-by-side", [running]);
  await render("side-by-side", [{ ...running, status: "running" }]);
  expect(onRegenerate).not.toHaveBeenCalled();
  expect(onReady).toHaveBeenCalledOnce();
});
it("waits for the matching single-column artifact and offers a single-column flow fallback", async () => {
  fixture.state.job = {
    status: "ready",
    metadata: { ...metadata, layout: "side-by-side" },
  };
  await render("translation-only");
  expect(fixture.props).toBeUndefined();
  expect(host.textContent).toContain("使用流式译文");
  const single = {
    ...metadata,
    cacheKey: "single",
    layout: "translation-only",
  };
  fixture.state.job = { status: "ready", metadata: single };
  await render("translation-only");
  expect(fixture.props?.nativeReading).toMatchObject({
    metadata: single,
    fileURL: "/cached/doc/single",
  });
  expect(host.textContent).toContain("可在流式译文中查看译文");
  expect(host.querySelector('[aria-label="原版式译文"]')).not.toBeNull();
  expect(host.querySelector('[role="separator"]')).toBeNull();
});
