// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@interleaf/api";
import {
  defaultTheme,
  type Annotation,
  type ChatSessionDeletion,
  type DocumentChatSession,
  type ReaderEvents,
} from "@interleaf/core";
import { TooltipProvider } from "@interleaf/ui/components/tooltip";
import { Workspace } from "./Workspace";
import { paper } from "./papers/fixtures";
import { getChatSession, forgetChatSession } from "./chat/session-registry";

type PickerProps = {
  documentId: string;
  sessions: DocumentChatSession[];
  current?: DocumentChatSession;
  onChange: (id: string) => void;
  onRefresh: () => Promise<void>;
  onDeleted: (id: string, result: ChatSessionDeletion) => void;
};
let picker: PickerProps;
let serverSessions: DocumentChatSession[];
let annotations: Annotation[];
let readerEvents: ReaderEvents;
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock("@interleaf/api", () => ({
  api: {
    aiConfig: vi.fn(async () => ({
      version: 2,
      connection: { protocol: "openai", url: "", hasKey: false },
      models: {},
      efforts: {},
      apiModels: [],
    })),
    annotations: vi.fn(async () => structuredClone(annotations)),
    updateAnnotation: vi.fn(),
    messages: vi.fn(async () => []),
    sessionMessages: vi.fn(async () => []),
    answerSession: vi.fn(),
    chatSessions: vi.fn(async (id: string) =>
      structuredClone(serverSessions.filter((s) => s.documentId === id)),
    ),
    blocks: vi.fn(async () => []),
    translations: vi.fn(async () => []),
  },
  blockImageURL: vi.fn(),
  publicationURL: vi.fn(),
  watchChatRun: vi.fn(),
}));
vi.mock("./progress", () => ({
  scheduleProgress: vi.fn(),
  flushProgress: vi.fn(async () => {}),
}));
vi.mock("./chat/SessionPicker", () => ({
  SessionPicker: (props: PickerProps) => {
    picker = props;
    return (
      <div>
        {props.sessions.map((s) => (
          <button
            key={s.id}
            aria-label={`选择 ${s.id}`}
            onClick={() => props.onChange(s.id)}
          >
            {s.title}
          </button>
        ))}
      </div>
    );
  },
}));
vi.mock("./chat/MessageMarkdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => content,
}));
vi.mock("./ProviderIdentity", () => ({ ProviderGlyph: () => null }));
vi.mock("./ModelSelector", () => ({ ModelSelector: () => null }));
vi.mock("./NotesPanel", () => ({
  NotesPanel: ({
    annotations: items,
    onSave,
    onShowAnswer,
  }: {
    annotations: Annotation[];
    onSave: (
      annotation: Annotation,
      patch: { note: string; tags: string[] },
    ) => Promise<boolean>;
    onShowAnswer: (id: string) => void;
  }) => (
    <>
      <output aria-label="批注内容">{JSON.stringify(items)}</output>
      <button
        aria-label="保存批注笔记"
        onClick={() => void onSave(items[0], { note: "Edited note", tags: [] })}
      >
        保存笔记
      </button>
      <button onClick={() => onShowAnswer("linked-answer")}>查看回答</button>
    </>
  ),
}));
vi.mock("./DocumentOverview", () => ({ DocumentOverviewDialog: () => null }));
vi.mock("./ProcessingUsage", () => ({ ProcessingUsageDialog: () => null }));
vi.mock("./translation/PDFReadingView", () => ({
  PDFReadingView: ({ events }: { events: ReaderEvents }) => {
    readerEvents = events;
    return null;
  },
}));
vi.mock("./translation/EPUBReadingView", () => ({
  EPUBReadingView: () => null,
}));
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

it.each([false, true])(
  "does not restore a deleted answer from a delayed annotation save (new link: %s)",
  async (newLink) => {
    const annotation: Annotation = {
      id: "delayed-question",
      documentId: doc.id,
      kind: "question",
      quote: "Keep quote",
      note: "Original note",
      location: { type: "pdf", page: 1 },
      color: "yellow",
      createdAt: "",
      ...(newLink ? {} : { answerId: "removed-answer" }),
    };
    annotations = [annotation];
    await act(async () => render(otherDoc));
    await act(async () => render());
    if (newLink) {
      vi.mocked(api.sessionMessages).mockResolvedValueOnce([
        {
          id: "removed-answer",
          documentId: doc.id,
          sessionId: a.id,
          role: "assistant",
          content: "Saved answer",
          createdAt: "",
        },
      ]);
      await act(async () => getChatSession(doc.id, a.id).load());
    }
    await act(async () =>
      [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((tab) => tab.textContent?.startsWith("批注"))!
        .click(),
    );
    let finish!: (annotation: Annotation) => void;
    vi.mocked(api.updateAnnotation).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="保存批注笔记"]')!
        .click(),
    );
    await deleted(a.id, { ok: true, unlinkedAnnotationIds: [annotation.id] });
    await act(async () =>
      finish({
        ...annotation,
        note: "Edited note",
        answerId: "removed-answer",
      }),
    );
    const [saved] = JSON.parse(
      host.querySelector('[aria-label="批注内容"]')!.textContent!,
    );
    expect(saved.note).toBe("Edited note");
    expect(saved.quote).toBe("Keep quote");
    expect(saved.answerId).toBeUndefined();
  },
);

