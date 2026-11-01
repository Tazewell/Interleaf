// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Annotation,
  type Processing,
} from "@interleaf/core";
import { TooltipProvider } from "@interleaf/ui/components/tooltip";
import { api } from "@interleaf/api";
import { Workspace } from "./Workspace";
import { paper } from "./papers/fixtures";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@interleaf/api", () => ({
  api: {
    aiConfig: vi.fn(async () => ({
      version: 2,
      connection: { protocol: "openai", url: "", hasKey: false },
      models: {},
      efforts: {},
      apiModels: [],
    })),
    recoverAnnotations: vi.fn(async () => ({ checked: true })),
    annotations: vi.fn(async () => []),
    removeAnnotation: vi.fn(async () => {}),
    messages: vi.fn(async () => []),
    chatSessions: vi.fn(async () => []),
    blocks: vi.fn(async () => []),
    documentNote: vi.fn(async () => ({ body: "note", updatedAt: "" })),
    translations: vi.fn(async () => []),
  },
  setDiagnosticReporter: vi.fn(),
  blockImageURL: vi.fn(),
  publicationURL: vi.fn(),
}));
vi.mock("./progress", () => ({
  scheduleProgress: vi.fn(),
  flushProgress: vi.fn(async () => {}),
}));
vi.mock("./translation/PDFReadingView", () => ({ PDFReadingView: () => null }));
vi.mock("./translation/EPUBReadingView", () => ({
  EPUBReadingView: () => null,
}));
vi.mock("./chat/AssistantPanel", () => ({ AssistantPanel: () => null }));
vi.mock("./ModelSelector", () => ({ ModelSelector: () => null }));
vi.mock("./DocumentOverview", () => ({ DocumentOverviewDialog: () => null }));
vi.mock("./ProcessingUsage", () => ({ ProcessingUsageDialog: () => null }));
vi.mock("./annotated-pdf-export", () => ({
  exportAnnotatedPDFWithToast: vi.fn(),
}));
vi.mock("./NotesPanel", () => ({
  NotesPanel: ({
    onExport,
    onRecover,
    annotations,
    onDelete,
  }: {
    onExport: () => void;
    onRecover: () => void;
    annotations: Annotation[];
    onDelete: (id: string) => void;
  }) => (
    <>
      <button onClick={onExport}>导出</button>
      <button onClick={onRecover}>重新定位</button>
      {annotations.map((item) => (
        <button key={item.id} onClick={() => onDelete(item.id)}>
          删除批注 {item.id}
        </button>
      ))}
    </>
  ),
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

const doc = paper({ id: "export-doc", title: "Export" });
const processing: Processing = {
  documentId: doc.id,
  phase: "ready",
  status: "complete",
  pagesDone: 1,
  pagesTotal: 1,
  translationsDone: 1,
  translationsTotal: 1,
  detail: "",
  updatedAt: "",
};
let root: Root, host: HTMLDivElement;
const render = (
  tick: number,
  patch: Partial<Processing> = {},
  document = doc,
) =>
  root.render(
    <TooltipProvider>
      <Workspace
        document={document}
        theme={defaultTheme}
        processing={{ ...processing, ...patch, updatedAt: String(tick) }}
        onBack={() => {}}
        onSettings={() => {}}
      />
    </TooltipProvider>,
  );
const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === text,
  )!;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.recoverAnnotations)
    .mockReset()
    .mockResolvedValue({ checked: true });
  vi.mocked(api.annotations).mockReset().mockResolvedValue([]);
  vi.mocked(api.chatSessions).mockReset().mockResolvedValue([]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["取消", "Close"])(
  "keeps one export dialog across progress refreshes and removes it with %s",
  async (close) => {
    await act(async () => render(0));
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((el) => el.textContent?.startsWith("批注"))!
        .click(),
    );
    await act(async () => button("导出").click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const dialog = document.querySelector('[role="dialog"]');
    for (let tick = 1; tick <= 3; tick++) await act(async () => render(tick));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    await act(async () => button(close).click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    await act(async () => button("导出").click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  },
);

it("checks annotations once on opening, before loading marks, not on progress updates", async () => {
  await act(async () => render(0));
  expect(api.recoverAnnotations).toHaveBeenCalledExactlyOnceWith(doc.id);
  expect(
    vi.mocked(api.recoverAnnotations).mock.invocationCallOrder[0],
  ).toBeLessThan(vi.mocked(api.annotations).mock.invocationCallOrder[0]);
  await act(async () => render(1));
  expect(api.recoverAnnotations).toHaveBeenCalledTimes(1);
});

it("loads existing marks while translating and checks them only after completion", async () => {
  await act(async () => render(0, { phase: "translating", status: "running" }));
  expect(api.annotations).toHaveBeenCalledWith(doc.id);
  expect(api.recoverAnnotations).not.toHaveBeenCalled();
  await act(async () => render(1));
  expect(api.recoverAnnotations).toHaveBeenCalledExactlyOnceWith(doc.id);
});

it("silently retries a deferred check without blocking marks or repeating after success", async () => {
  vi.useFakeTimers();
  vi.mocked(api.recoverAnnotations)
    .mockResolvedValueOnce({ checked: false })
    .mockResolvedValueOnce({ checked: true });
  await act(async () => render(0));
  expect(api.annotations).toHaveBeenCalledWith(doc.id);
  expect(toast.error).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(api.recoverAnnotations).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.recoverAnnotations).toHaveBeenCalledTimes(2);
});

it("bounds deferred checks and cancels their timer on leaving the document", async () => {
  vi.useFakeTimers();
  vi.mocked(api.recoverAnnotations).mockResolvedValue({ checked: false });
  await act(async () => render(0));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.recoverAnnotations).toHaveBeenCalledTimes(3);
  expect(toast.error).not.toHaveBeenCalled();
  await act(async () => render(1, {}, paper({ id: "another-doc" })));
  const calls = vi.mocked(api.recoverAnnotations).mock.calls.length;
  await act(async () =>
    render(2, { status: "running" }, paper({ id: "another-doc" })),
  );
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.recoverAnnotations).toHaveBeenCalledTimes(calls);
});

