// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@interleaf/api";
import * as registry from "./session-registry";
import type { Message } from "@interleaf/core";

vi.mock("@interleaf/api", () => ({
  api: {
    sessionMessages: vi.fn(async () => []),
    chatSessions: vi.fn(async () => []),
  },
  watchChatRun: vi.fn(),
}));
vi.mock("../store", () => ({ refreshAIConfig: vi.fn() }));

afterEach(() => vi.clearAllMocks());

it("forgets only the deleted session and aborts its stale history load", async () => {
  let finish!: (messages: Message[]) => void;
  let signal!: AbortSignal;
  vi.mocked(api.sessionMessages).mockImplementationOnce(
    (_doc, _session, abort) => {
      signal = abort!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  const deleted = registry.getChatSession("registry-doc", "deleted");
  const retained = registry.getChatSession("registry-doc", "retained");
  const loading = deleted.load();
  expect(signal.aborted).toBe(false);
  registry.forgetChatSession("registry-doc", "deleted");
  expect(signal.aborted).toBe(true);
  finish([
    {
      id: "old-answer",
      documentId: "registry-doc",
      role: "assistant",
      content: "Deleted history",
      createdAt: "",
    },
  ]);
  await loading;
  expect(deleted.getSnapshot().messages).toEqual([]);
  expect(registry.getChatSession("registry-doc", "deleted")).not.toBe(deleted);
  expect(registry.getChatSession("registry-doc", "retained")).toBe(retained);
});
