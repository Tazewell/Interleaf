// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantPanel } from "./AssistantPanel";
import { ChatSession, type ChatTransport } from "./chat-session";

// The assertion concerns when the body is mounted, independently of markdown parsing.
vi.mock("./MessageMarkdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => (
    <div className="message-markdown">{content}</div>
  ),
}));
vi.mock("../ProviderIdentity", () => ({ ProviderGlyph: () => null }));

let root: Root, host: HTMLDivElement, session: ChatSession;
let emit: Parameters<ChatTransport["stream"]>[3];
let finish: () => void;
const getAnimations = Element.prototype.getAnimations;
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
  Element.prototype.getAnimations = () => [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  session = new ChatSession("doc", {
    messages: async () => [],
    stream: async (_id, _input, _signal, next) => {
      emit = next;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  session.dispose();
  host.remove();
  Element.prototype.getAnimations = getAnimations;
  vi.unstubAllGlobals();
});

it("shows pending activity and reasoning without an empty answer cursor, then reveals streamed content", async () => {
  await session.load();
  let request: Promise<void>;
  await act(async () => {
    root.render(
      <AssistantPanel
        session={session}
        empty={null}
        extras={() => null}
        references={() => null}
        onRegenerate={() => {}}
      />,
    );
    request = session.send({
      provider: "api",
      prompt: "问题",
      context: "",
      references: [],
      attachments: [],
    });
  });
  expect(host.querySelector(".chat-waiting")?.textContent).toContain(
    "正在阅读上下文",
  );
  expect(host.querySelector(".message-markdown")).toBeNull();
  await act(async () => {
    emit({ event: "reasoning", data: { text: "先核对图表。" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(host.querySelector(".chat-thinking")).not.toBeNull();
  expect(host.querySelector(".message-markdown")).toBeNull();
  await act(async () => {
    emit({ event: "delta", data: { text: "图中展示了依赖关系。" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(host.querySelector(".message-markdown")?.textContent).toBe(
    "图中展示了依赖关系。",
  );
  expect(host.querySelector(".chat-waiting")).toBeNull();
  await act(async () => {
    finish();
    await request!;
  });
});
