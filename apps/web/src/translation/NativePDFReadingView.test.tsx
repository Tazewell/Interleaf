// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  defaultTheme,
  type Document,
  type NativePDFReadingManifest,
  type NativePDFReadingEngine,
  type NativePDFReadingLayout,
  type ReaderAdapter,
  type ReaderEvents,
  type TranslationBlock,
} from "@interleaf/core";
const fixture = vi.hoisted(() => ({
  useRealJob: false,
  createNativePDFReading: vi.fn(),
  nativePDFReading: vi.fn(),
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
  translationLocation: vi.fn(() => ({ type: "pdf", page: 7, y: 0.65 })),
}));
vi.mock("./useNativePDFReading", async (load) => {
  const real = await load<typeof import("./useNativePDFReading")>();
  return {
    useNativePDFReading: vi.fn(
      (...args: Parameters<typeof real.useNativePDFReading>) =>
        fixture.useRealJob ? real.useNativePDFReading(...args) : fixture.state,
    ),
  };
});
vi.mock("@interleaf/api", () => ({
  api: {
    createNativePDFReading: fixture.createNativePDFReading,
    nativePDFReading: fixture.nativePDFReading,
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
          getLocation: translated
            ? fixture.translationLocation
            : fixture.getLocation,
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
      <div
        className="pdf-container"
        tabIndex={0}
        aria-label={props.nativeReading ? "译文阅读区" : "原文阅读区"}
      >
        <div className="pdfViewer" />
        {props.nativeReading ? "缓存的 PDF 译页" : "原始 PDF 页面"}
      </div>
    );
  },
}));
import { NativePDFReadingView } from "./NativePDFReadingView";
import { useNativePDFReading } from "./useNativePDFReading";
import { useTranslationSplit } from "./TranslationPanes";
let root: Root, host: HTMLDivElement, progressHost: HTMLDivElement;
const onFlow = vi.fn(),
  onReady = vi.fn(),
  onRegenerate = vi.fn(),
  onLocation = vi.fn();
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
  syncEnabled,
  engine,
}: {
  layout?: NativePDFReadingLayout;
  translations: TranslationBlock[];
  syncEnabled?: boolean;
  engine?: NativePDFReadingEngine;
}) {
  const split = useTranslationSplit();
  return (
    <NativePDFReadingView
      split={split}
      layout={layout}
      syncEnabled={syncEnabled}
      engine={engine}
      progressHost={progressHost}
      document={{ id: "doc", type: "pdf" } as Document}
      theme={defaultTheme}
      blocks={[]}
      translations={translations}
      annotations={[]}
      initialLocation={{ type: "pdf", page: 3 }}
      onReady={onReady}
      onRegenerate={onRegenerate}
      events={{ location: onLocation, selection: vi.fn() }}
      onUseFlow={onFlow}
      pageNavigation={<button>原文页码导航</button>}
    />
  );
}
async function render(
  layout?: NativePDFReadingLayout,
  translations: TranslationBlock[] = [],
  syncEnabled?: boolean,
  engine?: NativePDFReadingEngine,
) {
  await act(async () =>
    root.render(
      <Harness
        layout={layout}
        translations={translations}
        syncEnabled={syncEnabled}
        engine={engine}
      />,
    ),
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
  fixture.useRealJob = false;
  fixture.props = undefined;
  host = document.createElement("div");
  progressHost = document.createElement("div");
  document.body.append(host, progressHost);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  progressHost.remove();
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
it("routes page jumps to the focused native pane while sync is paused", async () => {
  fixture.state.job = { status: "ready", metadata };
  await render("side-by-side", [], false);
  const [reader] = onReady.mock.lastCall! as [ReaderAdapter];
  const translated = host.querySelector<HTMLElement>(
    '.pdf-container[aria-label="译文阅读区"]',
  );
  expect(translated?.tabIndex).toBe(0);
  translated!.focus();
  expect(document.activeElement).toBe(translated);
  fixture.goTo.mockClear();
  fixture.translationGoTo.mockClear();
  await reader.goTo({ type: "pdf", page: 8 });
  expect(fixture.translationGoTo).toHaveBeenCalledWith({
    type: "pdf",
    page: 8,
  });
  expect(fixture.goTo).not.toHaveBeenCalled();
});
it("reports the focused pane's page when switching between paused native panes", async () => {
  fixture.state.job = { status: "ready", metadata };
  fixture.translationLocation.mockReturnValueOnce({
    type: "pdf",
    page: 9,
    y: 0.2,
  });
  await render("side-by-side", [], false);
  const translated = host.querySelector<HTMLElement>(
    '.pdf-container[aria-label="译文阅读区"]',
  )!;
  await act(async () => translated.focus());
  expect(onLocation).toHaveBeenLastCalledWith(
    { type: "pdf", page: 9, y: 0.2 },
    1,
  );
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

it("does not mount a ready cache from the wrong engine", async () => {
  fixture.state.busy = false;
  fixture.state.job = { status: "ready", metadata };
  await render("translation-only", [], true, "babeldoc");
  expect(fixture.props).toBeUndefined();
  expect(host.textContent).toContain("缓存的译文与所选引擎不匹配");
});

it("keeps saved translation updates out of the BabelDOC request and reader descriptor", async () => {
  fixture.state.busy = false;
  fixture.state.job = {
    status: "ready",
    metadata: { ...metadata, cacheKey: "babeldoc", engine: "babeldoc" },
  };
  await render("translation-only", [], true, "babeldoc");
  expect(fixture.props?.nativeReading).toMatchObject({
    fileURL: "/cached/doc/babeldoc",
    translations: [],
  });
  const request = vi.mocked(useNativePDFReading).mock.lastCall;
  await render(
    "translation-only",
    [
      {
        blockId: "p7",
        sourceHash: "h",
        status: "complete",
        sentences: [{ source: "Later", target: "之后" }],
      },
    ],
    true,
    "babeldoc",
  );
  expect(vi.mocked(useNativePDFReading).mock.lastCall).toEqual(request);
  expect(request).toEqual([
    "doc",
    expect.any(String),
    "translation-only",
    "babeldoc",
  ]);
  expect(onRegenerate).not.toHaveBeenCalled();
});

it("shows the same honest progress in the reader and its toolbar", async () => {
  fixture.state.job = { status: "running", stage: "layout" };
  await render("side-by-side", [], true, "babeldoc");
  const bar = (container: HTMLElement) =>
    container.querySelector('[role="progressbar"]');
  expect(bar(host)).not.toBeNull();
  expect(bar(progressHost)).not.toBeNull();
  expect(bar(progressHost)?.closest('[aria-hidden="true"]')).not.toBeNull();
  expect(bar(host)?.closest('[aria-hidden="true"]')).toBeNull();
  expect(bar(host)?.hasAttribute("aria-valuenow")).toBe(false);
  expect(bar(progressHost)?.hasAttribute("aria-valuenow")).toBe(false);
  fixture.state.job = {
    status: "running",
    stage: "layout",
    progress: {
      phase: "translation",
      percent: 42,
      elapsedSeconds: 15,
      remainingSeconds: 21,
    },
  };
  await render("translation-only", [], true, "babeldoc");
  for (const container of [host, progressHost]) {
    expect(bar(container)?.getAttribute("aria-valuenow")).toBe("42");
    expect(container.textContent).toContain("正在翻译");
    expect(container.textContent).toContain("已用 15 秒");
    expect(container.textContent).toContain("预计剩余 21 秒");
  }
  fixture.state.job = { status: "failed", stage: "layout" };
  fixture.state.busy = false;
  fixture.state.error = "原版翻译失败";
  await render("translation-only", [], true, "babeldoc");
  expect(bar(host)).toBeNull();
  expect(bar(progressHost)).toBeNull();
  expect(progressHost.textContent).toContain("原版翻译失败");
});

it("keeps one subscription across both progress surfaces and translated tabs", async () => {
  fixture.useRealJob = true;
  vi.useFakeTimers();
  try {
    const running = {
      id: "job",
      status: "running",
      stage: "layout",
      done: 0,
      total: 0,
    };
    fixture.createNativePDFReading.mockResolvedValueOnce(running);
    fixture.nativePDFReading.mockResolvedValueOnce({
      ...running,
      progress: { phase: "typesetting", percent: 74, elapsedSeconds: 25 },
    });
    await render("side-by-side", [], true, "babeldoc");
    await act(async () => vi.advanceTimersByTimeAsync(750));
    await render("translation-only", [], true, "babeldoc");
    expect(fixture.createNativePDFReading).toHaveBeenCalledExactlyOnceWith(
      "doc",
      expect.any(AbortSignal),
      "translation-only",
      "babeldoc",
    );
    expect(fixture.nativePDFReading).toHaveBeenCalledTimes(1);
    for (const container of [host, progressHost]) {
      expect(
        container
          .querySelector('[role="progressbar"]')
          ?.getAttribute("aria-valuenow"),
      ).toBe("74");
    }
    let finish!: (value: unknown) => void;
    fixture.nativePDFReading.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(750));
    await act(async () => root.render(null));
    await act(async () => finish(running));
    expect(progressHost.children).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("discards a delayed comparison adapter after switching away and back", async () => {
  fixture.useRealJob = true;
  fixture.createNativePDFReading.mockResolvedValueOnce({
    status: "ready",
    metadata: { ...metadata, engine: "babeldoc" },
  });
  let finishOld!: () => void;
  let finishCurrent!: () => void;
  fixture.goTo.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishOld = resolve;
      }),
  );
  await render("side-by-side", [], true, "babeldoc");
  const oldEvents = fixture.props?.events as ReaderEvents;
  expect(finishOld).toBeTypeOf("function");
  expect(onReady).not.toHaveBeenCalled();

  await render("translation-only", [], true, "babeldoc");
  const oldSingleEvents = fixture.props?.events as ReaderEvents;
  expect(onReady).toHaveBeenCalledTimes(1);
  fixture.goTo.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishCurrent = resolve;
      }),
  );
  await render("side-by-side", [], true, "babeldoc");
  expect(finishCurrent).toBeTypeOf("function");
  const pageNavigation = () => host.querySelector(".pdf-page-navigation");
  expect(pageNavigation()).toBeNull();

  await act(async () => finishOld());
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(pageNavigation()).toBeNull();
  await act(async () => oldEvents.location({ type: "pdf", page: 9 }, 0.8));
  expect(onLocation).not.toHaveBeenCalled();

  await act(async () => finishCurrent());
  expect(onReady).toHaveBeenCalledTimes(2);
  expect(pageNavigation()).not.toBeNull();

  await render("translation-only", [], true, "babeldoc");
  await act(async () =>
    oldSingleEvents.location({ type: "pdf", page: 9 }, 0.8),
  );
  expect(onLocation).not.toHaveBeenCalled();
  const currentSingleEvents = fixture.props?.events as ReaderEvents;
  await act(async () =>
    currentSingleEvents.location({ type: "pdf", page: 10 }, 0.9),
  );
  expect(onLocation).toHaveBeenCalledExactlyOnceWith(
    { type: "pdf", page: 10 },
    0.9,
  );
  expect(fixture.createNativePDFReading).toHaveBeenCalledTimes(1);
});

it("offers to reconnect when polling fails during translation", async () => {
  fixture.useRealJob = true;
  vi.useFakeTimers();
  try {
    const running = {
      id: "job",
      status: "running",
      stage: "layout",
      done: 0,
      total: 0,
    };
    fixture.createNativePDFReading.mockResolvedValue(running);
    fixture.nativePDFReading.mockRejectedValueOnce(new Error("连接暂时中断"));
    await render("side-by-side", [], true, "babeldoc");
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(host.textContent).toContain("暂无法获取进度");
    expect(progressHost.textContent).toContain("暂无法获取进度");
    expect(progressHost.textContent).not.toContain("原版翻译失败");
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "重试",
    );
    await act(async () => retry!.click());
    expect(fixture.createNativePDFReading).toHaveBeenCalledTimes(2);
    expect(progressHost.querySelector('[role="progressbar"]')).not.toBeNull();
  } finally {
    fixture.createNativePDFReading.mockReset();
    vi.useRealTimers();
  }
});