it("does not repeat annotation recovery when the chat session catalog arrives", async () => {
  let resolve!: (items: Awaited<ReturnType<typeof api.chatSessions>>) => void;
  vi.mocked(api.chatSessions).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await act(async () => render(0));
  await act(async () =>
    resolve([
      {
        id: "new-session",
        documentId: doc.id,
        title: "会话",
        provider: "api",
        createdAt: "",
        updatedAt: "",
      },
    ]),
  );
  expect(api.recoverAnnotations).toHaveBeenCalledTimes(1);
});

it("does not show a recovery error from a document that has already been closed", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api.recoverAnnotations).mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  await act(async () => render(0));
  await act(async () => render(1, {}, paper({ id: "another-doc" })));
  await act(async () => reject(new Error("正在更新译文，请稍后重试")));
  expect(toast.error).not.toHaveBeenCalled();
});

it("still reports actual annotation recovery failures", async () => {
  vi.mocked(api.recoverAnnotations).mockRejectedValueOnce(
    new Error("批注检查未完成"),
  );
  await act(async () => render(0));
  expect(toast.error).toHaveBeenCalledWith("批注检查未完成");
  expect(api.annotations).toHaveBeenCalledWith(doc.id);
});

it("keeps an explicit recovery conflict visible to the user", async () => {
  await act(async () => render(0));
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((el) => el.textContent?.startsWith("批注"))!
      .click(),
  );
  vi.mocked(api.recoverAnnotations).mockRejectedValueOnce(
    new Error("正在更新译文，请稍后重试"),
  );
  await act(async () => button("重新定位").click());
  expect(api.recoverAnnotations).toHaveBeenLastCalledWith(doc.id, true);
  expect(toast.error).toHaveBeenCalledWith("正在更新译文，请稍后重试");
});

it("does not restore a deleted annotation from a delayed recovery reload", async () => {
  vi.useFakeTimers();
  const mark: Annotation = {
    id: "mark",
    documentId: doc.id,
    kind: "highlight",
    quote: "quote",
    note: "",
    color: "#ffe58f",
    location: { type: "pdf", page: 1 },
    createdAt: "",
  };
  let resolve!: (items: Annotation[]) => void;
  vi.mocked(api.annotations)
    .mockResolvedValueOnce([mark])
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
  vi.mocked(api.recoverAnnotations)
    .mockResolvedValueOnce({ checked: false })
    .mockResolvedValueOnce({ checked: true });
  await act(async () => render(0));
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((el) => el.textContent?.startsWith("批注"))!
      .click(),
  );
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await act(async () => button("删除批注 mark").click());
  expect(api.removeAnnotation).toHaveBeenCalledWith(doc.id, mark.id);
  expect(button("删除批注 mark")).toBeUndefined();
  await act(async () => resolve([mark]));
  expect(button("删除批注 mark")).toBeUndefined();
});

it("keeps sibling document views distinct during reconciliation", async () => {
  const errors = vi.spyOn(console, "error");
  try {
    await act(async () => render(0));
    await act(async () => render(1));
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(
      /same key|unique.*key/,
    );
  } finally {
    errors.mockRestore();
  }
});
