// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Message,
  type Annotation,
  type NativeAIConfig,
  type PDFBlock,
  type ReaderAdapter,
  type ReaderEvents,
} from "@interleaf/core";
import { TooltipProvider } from "@interleaf/ui/components/tooltip";
import { Workspace } from "./Workspace";
import { ChatSession, type ChatInput } from "./chat/chat-session";
import { paper } from "./papers/fixtures";
import { api } from "@interleaf/api";
import { useReaderStore } from "./store";
import { scheduleProgress } from "./progress";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock("@interleaf/api", () => ({
  api: {
    aiConfig: vi.fn(async () => config),
    annotations: vi.fn(async () => []),
    messages: vi.fn(async () => []),
    chatSessions: vi.fn(async () => [
      { id: "conversation", documentId: doc.id, title: "默认会话" },
    ]),
    blocks: vi.fn(async () => []),
    translations: vi.fn(async () => []),
    translateSelection: vi.fn(async () => ({ text: "便携译文" })),
    annotate: vi.fn(
      async (
        documentId: string,
        input: Omit<Annotation, "id" | "documentId" | "createdAt">,
      ) => ({ ...input, documentId, id: "selection-mark", createdAt: "" }),
    ),
  },
  blockImageURL: (_documentId: string, blockId: string) =>
    `/images/${blockId}.png`,
  publicationURL: vi.fn(),
}));
vi.mock("./progress", () => ({
  scheduleProgress: vi.fn(),
  flushProgress: vi.fn(async () => {}),
}));
vi.mock("./chat/session-registry", () => ({ getChatSession: () => session }));
vi.mock("./ModelSelector", () => ({ ModelSelector: () => null }));
vi.mock("./chat/AssistantPanel", () => ({
  AssistantPanel: ({ empty }: { empty: ReactNode }) =>
    showChatEmpty ? empty : null,
}));
vi.mock("./NotesPanel", () => ({ NotesPanel: () => <p>批注列表</p> }));
vi.mock("./DocumentOverview", () => ({ DocumentOverviewDialog: () => null }));
vi.mock("./ProcessingUsage", () => ({ ProcessingUsageDialog: () => null }));
vi.mock("./translation/PDFReadingView", async () => {
  const { useEffect } = await import("react");
  const { BlockActions } = await import("./BlockActions");
  return {
    PDFReadingView: ({
      events,
      onReady,
    }: {
      events: ReaderEvents;
      onReady: (adapter: ReaderAdapter, toc: []) => void;
    }) => {
      readerEvents = events;
      readerRenders++;
      useEffect(() => onReady(adapter, []), []);
      return (
        <>
          <BlockActions block={paragraph} onAction={events.blockAction!} />
          <BlockActions block={figure} onAction={events.blockAction!} />
        </>
      );
    },
  };
});
vi.mock("./translation/EPUBReadingView", async () => {
  const view = await import("./translation/PDFReadingView");
  return { EPUBReadingView: view.PDFReadingView };
});
vi.mock("@interleaf/ui/components/resizable", async () => {
  const { useRef } = await import("react");
  const Panel = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    ResizablePanel: Panel,
    ResizablePanelGroup: Panel,
    ResizableHandle: () => null,
    usePanelRef: () => useRef(null),
  };
});

const config: NativeAIConfig = {
  version: 2,
  connection: {
    protocol: "openai",
    url: "https://example.test/v1",
    hasKey: true,
  },
  models: { chat: "model" },
  efforts: {},
  apiModels: [],
};
const doc = paper({ id: "composer-doc" });
const paragraph: PDFBlock = {
  id: "paragraph",
  page: 2,
  label: "text",
  text: "Separate temporal and spatial information.",
  bounds: { x: 0.1, y: 0.2, width: 0.7, height: 0.1 },
};
const figure: PDFBlock = {
  id: "figure",
  page: 3,
  label: "image",
  text: "",
  caption: "Figure 1: model overview",
  bounds: { x: 0.1, y: 0.3, width: 0.7, height: 0.4 },
  image: "figure.png",
};
let readerEvents: ReaderEvents;
let readerRenders = 0;
const adapter = {
  getLocation: () => ({ type: "pdf", page: 2 }),
  getContext: async () => "Page context",
  clearSelection: vi.fn(() => readerEvents.selection(null)),
} as unknown as ReaderAdapter;
let root: Root, host: HTMLDivElement, session: ChatSession;
let history: Message[];
let requests: ChatInput[];
let finishAnswer: (() => void) | undefined;
let deferAnswer: boolean;
let showChatEmpty: boolean;
let restoreAnimations: () => void;
function Harness({ document = doc }: { document?: typeof doc } = {}) {
  const theme = useReaderStore((state) => state.theme);
  return (
    <TooltipProvider>
      <Workspace
        document={document}
        theme={theme}
        onBack={() => {}}
        onSettings={() => {}}
      />
    </TooltipProvider>
  );
}
const input = () =>
  host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 AI 提问"]')!;
