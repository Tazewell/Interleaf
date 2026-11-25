// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Document,
  type NativePDFReadingJob,
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
    findNativePDFReading: vi.fn(async () => null),
    createNativePDFReading: vi.fn(),
    nativePDFReading: vi.fn(),
    cancelNativePDFReading: vi.fn(),
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
    }, [props.layout]);
    return <div data-native-reader>原版式阅读器</div>;
  },
}));
import { PDFReadingView } from "./PDFReadingView";
import { api } from "@interleaf/api";
import { choosePDFFormat, clickPDFContent } from "./pdf-reading-test-helpers";
let root: Root, host: HTMLDivElement;
let facade: ReaderAdapter;
let sequence = 0;
let cachedId: string;
let freshId: string;
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
const completedFlow: Processing = {
  ...untranslated,
  phase: "ready",
  status: "complete",
  enabled: true,
  translationsDone: 8,
};
function readyOriginal(documentId: string): NativePDFReadingJob {
  return {
    id: "original-job",
    cacheKey: "original-cache",
    status: "ready",
    stage: "ready",
    done: 1,
    total: 1,
    metadata: {
      version: 1,
      engine: "babeldoc",
      layout: "translation-only",
      documentId,
      cacheKey: "original-cache",
      originalSha256: "source",
      layoutRevision: "layout",
      translationRevision: "translation",
      rendererVersion: "engine",
      pdfSha256: "pdf",
      pdfBytes: 100,
      pages: [],
      translatedParagraphs: 0,
      originalParagraphs: 0,
      warnings: [],
    },
  };
}
async function render(
  id = cachedId,
  blocks: PDFBlock[] = [],
  processing = completedFlow,
  translationSetup?: Parameters<typeof PDFReadingView>[0]["translationSetup"],
) {
  await act(async () =>
    root.render(
      <PDFReadingView
        document={{ id, type: "pdf", library: "papers" } as Document}
        theme={defaultTheme}
        annotations={[]}
        blocks={blocks}
        processing={{ ...processing, documentId: id }}
        translationSetup={translationSetup}
        events={{ location: vi.fn(), selection: vi.fn() }}
        onReady={(adapter) => {
          facade = adapter;
        }}
      />,
    ),
  );
}
function findButton(label: string | RegExp, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => {
      const text =
        button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof label === "string"
        ? text.trim() === label
        : label.test(text);
    },
  );
}
async function openTasks() {
  const trigger = findButton(/^翻译任务/, host);
  expect(trigger).toBeDefined();
  if (trigger?.getAttribute("aria-expanded") !== "true")
    await act(async () => trigger?.click());
  return document.querySelector(".pdf-translation-task-list")!;
}
const flowProgress = () =>
  document.querySelector(
    '[role="progressbar"][aria-label="翻译进度"], [role="progressbar"][aria-label="正在准备翻译"], [role="progressbar"][aria-label="等待翻译"]',
  );
