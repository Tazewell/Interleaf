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
  type Processing,
} from "@interleaf/core";
const fixture = vi.hoisted(() => ({
  nativeProps: undefined as Record<string, unknown> | undefined,
  holdSource: false,
  sourceFailed: undefined as (() => void) | undefined,
  sourceEvents: undefined as ReaderEvents | undefined,
  holdNative: false,
  source: {
    getLocation: () => ({ type: "pdf", page: 5 }),
    goTo: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    clearSelection: vi.fn(),
    focusSentences: vi.fn(),
    hoverBlock: vi.fn(),
    getTOC: async () => [],
    focusReference: vi.fn(async () => true),
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
    setAssistance: vi.fn(),
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
    onOpenError,
    events,
  }: {
    onReady: (adapter: ReaderAdapter, toc: []) => void;
    onOpenError?: () => void;
    events: ReaderEvents;
  }) => {
    fixture.sourceEvents = events;
    fixture.sourceFailed = onOpenError;
    useEffect(() => {
      if (!fixture.holdSource)
        onReady(fixture.source as unknown as ReaderAdapter, []);
    }, []);
    return <div data-source-reader>原文阅读器</div>;
  },
}));
vi.mock("./NativePDFReadingView", () => ({
  NativePDFReadingView: (props: Record<string, unknown>) => {
    fixture.nativeProps = props;
    useEffect(() => {
      if (fixture.holdNative) return;
      (props.onReady as (adapter: ReaderAdapter, toc: []) => void)(
        fixture.native as unknown as ReaderAdapter,
        [],
      );
    }, []);
    return <div data-native-reader>原版式阅读器</div>;
  },
}));
import { PDFReadingView } from "./PDFReadingView";
import { api } from "@interleaf/api";
import { choosePDFFormat, clickPDFContent } from "./pdf-reading-test-helpers";
let root: Root, host: HTMLDivElement;
let facade: ReaderAdapter;
async function render(
  id = "doc",
  blocks: PDFBlock[] = [],
  processing?: Processing,
  translationSetup?: Parameters<typeof PDFReadingView>[0]["translationSetup"],
) {
  await act(async () =>
    root.render(
      <PDFReadingView
        document={{ id, type: "pdf", library: "papers" } as Document}
        theme={defaultTheme}
        annotations={[]}
        blocks={blocks}
        processing={processing}
        translationSetup={translationSetup}
        events={{ location: vi.fn(), selection: vi.fn() }}
        onReady={(adapter) => {
          facade = adapter;
        }}
      />,
    ),
  );
}
async function click(label: string) {
  if (label === "流式对照") {
    await choosePDFFormat(host, "流式");
    label = "对照";
  } else if (label === "对照") await choosePDFFormat(host, "原版式");
  if (label === "原页") label = "原文";
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
  fixture.holdSource = false;
  fixture.sourceFailed = undefined;
  fixture.holdNative = false;
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
it("opens native 对照 and delegates its search and annotation preparation", async () => {
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
it("separates three reading contents from the layout choice", async () => {
  expect(
    [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
  ).toEqual(["原文", "对照", "译文"]);
  expect(host.querySelector('[aria-label="排版方式"]')?.textContent).toContain(
    "原版式",
  );
});
const untranslated: Processing = {
  documentId: "doc",
  phase: "translating",
  status: "paused",
  enabled: false,
  pagesDone: 4,
  pagesTotal: 4,
  translationsDone: 0,
  translationsTotal: 8,
  detail: "等待手动翻译",
  updatedAt: "2026-11-24T07:00:00Z",
};
it("offers to start a fresh paper in flow, and starts only after clicking", async () => {
  await render("doc", [], untranslated);
  expect(host.querySelector(".translation-prompt")).toBeNull();
  await clickPDFContent(host, "对照");
  const prompt = host.querySelector(".translation-prompt");
  expect(prompt?.textContent).toContain("这篇论文还没有译文");
  expect(prompt?.querySelector("button")?.textContent).toBe("开始翻译");
  expect(api.setAssistance).not.toHaveBeenCalled();
  vi.mocked(api.setAssistance).mockResolvedValueOnce({
    ...untranslated,
    enabled: true,
    status: "running",
    updatedAt: "2026-11-24T07:00:01Z",
  });
  await act(async () => prompt!.querySelector("button")!.click());
  expect(api.setAssistance).toHaveBeenCalledExactlyOnceWith("doc", "start");
  expect(host.querySelector(".translation-prompt")).toBeNull();
});
it("shows the remaining work in native comparison and reuses resume", async () => {
  await render("doc", [], {
    ...untranslated,
    startedAt: untranslated.updatedAt,
    translationsDone: 3,
  });
  await click("对照");
  expect(host.querySelector("[data-native-reader]")).not.toBeNull();
  const prompt = host.querySelector(".translation-prompt");
  expect(prompt?.textContent).toContain("已翻译 3 / 8 段");
  expect(prompt?.querySelector("button")?.textContent).toBe("继续翻译");
  await act(async () => prompt!.querySelector("button")!.click());
  expect(api.setAssistance).toHaveBeenCalledExactlyOnceWith("doc", "resume");
});
it("does not prompt for a finished paper whose whole-document job is paused", async () => {
  await render("doc", [], {
    ...untranslated,
    phase: "ready",
    translating: { status: "complete", detail: "翻译完成" },
    translationsDone: 8,
  });
  await clickPDFContent(host, "对照");
  expect(host.querySelector(".translation-prompt")).toBeNull();
});
it("opens AI setup from the comparison prompt when configuration is missing", async () => {
  const open = vi.fn();
  await render("doc", [], untranslated, { connectionRequired: true, open });
  await clickPDFContent(host, "对照");
  const button = host.querySelector<HTMLButtonElement>(
    ".translation-prompt button",
  );
  expect(button?.textContent).toBe("配置 AI 连接");
  await act(async () => button!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("connection", button);
  expect(api.setAssistance).not.toHaveBeenCalled();
});
it("offers model setup once an enabled translation waits for configuration", async () => {
  const open = vi.fn();
  await render("doc", [], untranslated, { connectionRequired: false, open });
  await clickPDFContent(host, "对照");
  expect(host.querySelector(".translation-prompt button")?.textContent).toBe(
    "开始翻译",
  );
  await render(
    "doc",
    [],
    {
      ...untranslated,
      enabled: true,
      status: "waiting",
      translating: {
        status: "waiting",
        detail: "请配置 API 翻译模型后继续翻译",
      },
    },
    { connectionRequired: false, open },
  );
  const setup = host.querySelector<HTMLButtonElement>(
    ".translation-prompt button",
  );
  expect(setup?.textContent).toBe("配置翻译模型");
  await act(async () => setup!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("models", setup);
});
it.each(["对照", "译文"] as const)(
  "opens %s in flow on the first visit without an explicit format selection",
  async (content) => {
    await clickPDFContent(host, content);
    expect(
      host.querySelector('[aria-label="排版方式"]')?.textContent,
    ).toContain("流式");
    expect(host.querySelector(".translation-document")).not.toBeNull();
    expect(host.querySelector("[data-native-reader]")).toBeNull();
  },
);
it("identifies native single-translation search results as translated text", async () => {
  await choosePDFFormat(host, "原版式");
  await click("译文");
  expect(await facade.search("译文")).toEqual([
    { id: "native-only", side: "translation" },
  ]);
});
it("shows the same sync switch only in comparisons and retains its setting across layouts", async () => {
  const sync = () =>
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "同步滚动",
    );
  expect(sync()).toBeUndefined();
  await click("对照");
  expect(sync()?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => sync()?.click());
  expect(fixture.nativeProps?.syncEnabled).toBe(false);
  await choosePDFFormat(host, "流式");
  expect(sync()?.getAttribute("aria-pressed")).toBe("false");
  await click("译文");
  expect(sync()).toBeUndefined();
});
it.each([
  { selection: undefined, expected: "流式" },
  { selection: "原版式", expected: "原版式" },
  { selection: "流式", expected: "流式" },
] as const)(
  "opens paragraph comparison in $expected with format selection $selection",
  async ({ selection, expected }) => {
    const block: PDFBlock = {
      id: "p3",
      page: 3,
      label: "text",
      text: "Selected paragraph.",
      bounds: { x: 0.15, y: 0.55, width: 0.7, height: 0.2 },
    };
    await render("doc", [block]);
    if (selection) await choosePDFFormat(host, selection);
    await act(async () =>
      fixture.sourceEvents!.blockAction!(block, "translate"),
    );
    const enter = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "进入双栏对照",
    );
    expect(enter).toBeDefined();
    await act(async () => enter!.click());
    expect(
      host.querySelector('[aria-label="排版方式"]')?.textContent,
    ).toContain(expected);
    expect(
      host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("对照");
    if (expected === "原版式")
      expect(fixture.nativeProps?.initialLocation).toEqual({
        type: "pdf",
        page: 3,
        x: 0.15,
        y: 0.55,
      });
    else expect(host.querySelector(".translation-document")).not.toBeNull();
  },
);
it("offers one native translated page and preserves the logical position across native layouts", async () => {
  await click("对照");
  fixture.native.getLocation.mockReturnValue({ type: "pdf", page: 8, y: 0.65 });
  await click("译文");
  expect(host.querySelector("[data-native-reader]")).not.toBeNull();
  expect(host.querySelector(".translation-document")).toBeNull();
  expect(fixture.nativeProps?.layout).toBe("translation-only");
  expect(fixture.nativeProps?.initialLocation).toMatchObject({
    type: "pdf",
    page: 8,
    y: 0.65,
  });
});
it("keeps the chosen content when switching between native and flowing layouts", async () => {
  await choosePDFFormat(host, "原版式");
  await click("译文");
  expect(fixture.nativeProps?.layout).toBe("translation-only");
  await choosePDFFormat(host, "流式");
  expect(host.querySelector(".translation-document")).not.toBeNull();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("译文");
  await choosePDFFormat(host, "原版式");
  expect(fixture.nativeProps?.layout).toBe("translation-only");
  await clickPDFContent(host, "原文");
  await clickPDFContent(host, "对照");
  expect(fixture.nativeProps?.layout).toBe("side-by-side");
});
it("returns to the original for an explicit source reference from a native single translation", async () => {
  await choosePDFFormat(host, "原版式");
  await click("译文");
  let pending: Promise<boolean> | undefined;
  const location = {
    type: "pdf" as const,
    page: 3,
    rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
  };
  await act(async () => {
    pending = facade.focusReference?.(location, "Original passage");
  });
  expect(await pending).toBe(true);
  expect(host.querySelector("[data-source-reader]")).not.toBeNull();
  expect(fixture.source.focusReference).toHaveBeenCalledWith(
    location,
    "Original passage",
  );
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("原文");
});
it("keeps a page jump in the translated PDF and opens source rectangles in the original", async () => {
  await choosePDFFormat(host, "原版式");
  await click("译文");
  await facade.goTo({ type: "pdf", page: 2 });
  expect(fixture.native.goTo).toHaveBeenCalledWith({ type: "pdf", page: 2 });
  const mark: PDFLocation = {
    type: "pdf",
    page: 4,
    rects: [{ x: 0.2, y: 0.5, width: 0.1, height: 0.05 }],
  };
  let jump: Promise<void> | undefined;
  await act(async () => {
    jump = facade.focusLocation?.(mark);
  });
  await jump;
  expect(fixture.source.goTo).toHaveBeenCalledWith(mark);
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("原文");
});
it("settles pending source navigation when the original fails to open or the document changes", async () => {
  await choosePDFFormat(host, "原版式");
  await click("译文");
  fixture.holdSource = true;
  let pending: Promise<boolean> | undefined;
  const page: PDFLocation = { type: "pdf", page: 3 };
  await act(async () => {
    pending = facade.focusReference?.(page, "original");
  });
  await act(async () => fixture.sourceFailed?.());
  expect(await pending).toBe(false);
  await click("译文");
  const old = facade;
  await act(async () => {
    pending = old.focusReference?.(page, "original");
  });
  await render("other");
  expect(await pending).toBe(false);
  expect(await old.focusReference?.(page, "stale")).toBe(false);
  expect(fixture.source.focusReference).not.toHaveBeenCalled();
});
it("preserves the last live page when switching through a native layout that is still generating", async () => {
  await click("对照");
  fixture.native.getLocation.mockReturnValue({ type: "pdf", page: 8, y: 0.6 });
  fixture.holdNative = true;
  await click("译文");
  fixture.native.getLocation.mockImplementation(() => {
    throw Error("disposed");
  });
  await click("对照");
  expect(fixture.nativeProps?.initialLocation).toMatchObject({
    type: "pdf",
    page: 8,
    y: 0.6,
  });
});
it("keeps the existing two-pane flow and standalone HTML translation available", async () => {
  await click("流式对照");
  expect(host.querySelector("[data-source-reader]")).not.toBeNull();
  expect(host.querySelector(".translation-document")).not.toBeNull();
  await click("译文");
  expect(host.querySelector(".translation-document")).not.toBeNull();
});
it("opens the native layout at the independent flow pane the reader last scrolled", async () => {
  await render("doc", [
    {
      id: "right7",
      page: 7,
      label: "text",
      text: "Right pane paragraph",
      bounds: { x: 0.1, y: 0.2, width: 0.8, height: 0.4 },
    },
  ]);
  await click("流式对照");
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="同步滚动"]')!.click(),
  );
  const pane = host.querySelector<HTMLElement>(".translation-document")!;
  vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 400),
  );
  const paragraph = pane.querySelector<HTMLElement>(
    '[data-translation-block="right7"]',
  )!;
  vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 100, 350, 200),
  );
  await act(async () => {
    pane.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    pane.dispatchEvent(new Event("scroll"));
    await new Promise(requestAnimationFrame);
  });
  await choosePDFFormat(host, "原版式");
  expect(fixture.nativeProps?.initialLocation).toMatchObject({
    type: "pdf",
    page: 7,
    y: 0.4,
  });
});
it("can change native layouts while the current one is regenerating without reading a disposed viewport", async () => {
  await choosePDFFormat(host, "原版式");
  await click("译文");
  const snapshot: PDFLocation = { type: "pdf", page: 8, y: 0.65 };
  await act(async () =>
    (
      fixture.nativeProps?.onRegenerate as
        ((location: PDFLocation) => void) | undefined
    )?.(snapshot),
  );
  fixture.native.getLocation.mockReturnValue({ type: "pdf", page: 1 });
  await click("对照");
  expect(fixture.nativeProps?.initialLocation).toEqual(snapshot);
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
  fixture.native.getLocation.mockReturnValue({
    type: "pdf",
    page: 7,
    x: 0.2,
    y: 0.4,
  });
  await act(async () =>
    (fixture.nativeProps?.events as ReaderEvents).location(
      { type: "pdf", page: 7, x: 0.2, y: 0.4 },
      0.5,
    ),
  );
  await choosePDFFormat(host, "流式");
  await click("译文");
  expect(facade.getLocation()).toMatchObject({ type: "pdf", page: 7 });
});
it("snapshots the live native viewport on exit after scrolling within the same page", async () => {
  await click("对照");
  await act(async () =>
    (fixture.nativeProps?.events as ReaderEvents).location(
      { type: "pdf", page: 7 },
      0.5,
    ),
  );
  // PDF.js pagechanging does not emit again while scrolling within page 7.
  fixture.native.getLocation.mockReturnValue({
    type: "pdf",
    page: 7,
    x: 0.2,
    y: 0.65,
  });
  await click("原页");
  expect(fixture.source.goTo).toHaveBeenCalledWith({
    type: "pdf",
    page: 7,
    x: 0.2,
    y: 0.65,
  });
});