const button = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function click(label: string) {
  await act(async () => {
    button(label).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function type(question: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input(), question);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  readerRenders = 0;
  useReaderStore.setState({ theme: { ...defaultTheme } });
  vi.mocked(api.translateSelection)
    .mockReset()
    .mockResolvedValue({ text: "便携译文" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  const animations = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getAnimations",
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  restoreAnimations = () => {
    if (animations)
      Object.defineProperty(Element.prototype, "getAnimations", animations);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
  };
  history = [];
  requests = [];
  deferAnswer = false;
  showChatEmpty = false;
  finishAnswer = undefined;
  session = new ChatSession(
    doc.id,
    {
      messages: async () => history,
      stream: async (_, request, _signal, emit) => {
        requests.push(request);
        if (deferAnswer)
          await new Promise<void>((resolve) => {
            finishAnswer = resolve;
          });
        history = [
          {
            id: request.userMessageId!,
            documentId: doc.id,
            role: "user",
            content: request.prompt,
            createdAt: "",
          },
          {
            id: "answer",
            documentId: doc.id,
            role: "assistant",
            content: "An answer",
            createdAt: "",
          },
        ];
        emit({ event: "delta", data: { text: "An answer" } });
        emit({ event: "done", data: { ok: true } });
      },
    },
    "conversation",
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});

it("keeps PDF scrolling out of the reading tree while saving the latest precise position", async () => {
  await act(async () =>
    readerEvents.location({ type: "pdf", page: 2, x: 0.1, y: 0.1 }, 0.2),
  );
  const renders = readerRenders;
  vi.mocked(scheduleProgress).mockClear();
  for (const y of [0.2, 0.3, 0.4, 0.5]) {
    await act(async () =>
      readerEvents.location({ type: "pdf", page: 2, x: 0.1, y }, y),
    );
  }
  expect(readerRenders).toBe(renders);
  expect(scheduleProgress).toHaveBeenCalledTimes(4);
  expect(scheduleProgress).toHaveBeenLastCalledWith(
    doc.id,
    { progress: { type: "pdf", page: 2, x: 0.1, y: 0.5 }, percentage: 0.5 },
    expect.any(Function),
  );
  await click("更多阅读操作");
  const bookmark = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent?.includes("添加书签"))!;
  await act(async () => bookmark.click());
  expect(api.annotate).toHaveBeenLastCalledWith(
    doc.id,
    expect.objectContaining({
      kind: "bookmark",
      location: { type: "pdf", page: 2, x: 0.1, y: 0.5 },
    }),
  );
});

it("updates the PDF page controls when scrolling crosses pages", async () => {
  await act(async () =>
    readerEvents.location({ type: "pdf", page: 2, y: 0.8 }, 0.2),
  );
  const renders = readerRenders;
  await act(async () =>
    readerEvents.location({ type: "pdf", page: 3, y: 0.1 }, 0.3),
  );
  expect(readerRenders).toBeGreaterThan(renders);
  const afterPage = readerRenders;
  await act(async () =>
    readerEvents.location({ type: "pdf", page: 3, y: 0.2 }, 0.31),
  );
  expect(readerRenders).toBe(afterPage);
  await act(async () =>
    readerEvents.location({ type: "pdf", page: 2, y: 0.9 }, 0.29),
  );
  expect(readerRenders).toBeGreaterThan(afterPage);
});
afterEach(async () => {
  finishAnswer?.();
  await act(async () => root.unmount());
  session.dispose();
  host.remove();
  document.body.innerHTML = "";
  restoreAnimations();
  vi.unstubAllGlobals();
});

const selectedPassage = {
  text: "Selected passage",
  context: { before: "Before", after: "After" },
  location: { type: "pdf" as const, page: 2 },
  anchor: { x: 100, top: 80, bottom: 100 },
};
const settleSelection = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
it("keeps selection translation manual by default and shows it below actions without sending chat", async () => {
  await act(async () => readerEvents.selection(selectedPassage));
  await settleSelection();
  expect(api.translateSelection).not.toHaveBeenCalled();
  await click("划词翻译");
  expect(api.translateSelection).toHaveBeenCalledExactlyOnceWith(
    selectedPassage,
    expect.any(AbortSignal),
  );
  expect(
    host.querySelector(".selection-surface [data-selection-translation]")
      ?.textContent,
  ).toContain("便携译文");
  expect(adapter.clearSelection).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
});
it("automatically translates settled selected text only when enabled", async () => {
  await act(async () =>
    useReaderStore.getState().setTheme({ autoTranslateSelection: true }),
  );
  await act(async () => readerEvents.selection(selectedPassage));
  await settleSelection();
  expect(api.translateSelection).toHaveBeenCalledExactlyOnceWith(
    selectedPassage,
    expect.any(AbortSignal),
  );
  expect(host.textContent).toContain("便携译文");
  expect(requests).toEqual([]);
});
it("cancels the automatic debounce when the preference is disabled", async () => {
  await act(async () =>
    useReaderStore.getState().setTheme({ autoTranslateSelection: true }),
  );
  await act(async () => readerEvents.selection(selectedPassage));
  await act(async () =>
    useReaderStore.getState().setTheme({ autoTranslateSelection: false }),
  );
  await settleSelection();
  expect(api.translateSelection).not.toHaveBeenCalled();
  expect(host.querySelector("[data-selection-translation]")).toBeNull();
});
it("enables automatic translation from the selected-text menu and preserves its selected source", async () => {
  await act(async () => readerEvents.selection(selectedPassage));
  await click("更多文字操作");
  const automatic = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
  ].find((item) => item.textContent?.includes("自动划词翻译"));
  expect(automatic).toBeDefined();
  await act(async () => {
    automatic!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(useReaderStore.getState().theme.autoTranslateSelection).toBe(true);
  await settleSelection();
  expect(api.translateSelection).toHaveBeenCalledExactlyOnceWith(
    selectedPassage,
    expect.any(AbortSignal),
  );
});
it("does not restart translation for an equivalent selection or a moved viewport anchor", async () => {
  await act(async () =>
    useReaderStore.getState().setTheme({ autoTranslateSelection: true }),
  );
  await act(async () => readerEvents.selection(selectedPassage));
  await settleSelection();
  await act(async () =>
    readerEvents.selection({
      ...selectedPassage,
      anchor: { x: 120, top: 90, bottom: 110 },
    }),
  );
  await settleSelection();
  expect(api.translateSelection).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("便携译文");
});
it("keeps the source snapshot for quoting after interacting inside its translation card", async () => {
  await act(async () => readerEvents.selection(selectedPassage));
  await click("划词翻译");
  const card = host.querySelector("[data-selection-translation]")!;
  expect(card).not.toBeNull();
  await act(async () => {
    card.querySelector<HTMLButtonElement>("button")!.focus();
    readerEvents.selection(null);
  });
  expect(host.querySelector("[data-selection-translation]")).not.toBeNull();
  await click("引用到 AI 对话");
  expect(host.querySelector(".quote-chips")?.textContent).toContain(
    selectedPassage.text,
  );
  expect(host.querySelector("[data-selection-translation]")).toBeNull();
  expect(api.translateSelection).toHaveBeenCalledTimes(1);
});
it("aborts an inline request when the engine clears selection outside the card", async () => {
  vi.mocked(api.translateSelection).mockImplementation(
    () => new Promise(() => {}),
  );
  await act(async () => readerEvents.selection(selectedPassage));
  await click("划词翻译");
  const signal = vi.mocked(api.translateSelection).mock.calls[0][1];
  await act(async () => readerEvents.selection(null));
  expect(signal.aborted).toBe(true);
  expect(host.querySelector("[data-selection-translation]")).toBeNull();
});
it("highlights the original source after card interaction and closes the translation", async () => {
  await act(async () => readerEvents.selection(selectedPassage));
  await click("划词翻译");
  const card = host.querySelector("[data-selection-translation]")!;
  await act(async () => {
    card.querySelector<HTMLButtonElement>("button")!.focus();
    readerEvents.selection(null);
  });
  await click("高亮");
  expect(api.annotate).toHaveBeenCalledExactlyOnceWith(
    doc.id,
    expect.objectContaining({
      kind: "highlight",
      quote: selectedPassage.text,
      location: selectedPassage.location,
    }),
  );
  expect(host.querySelector("[data-selection-translation]")).toBeNull();
});
it("keeps translation through repeated progress at the same reading location and closes on navigation", async () => {
  await act(async () => readerEvents.location({ type: "pdf", page: 2 }, 0.2));
  await act(async () => readerEvents.selection(selectedPassage));
  await click("划词翻译");
  await act(async () => readerEvents.location({ type: "pdf", page: 2 }, 0.2));
  expect(host.querySelector("[data-selection-translation]")).not.toBeNull();
  await act(async () => {
    readerEvents.selection(null);
    readerEvents.location({ type: "pdf", page: 3 }, 0.3);
  });
  expect(host.querySelector("[data-selection-translation]")).toBeNull();
  expect(
    host.querySelector('[role="toolbar"][aria-label="选中文字操作"]'),
  ).toBeNull();
});
it("keeps EPUB translated selection when its captured reading location follows in the same event", async () => {
  const book = {
    ...doc,
    type: "epub" as const,
    library: "books" as const,
    progress: {
      type: "epub" as const,
      href: "chapter.xhtml",
      start: 0,
      end: 0,
    },
  };
  await act(async () => {
    root.render(<Harness key="epub-document" document={book} />);
    useReaderStore.getState().setTheme({ autoTranslateSelection: true });
  });
  const excerpt = {
    ...selectedPassage,
    location: {
      type: "epub" as const,
      href: "chapter.xhtml",
      start: 4,
      end: 20,
      translation: {
        blockId: "paragraph",
        sourceHash: "hash",
        sentenceIndexes: [0],
        start: 0,
        end: 16,
      },
    },
  };
  await act(async () => {
    readerEvents.selection(excerpt);
    readerEvents.location(excerpt.location, 0.25);
  });
  await settleSelection();
  expect(api.translateSelection).toHaveBeenCalledExactlyOnceWith(
    excerpt,
    expect.any(AbortSignal),
  );
  expect(
    host.querySelector("[data-selection-translation]")?.textContent,
  ).toContain("便携译文");
});

it("quotes a paragraph without sending or replacing the reader's question", async () => {
  await type("Why separate these two kinds of information?");
  await act(async () =>
    [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.startsWith("批注"))!
      .click(),
  );
  await click("引用此段到 AI 对话");
  expect(requests).toHaveLength(0);
  expect(input().value).toBe("Why separate these two kinds of information?");
  expect(host.querySelector(".quote-chips")?.textContent).toContain(
    "Separate temporal and spatial information.",
  );
  expect(document.activeElement === input()).toBe(true);
  await click("发送问题");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    prompt: "Why separate these two kinds of information?",
    references: [
      {
        text: "Separate temporal and spatial information.",
        location: {
          type: "pdf",
          page: 2,
          quote: "Separate temporal and spatial information.",
          rects: [{ x: 0.1, y: 0.2, width: 0.7, height: 0.1 }],
        },
        kind: "selection",
      },
    ],
  });
});

it("stages a figure until the reader explicitly sends a question", async () => {
  await click("引用图片到 AI 对话");
  expect(requests).toHaveLength(0);
  expect(input().value).toBe("");
  expect(host.querySelectorAll(".chat-compose .image-attachment")).toHaveLength(
    1,
  );
  expect(button("发送问题").disabled).toBe(true);
  await act(async () =>
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(requests).toHaveLength(0);
  await type("What does the arrow mean?");
  await click("发送问题");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    prompt: "What does the arrow mean?",
    attachments: [
      {
        id: "figure",
        page: 3,
        label: "image",
        caption: "Figure 1: model overview",
      },
    ],
  });
});

it("quotes a text selection, focuses the composer and keeps its draft", async () => {
  await type("Explain the difference");
  await act(async () =>
    readerEvents.selection({
      text: "Selected sentence",
      location: { type: "pdf", page: 2, quote: "Selected sentence" },
      anchor: { x: 120, top: 100, bottom: 120 },
    }),
  );
  await click("引用到 AI 对话");
  expect(requests).toHaveLength(0);
  expect(host.querySelector(".quote-chips")?.textContent).toContain(
    "Selected sentence",
  );
  expect(input().value).toBe("Explain the difference");
  expect(document.activeElement === input()).toBe(true);
  expect(host.querySelector('[aria-label="选中文字操作"]')).toBeNull();
});

it("deduplicates quoted content and lets readers remove it without changing their question", async () => {
  await type("My own question");
  await click("引用此段到 AI 对话");
  await click("引用此段到 AI 对话");
  await click("引用图片到 AI 对话");
  await act(async () =>
    [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.startsWith("批注"))!
      .click(),
  );
  await click("引用图片到 AI 对话");
  expect(document.activeElement === input()).toBe(true);
  expect(host.querySelectorAll(".quote-chips > div")).toHaveLength(1);
  expect(host.querySelectorAll(".chat-compose .image-attachment")).toHaveLength(
    1,
  );
  await click("移除引用");
  await click("移除附件：第 3 页 · 图表");
  expect(host.querySelector(".quote-chips")).toBeNull();
  expect(host.querySelector(".chat-compose .image-attachment")).toBeNull();
  expect(input().value).toBe("My own question");
  expect(requests).toHaveLength(0);
});

it("preserves new references and a follow-up draft when an earlier answer finishes", async () => {
  deferAnswer = true;
  await type("First question");
  await click("引用此段到 AI 对话");
  await click("引用图片到 AI 对话");
  await click("发送问题");
  expect(requests).toHaveLength(1);
  expect(host.querySelector(".chat-compose .image-attachment")).toBeNull();
  expect(host.querySelector(".quote-chips")).toBeNull();
  await type("Follow-up question");
  await click("引用图片到 AI 对话");
  await act(async () =>
    readerEvents.blockAction!(
      {
        ...paragraph,
        id: "next-paragraph",
        page: 4,
        text: "New context for the next question.",
      },
      "attach",
    ),
  );
  await act(async () => finishAnswer!());
  expect(requests).toHaveLength(1);
  expect(input().value).toBe("Follow-up question");
  expect(host.querySelector(".quote-chips")?.textContent).toContain(
    "New context for the next question.",
  );
  expect(host.querySelector(".quote-chips")?.textContent).not.toContain(
    "Separate temporal and spatial information.",
  );
  expect(host.querySelectorAll(".chat-compose .image-attachment")).toHaveLength(
    1,
  );
});

it("clears only the submitted references as soon as the answer starts", async () => {
  deferAnswer = true;
  await type("Explain this figure");
  await click("引用此段到 AI 对话");
  await click("引用图片到 AI 对话");
  await click("发送问题");
  expect(session.getSnapshot().busy).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0].attachments).toMatchObject([{ id: "figure" }]);
  expect(requests[0].references).toHaveLength(1);
  expect(input().value).toBe("");
  expect(host.querySelector(".chat-compose .image-attachment")).toBeNull();
  expect(host.querySelector(".quote-chips")).toBeNull();
});