async function click(label: "原页" | "流式对照" | "对照" | "译文") {
  await clickPDFContent(
    host,
    label === "原页" ? "原文" : label === "译文" ? "译文" : "对照",
  );
  if (label === "对照") await choosePDFFormat(host, "原版翻译排版");
  if (label === "流式对照") await choosePDFFormat(host, "流式翻译排版");
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
  sequence += 1;
  cachedId = `cached-${sequence}`;
  freshId = `fresh-${sequence}`;
  vi.mocked(api.findNativePDFReading).mockImplementation(async (id) =>
    id === cachedId ? readyOriginal(id) : null,
  );
  vi.mocked(api.createNativePDFReading).mockImplementation(async (id) =>
    readyOriginal(id),
  );
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
it("opens the original PDF with three content tabs and no layout choice", () => {
  expect(
    [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
  ).toEqual(["原文", "对照", "译文"]);
  expect(host.querySelector('[aria-label="排版方式"]')).toBeNull();
  expect(host.querySelector("[data-source-reader]")).not.toBeNull();
});
it("keeps the existing flow retranslation confirmation available from translation tasks", async () => {
  const tasks = await openTasks();
  const restart = findButton("重新翻译", tasks);
  expect(restart).toBeDefined();
  await act(async () => restart?.click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "重新翻译全文？",
  );
  expect(api.setAssistance).not.toHaveBeenCalled();
});
it.each(["对照", "译文"] as const)(
  "offers exactly the two translation layouts in %s",
  async (content) => {
    await clickPDFContent(host, content);
    const trigger = host.querySelector<HTMLButtonElement>(
      '[aria-label="排版方式"]',
    )!;
    expect(trigger.textContent).toContain("流式翻译排版");
    await act(async () => trigger.click());
    expect(
      [...document.querySelectorAll('[role="option"]')].map(
        (n) => n.textContent,
      ),
    ).toEqual(["原版翻译排版", "流式翻译排版"]);
  },
);
it("offers to start a fresh paper in flow, and starts only after clicking", async () => {
  await render(freshId, [], {
    ...untranslated,
    manualTranslation: true,
    translating: { status: "paused", detail: "等待手动翻译" },
  });
  expect(host.querySelector(".pdf-translation-chooser")).toBeNull();
  await clickPDFContent(host, "对照");
  const prompt = host.querySelector(".pdf-translation-chooser")!;
  expect(prompt?.textContent).toContain("这篇论文还没有译文");
  const flow = findButton(/^开始流式翻译/, prompt);
  expect(flow).toBeDefined();
  expect(prompt.closest('[aria-label="译文阅读区"]')).not.toBeNull();
  expect(api.setAssistance).not.toHaveBeenCalled();
  expect(api.createNativePDFReading).not.toHaveBeenCalled();
  vi.mocked(api.setAssistance).mockResolvedValueOnce({
    ...untranslated,
    documentId: freshId,
    enabled: true,
    status: "running",
    translationOrigin: "manual",
    updatedAt: "2026-11-24T07:00:01Z",
  });
  await act(async () => flow?.click());
  expect(api.setAssistance).toHaveBeenCalledExactlyOnceWith(
    freshId,
    "start-flow",
  );
  expect(host.querySelector(".pdf-translation-chooser")).toBeNull();
});
it("starts an original-layout translation only after confirmation", async () => {
  await render(freshId, [], untranslated);
  await clickPDFContent(host, "对照");
  const original = findButton(/^生成原版译文/, host);
  expect(original).toBeDefined();
  await act(async () => original?.click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "可能需要等几分钟",
  );
  expect(api.createNativePDFReading).not.toHaveBeenCalled();
  await act(async () => findButton("暂不生成")?.click());
  expect(api.createNativePDFReading).not.toHaveBeenCalled();
  await act(async () => original?.click());
  await act(async () => findButton("开始生成")?.click());
  expect(api.createNativePDFReading).toHaveBeenCalledExactlyOnceWith(
    freshId,
    expect.any(AbortSignal),
    "translation-only",
    "babeldoc",
  );
  expect(api.setAssistance).not.toHaveBeenCalled();
  expect(host.querySelector("[data-native-reader]")).not.toBeNull();
});
it("requests flow start while mandatory parsing is still running", async () => {
  const parsing: Processing = {
    ...untranslated,
    phase: "learning",
    status: "running",
    enabled: true,
    manualTranslation: undefined,
    translating: undefined,
    startedAt: "2026-11-24T07:00:00Z",
  };
  await render(freshId, [], parsing);
  vi.mocked(api.setAssistance).mockResolvedValueOnce({
    ...parsing,
    documentId: freshId,
    translationOrigin: "manual",
    updatedAt: "2026-11-24T07:00:01Z",
  });
  await clickPDFContent(host, "对照");
  const flow = findButton(/^开始流式翻译/, host);
  expect(flow).toBeDefined();
  await act(async () => flow?.click());
  expect(api.setAssistance).toHaveBeenCalledExactlyOnceWith(
    freshId,
    "start-flow",
  );
  expect(host.querySelector(".pdf-translation-chooser")).toBeNull();
});
it("returns to the initial choices after cancelling original generation from the source view", async () => {
  await render(freshId, [], untranslated);
  vi.mocked(api.createNativePDFReading).mockResolvedValueOnce({
    ...readyOriginal(freshId),
    metadata: undefined,
    status: "preparing",
    stage: "prepare",
  });
  await clickPDFContent(host, "对照");
  await act(async () => findButton(/^生成原版译文/, host)?.click());
  await act(async () => findButton("开始生成")?.click());
  await clickPDFContent(host, "原文");
  const tasks = await openTasks();
  const cancel = findButton("取消生成", tasks);
  expect(cancel).toBeDefined();
  await act(async () => cancel?.click());
  await clickPDFContent(host, "对照");
  expect(host.querySelector(".pdf-translation-chooser")).not.toBeNull();
  expect(api.cancelNativePDFReading).toHaveBeenCalledWith(freshId, "original-job");
});
it("keeps flow visible while original translation completes in the background", async () => {
  await render(freshId, [], completedFlow);
  const ready = readyOriginal(freshId);
  vi.mocked(api.createNativePDFReading).mockResolvedValueOnce({
    ...ready,
    metadata: undefined,
    status: "running",
    stage: "layout",
    done: 0,
    progress: { percent: 42, elapsedSeconds: 5 },
  });
  vi.mocked(api.nativePDFReading).mockResolvedValueOnce(ready);
  await clickPDFContent(host, "对照");
  const flowPane = host.querySelector(".translation-document");
  await choosePDFFormat(host, "原版翻译排版");
  expect(api.createNativePDFReading).not.toHaveBeenCalled();
  await act(async () => findButton("开始生成")?.click());
  expect(api.createNativePDFReading).toHaveBeenCalledOnce();
  expect(api.setAssistance).not.toHaveBeenCalled();
  expect(host.querySelector(".translation-document")).toBe(flowPane);
  expect(host.querySelector("[data-source-reader]")).not.toBeNull();
  expect(host.querySelector("[data-native-reader]")).toBeNull();

  await act(async () =>
    vi.waitFor(() => expect(api.nativePDFReading).toHaveBeenCalledOnce()),
  );
  expect(host.querySelector(".translation-document")).toBe(flowPane);
  expect(host.querySelector("[data-native-reader]")).toBeNull();
  const taskList = await openTasks();
  const view = findButton("查看原版译文", taskList);
  expect(view).toBeDefined();
  await act(async () => view?.click());
  expect(host.querySelector("[data-native-reader]")).not.toBeNull();
  expect(api.createNativePDFReading).toHaveBeenCalledOnce();
});
it("reuses resume for a partially translated paper", async () => {
  await render(freshId, [], {
    ...untranslated,
    startedAt: untranslated.updatedAt,
    translationsDone: 3,
  });
  await click("流式对照");
  expect(host.querySelector("[data-native-reader]")).toBeNull();
  expect(host.querySelector(".pdf-translation-chooser")).toBeNull();
  const resume = findButton("继续翻译", host);
  expect(resume).toBeDefined();
  await act(async () => resume?.click());
  expect(api.setAssistance).toHaveBeenCalledExactlyOnceWith(freshId, "resume");
});
it("shows manual flow progress in the task list and hides it on pause", async () => {
  const running: Processing = {
    ...untranslated,
    enabled: true,
    translationOrigin: "manual",
    status: "running",
    translationsDone: 3,
    updatedAt: "2026-11-24T07:00:03Z",
  };
  await render(freshId, [], untranslated);
  await clickPDFContent(host, "对照");
  expect(flowProgress()).toBeNull();
  vi.mocked(api.setAssistance).mockResolvedValueOnce({
    ...running,
    documentId: freshId,
    phase: "learning",
    status: "queued",
    translationsDone: 0,
    updatedAt: "2026-11-24T07:00:01Z",
  });
  const flow = findButton(/^开始流式翻译/, host);
  expect(flow).toBeDefined();
  await act(async () => flow?.click());
  expect(api.setAssistance).toHaveBeenLastCalledWith(freshId, "start-flow");
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  const list = await openTasks();
  expect(flowProgress()).not.toBeNull();
  expect(flowProgress()?.hasAttribute("aria-valuenow")).toBe(false);
  await render(freshId, [], running);
  expect(flowProgress()?.getAttribute("aria-valuenow")).toBe("37.5");
  const pause = findButton("暂停翻译", list);
  expect(pause?.title).toBe("暂停翻译");
  vi.mocked(api.setAssistance).mockResolvedValueOnce({
    ...running,
    documentId: freshId,
    enabled: false,
    status: "paused",
    startedAt: running.updatedAt,
    updatedAt: "2026-11-24T07:00:04Z",
  });
  await act(async () => pause!.click());
  expect(api.setAssistance).toHaveBeenLastCalledWith(freshId, "pause");
  expect(flowProgress()).toBeNull();
  expect(findButton("继续翻译", host)).toBeDefined();
});

it("shows persisted manual translation after closing and reopening without starting another job", async () => {
  const running: Processing = {
    ...untranslated,
    enabled: true,
    translationOrigin: "manual",
    status: "running",
    translationsDone: 3,
  };
  await render(cachedId, [], running);
  await clickPDFContent(host, "对照");
  await openTasks();
  expect(flowProgress()?.getAttribute("aria-valuenow")).toBe("37.5");

  await act(async () => root.render(null));
  vi.mocked(api.assistance).mockResolvedValueOnce({
    ...running,
    documentId: cachedId,
  });
  await render(cachedId, [], running);
  const group = await openTasks();
  expect(group.contains(flowProgress())).toBe(true);
  expect(findButton("暂停翻译", group)).toBeDefined();
  expect(flowProgress()?.getAttribute("aria-valuenow")).toBe("37.5");
  expect(api.setAssistance).not.toHaveBeenCalled();

  await act(async () => findButton("关闭翻译任务", group)?.click());
  await clickPDFContent(host, "对照");
  await choosePDFFormat(host, "原版翻译排版");
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  await openTasks();
  expect(flowProgress()?.getAttribute("aria-valuenow")).toBe("37.5");
  expect(api.setAssistance).not.toHaveBeenCalled();
});

it("omits progress for automatic work and paused or completed manual translation", async () => {
  const running: Processing = {
    ...untranslated,
    enabled: true,
    translationOrigin: "automatic",
    status: "running",
    translationsDone: 3,
  };
  await render(cachedId, [], running);
  await clickPDFContent(host, "对照");
  await openTasks();
  expect(flowProgress()).toBeNull();

  await render(cachedId, [], {
    ...running,
    translationOrigin: "manual",
    enabled: false,
    status: "paused",
  });
  expect(flowProgress()).toBeNull();
  await render(cachedId, [], {
    ...running,
    translationOrigin: "manual",
    phase: "ready",
    status: "complete",
    translationsDone: 8,
  });
  expect(flowProgress()).toBeNull();
  expect(api.setAssistance).not.toHaveBeenCalled();
});

it("keeps the progress bar below 100 until the manual job finishes", async () => {
  const finishing: Processing = {
    ...untranslated,
    enabled: true,
    translationOrigin: "manual",
    status: "running",
    translationsDone: 8,
  };
  await render(cachedId, [], finishing);
  await openTasks();
  expect(flowProgress()?.getAttribute("aria-valuenow")).toBe("99");
  await render(cachedId, [], {
    ...finishing,
    status: "complete",
    phase: "ready",
  });
  expect(flowProgress()).toBeNull();
});

it("uses actual legacy translation activity without counting initial parsing as translation", async () => {
  const legacy: Processing = {
    ...untranslated,
    enabled: true,
    phase: "learning",
    status: "running",
    translationsDone: 3,
  };
  await render(cachedId, [], legacy);
  await openTasks();
  expect(flowProgress()).toBeNull();

  await render(cachedId, [], {
    ...legacy,
    phase: "translating",
    status: "queued",
  });
  expect(flowProgress()).not.toBeNull();
  expect(flowProgress()?.hasAttribute("aria-valuenow")).toBe(false);
  await render(cachedId, [], {
    ...legacy,
    translating: { status: "running", detail: "正在翻译" },
  });
  expect(flowProgress()?.getAttribute("aria-valuenow")).toBe("37.5");
  expect(api.setAssistance).not.toHaveBeenCalled();
});

it("keeps completed flow controls in the task list when opening cached original pages", async () => {
  await clickPDFContent(host, "对照");
  await choosePDFFormat(host, "原版翻译排版");
  expect(host.querySelector(".assistance-controls")).toBeNull();
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  expect(host.querySelector("[data-native-reader]")).not.toBeNull();
  const list = await openTasks();
  expect(list.textContent).toContain("翻译完成");
  expect(api.createNativePDFReading).not.toHaveBeenCalled();
});

it("does not prompt for a finished paper whose whole-document job is paused", async () => {
  await render(freshId, [], {
    ...untranslated,
    phase: "ready",
    translating: { status: "complete", detail: "翻译完成" },
    translationsDone: 8,
  });
  await clickPDFContent(host, "对照");
  expect(host.querySelector(".pdf-translation-chooser")).toBeNull();
});
it("opens AI setup from the comparison prompt when configuration is missing", async () => {
  const open = vi.fn();
  await render(freshId, [], untranslated, { connectionRequired: true, open });
  await clickPDFContent(host, "对照");
  const button = findButton(/^配置 AI 连接/, host);
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("connection", button);
  expect(api.setAssistance).not.toHaveBeenCalled();
});
it("offers model setup once an enabled translation waits for configuration", async () => {
  const open = vi.fn();
  await render(
    freshId,
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
  await clickPDFContent(host, "对照");
  await openTasks();
  const setup = findButton("配置翻译模型");
  expect(setup).toBeDefined();
  await act(async () => setup!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("models", setup);
});
it.each(["对照", "译文"] as const)(
  "opens %s in flow when its translation is available",
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
  await click("译文");
  await choosePDFFormat(host, "原版翻译排版");
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
  await choosePDFFormat(host, "流式翻译排版");
  expect(sync()?.getAttribute("aria-pressed")).toBe("false");
  await click("译文");
  expect(sync()).toBeUndefined();
});
it.each([
  { selection: undefined, expected: "流式翻译排版" },
  { selection: "原版翻译排版", expected: "原版翻译排版" },
  { selection: "流式翻译排版", expected: "流式翻译排版" },
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
    await render(cachedId, [block]);
    if (selection) {
      await clickPDFContent(host, "对照");
      await choosePDFFormat(host, selection);
      await clickPDFContent(host, "原文");
    }
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
    if (expected === "原版翻译排版")
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
  await click("译文");
  await choosePDFFormat(host, "原版翻译排版");
  expect(fixture.nativeProps?.layout).toBe("translation-only");
  await choosePDFFormat(host, "流式翻译排版");
  expect(host.querySelector(".translation-document")).not.toBeNull();
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("译文");
  await choosePDFFormat(host, "原版翻译排版");
  expect(fixture.nativeProps?.layout).toBe("translation-only");
  await clickPDFContent(host, "原文");
  expect(host.querySelector('[aria-label="排版方式"]')).toBeNull();
  await clickPDFContent(host, "对照");
  expect(fixture.nativeProps?.layout).toBe("side-by-side");
});
it("returns to the original for an explicit source reference from a native single translation", async () => {
  await click("译文");
  await choosePDFFormat(host, "原版翻译排版");
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
  await click("译文");
  await choosePDFFormat(host, "原版翻译排版");
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
  await click("译文");
  await choosePDFFormat(host, "原版翻译排版");
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
it("preserves the last live page while the next native viewport is loading", async () => {
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
  await render(cachedId, [
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
  await choosePDFFormat(host, "原版翻译排版");
  expect(fixture.nativeProps?.initialLocation).toMatchObject({
    type: "pdf",
    page: 7,
    y: 0.4,
  });
});
it("can change native layouts while the current one is regenerating without reading a disposed viewport", async () => {
  await click("译文");
  await choosePDFFormat(host, "原版翻译排版");
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
  await render(cachedId, [
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
  await choosePDFFormat(host, "流式翻译排版");
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
