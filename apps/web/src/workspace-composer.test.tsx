// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Message,
  type NativeAIConfig,
  type PDFBlock,
  type ReaderAdapter,
  type ReaderEvents,
} from "@interleaf/core";
import { TooltipProvider } from "@interleaf/ui/components/tooltip";
import { Workspace } from "./Workspace";
import { ChatSession, type ChatInput } from "./chat/chat-session";
import { paper } from "./papers/fixtures";

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
vi.mock("./chat/AssistantPanel", () => ({ AssistantPanel: () => null }));
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
const adapter = {
  getLocation: () => ({ type: "pdf", page: 2 }),
  getContext: async () => "Page context",
  clearSelection: () => readerEvents.selection(null),
} as ReaderAdapter;
let root: Root, host: HTMLDivElement, session: ChatSession;
let history: Message[];
let requests: ChatInput[];
let finishAnswer: (() => void) | undefined;
let deferAnswer: boolean;
let restoreAnimations: () => void;
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
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Workspace
          document={doc}
          theme={defaultTheme}
          onBack={() => {}}
          onSettings={() => {}}
        />
      </TooltipProvider>,
    ),
  );
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
  await type("Follow-up question");
  await click("移除附件：第 3 页 · 图表");
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
