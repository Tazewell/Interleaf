// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatSessionDeletion, DocumentChatSession } from "@interleaf/core";
import { SessionPicker } from "./SessionPicker";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@interleaf/api", () => ({
  api: {
    createChatSession: mocks.create,
    updateChatSession: mocks.update,
    deleteChatSession: mocks.remove,
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const first: DocumentChatSession = {
  id: "first",
  documentId: "doc",
  title: "第一场讨论",
  provider: "api",
  createdAt: "",
  updatedAt: "",
};
const second: DocumentChatSession = {
  ...first,
  id: "second",
  title: "第二场讨论",
};
const result: ChatSessionDeletion = {
  ok: true,
  unlinkedAnnotationIds: ["question"],
};
let onDeleted = vi.fn(),
  onRefresh = vi.fn(),
  onChange = vi.fn();
async function renderManager(
  patch: Partial<Parameters<typeof SessionPicker>[0]> = {},
) {
  await act(async () =>
    root.render(
      <SessionPicker
        documentId="doc"
        sessions={[first, second]}
        current={first}
        provider="api"
        onChange={onChange}
        onRefresh={onRefresh}
        onDeleted={onDeleted}
        {...patch}
      />,
    ),
  );
}
const namedButton = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function clickName(label: string) {
  await act(async () => {
    expect(namedButton(label), label).not.toBeNull();
    namedButton(label).click();
  });
}
beforeEach(() => {
  onDeleted = vi.fn();
  onRefresh = vi.fn().mockResolvedValue(undefined);
  onChange = vi.fn();
  mocks.remove.mockReset().mockResolvedValue(result);
});

it("confirms the chosen conversation, permits cancellation, and deletes that conversation only", async () => {
  await renderManager();
  await clickName("会话管理");
  await clickName("删除会话：第二场讨论");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "第二场讨论",
  );
  expect(mocks.remove).not.toHaveBeenCalled();
  await act(async () =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button',
      ),
    ]
      .find((b) => b.textContent === "取消")!
      .click(),
  );
  expect(mocks.remove).not.toHaveBeenCalled();
  await clickName("删除会话：第二场讨论");
  await clickName("确认删除会话");
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("doc", "second");
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith("second", result);
  expect(onChange).not.toHaveBeenCalled();
  expect(namedButton("删除会话：第二场讨论")).toBeNull();
});

it("renames a noncurrent conversation without switching it", async () => {
  await renderManager();
  await clickName("会话管理");
  await clickName("重命名会话：第二场讨论");
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="会话名称"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "New title");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith("doc", "second", {
    title: "New title",
  });
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps failed deletion open for retry and prevents duplicate submissions", async () => {
  mocks.remove.mockRejectedValueOnce(new Error("无法删除，请重试"));
  await renderManager();
  await clickName("会话管理");
  await clickName("删除会话：第二场讨论");
  await clickName("确认删除会话");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "无法删除，请重试",
  );
  expect(onDeleted).not.toHaveBeenCalled();
  let finish!: (value: ChatSessionDeletion) => void;
  mocks.remove.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    namedButton("确认删除会话").click();
    namedButton("确认删除会话").click();
  });
  expect(mocks.remove).toHaveBeenCalledTimes(2);
  expect(namedButton("确认删除会话").disabled).toBe(true);
  await act(async () => finish(result));
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith("second", result);
});

it("blocks running sessions including the current request before polling catches up", async () => {
  const active = {
    ...second,
    latestRun: {
      id: "run",
      sessionId: "second",
      documentId: "doc",
      userMessageId: "q",
      provider: "api",
      status: "running" as const,
      startedAt: "",
    },
  };
  await renderManager({ sessions: [first, active], running: true });
  await clickName("会话管理");
  expect(namedButton("删除会话：第一场讨论").disabled).toBe(true);
  expect(namedButton("删除会话：第二场讨论").disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "先停止",
  );
  expect(mocks.remove).not.toHaveBeenCalled();
});

it("disposes a successful old-document deletion without refreshing or switching the new document", async () => {
  let finish!: (value: ChatSessionDeletion) => void;
  mocks.remove.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await renderManager();
  await clickName("会话管理");
  await clickName("删除会话：第二场讨论");
  await clickName("确认删除会话");
  const oldDeleted = onDeleted;
  const nextDeleted = vi.fn(),
    nextRefresh = vi.fn();
  await renderManager({
    documentId: "next-doc",
    sessions: [{ ...first, documentId: "next-doc" }],
    onDeleted: nextDeleted,
    onRefresh: nextRefresh,
  });
  await act(async () => finish(result));
  expect(oldDeleted).toHaveBeenCalledExactlyOnceWith("second", result);
  expect(nextDeleted).not.toHaveBeenCalled();
  expect(nextRefresh).not.toHaveBeenCalled();
  expect(onRefresh).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it("does not offer to delete an already removed session when list refresh fails", async () => {
  onRefresh.mockRejectedValueOnce(new Error("List refresh unavailable"));
  await renderManager();
  await clickName("会话管理");
  await clickName("删除会话：第二场讨论");
  await clickName("确认删除会话");
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith("second", result);
  expect(namedButton("删除会话：第二场讨论")).toBeNull();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});
it("creates using the updated settings choice rather than the current session's previous backend", async () => {
  const current: DocumentChatSession = {
    id: "old-session",
    documentId: "doc",
    title: "方法问题",
    provider: "api",
    createdAt: "now",
    updatedAt: "now",
  };
  const onChange = vi.fn(),
    onRefresh = vi.fn().mockResolvedValue(undefined);
  const render = async (provider: string) => {
    await act(async () =>
      root.render(
        <SessionPicker
          documentId="doc"
          sessions={[current]}
          current={current}
          provider={provider}
          onChange={onChange}
          onRefresh={onRefresh}
        />,
      ),
    );
  };
  await render("api");
  await render("codex");
  mocks.create.mockResolvedValue({
    ...current,
    id: "new-session",
    provider: "codex",
  });
  await act(async () =>
    (
      host.querySelector('[aria-label="新建会话"]') as HTMLButtonElement
    ).click(),
  );
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith("doc", "codex");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("new-session");
  expect(mocks.update).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="会话后端"]')).toBeNull();
  expect(host.querySelector('[aria-label="选择会话"]')).not.toBeNull();
});

it("shows an active request immediately even before the run list refreshes", async () => {
  const current: DocumentChatSession = {
    id: "session",
    documentId: "doc",
    title: "方法问题",
    provider: "api",
    createdAt: "now",
    updatedAt: "now",
    latestRun: {
      id: "old-run",
      sessionId: "session",
      documentId: "doc",
      userMessageId: "question",
      provider: "api",
      status: "completed",
      startedAt: "now",
    },
  };
  await act(async () =>
    root.render(
      <SessionPicker
        documentId="doc"
        sessions={[current]}
        current={current}
        provider="api"
        running
        onChange={() => {}}
        onRefresh={async () => {}}
      />,
    ),
  );
  expect(host.querySelector('[role="status"]')?.textContent).toBe("运行中");
});