it("keeps the draft and references when preparation rejects the question before sending", async () => {
  await act(async () =>
    readerEvents.selection({
      text: "x".repeat(256001),
      location: { type: "pdf", page: 2 },
      anchor: { x: 120, top: 100, bottom: 120 },
    }),
  );
  await click("引用到 AI 对话");
  await click("引用图片到 AI 对话");
  await type("Keep this question");
  await click("发送问题");
  expect(requests).toHaveLength(0);
  expect(input().value).toBe("Keep this question");
  expect(host.querySelector(".chat-compose .image-attachment")).not.toBeNull();
  expect(host.querySelector(".quote-chips")).not.toBeNull();
});

it("keeps references when another run starts while page context is being prepared", async () => {
  showChatEmpty = true;
  await type("My next question");
  await click("引用图片到 AI 对话");
  let finishContext!: (context: string) => void;
  const context = vi.spyOn(adapter, "getContext").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishContext = resolve;
      }),
  );
  try {
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((item) => item.textContent?.includes("总结当前页面"))!
        .click(),
    );
    deferAnswer = true;
    let running!: Promise<void>;
    await act(async () => {
      running = session.send({
        provider: "api",
        prompt: "Restored running question",
        context: "",
        references: [],
        attachments: [],
      });
    });
    await act(async () => finishContext("Page context"));
    expect(requests).toHaveLength(1);
    expect(requests[0].prompt).toBe("Restored running question");
    expect(input().value).toBe("My next question");
    expect(
      host.querySelector(".chat-compose .image-attachment"),
    ).not.toBeNull();
    await act(async () => {
      finishAnswer!();
      await running;
    });
  } finally {
    context.mockRestore();
  }
});