const doc = paper({ id: "managed-doc" });
const otherDoc = paper({ id: "another-doc" });
const a: DocumentChatSession = {
  id: "session-a",
  documentId: doc.id,
  title: "A",
  provider: "api",
  createdAt: "",
  updatedAt: "",
};
const b: DocumentChatSession = { ...a, id: "session-b", title: "B" };
const c: DocumentChatSession = { ...a, id: "session-c", title: "C" };
const linkedAnswer = {
  id: "linked-answer",
  documentId: doc.id,
  role: "assistant" as const,
  content: "The linked answer",
  createdAt: "",
};
let root: Root, host: HTMLDivElement;
let storage: Map<string, string>;
const originalGetAnimations = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "getAnimations",
);
const input = () =>
  host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 AI 提问"]')!;
const render = (document = doc) =>
  root.render(
    <TooltipProvider>
      <Workspace
        document={document}
        theme={defaultTheme}
        onBack={() => {}}
        onSettings={() => {}}
      />
    </TooltipProvider>,
  );
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(id: string) {
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(`button[aria-label="选择 ${id}"]`)!
      .click(),
  );
}
async function openLinkedAnswer() {
  await act(async () =>
    [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.startsWith("批注"))!
      .click(),
  );
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "查看回答")!
      .click(),
  );
}

it("opens and focuses the annotated answer in its saved session", async () => {
  vi.mocked(api.sessionMessages).mockImplementation(async (_, id) =>
    id === b.id ? [{ ...linkedAnswer, sessionId: b.id }] : [],
  );
  vi.mocked(api.answerSession).mockResolvedValue({ sessionId: b.id });
  await openLinkedAnswer();

  expect(picker.current?.id).toBe(b.id);
  expect(document.activeElement?.getAttribute("data-message-id")).toBe(
    linkedAnswer.id,
  );
  expect(api.answerSession).toHaveBeenCalledWith(
    doc.id,
    linkedAnswer.id,
    expect.any(AbortSignal),
  );
});

it("opens the current session's annotated answer without looking it up again", async () => {
  vi.mocked(api.sessionMessages).mockResolvedValue([
    { ...linkedAnswer, sessionId: a.id },
  ]);
  await act(async () => getChatSession(doc.id, a.id).load());
  await openLinkedAnswer();

  expect(picker.current?.id).toBe(a.id);
  expect(document.activeElement?.getAttribute("data-message-id")).toBe(
    linkedAnswer.id,
  );
  expect(api.answerSession).not.toHaveBeenCalled();
});

it("ignores a lookup that completes after switching documents", async () => {
  let complete!: (value: { sessionId: string }) => void;
  vi.mocked(api.answerSession).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await openLinkedAnswer();
  const [, , signal] = vi.mocked(api.answerSession).mock.calls[0]!;
  await act(async () => render(otherDoc));
  await act(async () => complete({ sessionId: b.id }));

  expect(signal?.aborted).toBe(true);
  expect(storage.get(`interleaf.chat-session.${doc.id}`)).toBeUndefined();
  expect(host.textContent).not.toContain(linkedAnswer.content);
});

it("keeps the current chat draft when quoting during an answer lookup", async () => {
  let complete!: (value: { sessionId: string }) => void;
  vi.mocked(api.answerSession).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await type("Current draft");
  await openLinkedAnswer();
  await act(async () =>
    readerEvents.selection({
      text: "New quote",
      location: { type: "pdf", page: 2 },
      anchor: { x: 120, top: 100, bottom: 120 },
    }),
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="引用到 AI 对话"]')!
      .click(),
  );
  await act(async () => complete({ sessionId: b.id }));

  expect(picker.current?.id).toBe(a.id);
  expect(input().value).toBe("Current draft");
  expect(host.querySelector(".quote-chips")?.textContent).toContain(
    "New quote",
  );
});

it("keeps the annotation open when its answer session is deleted during lookup", async () => {
  let complete!: (value: { sessionId: string }) => void;
  vi.mocked(api.answerSession).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await openLinkedAnswer();
  await deleted(b.id);
  await act(async () => complete({ sessionId: b.id }));

  expect(picker.current?.id).toBe(a.id);
  expect(host.querySelector('.notes-panel [role="status"]')?.textContent).toBe(
    "这条回答已不可用",
  );
  expect(storage.get(`interleaf.chat-session.${doc.id}`)).toBeUndefined();
});
async function deleted(
  id: string,
  result: ChatSessionDeletion = { ok: true, unlinkedAnnotationIds: [] },
) {
  serverSessions = serverSessions.filter((s) => s.id !== id);
  if (result.replacement) serverSessions.push(result.replacement);
  await act(async () => picker.onDeleted(id, result));
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(api.sessionMessages).mockReset().mockResolvedValue([]);
  vi.mocked(api.answerSession).mockReset();
  serverSessions = [a, b, c];
  annotations = [];
  storage = new Map();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => render());
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const d of [doc, otherDoc])
    for (const id of [a.id, b.id, c.id, "replacement", "other-session"])
      forgetChatSession(d.id, id);
  host.remove();
  if (originalGetAnimations)
    Object.defineProperty(
      Element.prototype,
      "getAnimations",
      originalGetAnimations,
    );
  else Reflect.deleteProperty(Element.prototype, "getAnimations");
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("deletes the current session and restores the remaining session's own draft", async () => {
  await select(b.id);
  await type("B draft stays");
  await select(a.id);
  await type("A draft is deleted");
  const old = getChatSession(doc.id, a.id);
  await deleted(a.id);
  expect(picker.current?.id).toBe(b.id);
  expect(input().value).toBe("B draft stays");
  expect(storage.get(`interleaf.chat-session.${doc.id}`)).toBe(b.id);
  expect(getChatSession(doc.id, a.id)).not.toBe(old);
  await deleted(c.id);
  expect(picker.current?.id).toBe(b.id);
  expect(input().value).toBe("B draft stays");
});

it("replaces the last conversation with an empty composer and rejects an older list response", async () => {
  await deleted(c.id);
  await deleted(b.id);
  await type("Discard this draft");
  let finish!: (items: DocumentChatSession[]) => void;
  vi.mocked(api.chatSessions).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let refreshing!: Promise<void>;
  await act(async () => {
    refreshing = picker.onRefresh();
  });
  const replacement = { ...a, id: "replacement", title: "默认会话" };
  await deleted(a.id, { ok: true, unlinkedAnnotationIds: [], replacement });
  expect(picker.current?.id).toBe("replacement");
  expect(input().value).toBe("");
  await act(async () => {
    finish([a, b, c]);
    await refreshing;
  });
  expect(picker.sessions.map((s) => s.id)).toEqual(["replacement"]);
  expect(storage.get(`interleaf.chat-session.${doc.id}`)).toBe("replacement");
});

it("keeps the newly selected conversation when deletion finishes after a selection change", async () => {
  const completed = picker.onDeleted;
  await select(b.id);
  await type("New selection draft");
  serverSessions = [b, c];
  await act(async () =>
    completed(a.id, { ok: true, unlinkedAnnotationIds: [] }),
  );
  expect(picker.current?.id).toBe(b.id);
  expect(input().value).toBe("New selection draft");
});

it("cleans the old document's cache without changing a newly opened document", async () => {
  storage.set(`interleaf.chat-session.${doc.id}`, a.id);
  const completed = picker.onDeleted;
  const old = getChatSession(doc.id, a.id);
  serverSessions.push({ ...a, id: "other-session", documentId: otherDoc.id });
  await act(async () => render(otherDoc));
  await type("Other document draft");
  await act(async () =>
    completed(a.id, { ok: true, unlinkedAnnotationIds: [] }),
  );
  expect(picker.documentId).toBe(otherDoc.id);
  expect(picker.current?.id).toBe("other-session");
  expect(input().value).toBe("Other document draft");
  expect(getChatSession(doc.id, a.id)).not.toBe(old);
  expect(storage.has(`interleaf.chat-session.${doc.id}`)).toBe(false);
});

it("unlinks deleted answers while preserving the question, note, and other answer links", async () => {
  annotations = [
    {
      id: "question-a",
      documentId: doc.id,
      kind: "question",
      quote: "Quoted sentence",
      note: "Question text",
      answerId: "answer-a",
      location: { type: "pdf", page: 1 },
      color: "yellow",
      createdAt: "",
    },
    {
      id: "question-b",
      documentId: doc.id,
      kind: "question",
      quote: "Other quote",
      note: "Other question",
      answerId: "answer-b",
      location: { type: "pdf", page: 2 },
      color: "yellow",
      createdAt: "",
    },
  ];
  // Reopen another document and return to cause the real annotation load effect.
  await act(async () => render(otherDoc));
  await act(async () => render());
  await deleted(a.id, { ok: true, unlinkedAnnotationIds: ["question-a"] });
  await act(async () =>
    [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.startsWith("批注"))!
      .click(),
  );
  const items = JSON.parse(
    host.querySelector('[aria-label="批注内容"]')!.textContent!,
  );
  expect(items[0]).toMatchObject({
    id: "question-a",
    quote: "Quoted sentence",
    note: "Question text",
  });
  expect(items[0].answerId).toBeUndefined();
  expect(items[1].answerId).toBe("answer-b");
});
