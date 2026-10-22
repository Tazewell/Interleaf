// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import type { NativeAIConfig, NativeAICheck } from "@reader/core";
import { TaskModels } from "./TaskModels";
import { useReaderStore } from "./store";
vi.mock("@reader/api", () => ({
  api: {
    agentModels: vi.fn(),
    aiConfig: vi.fn(),
    saveAIConfig: vi.fn(),
    checkNativeAI: vi.fn(),
  },
}));
let root: Root, host: HTMLDivElement, config: NativeAIConfig;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  config = {
    version: 2,
    connection: {
      protocol: "openai",
      url: "https://example.test/v1",
      hasKey: true,
    },
    models: { chat: "chat-model", vision: "vision-model" },
    efforts: {},
    apiModels: [],
  };
  useReaderStore.setState({ aiConfig: config, aiModelSaving: false });
  vi.mocked(api.agentModels).mockResolvedValue([]);
  vi.mocked(api.aiConfig).mockResolvedValue(config);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<TaskModels disabled={false} />));
}
async function click(text: string) {
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === text)!
      .click(),
  );
}
it("never infers on open or catalog reload", async () => {
  await render();
  await click("刷新模型列表");
  expect(api.checkNativeAI).not.toHaveBeenCalled();
  expect(api.agentModels).toHaveBeenCalledWith("chat", expect.any(AbortSignal));
});
it("checks only the requested role after the user clicks and shows zero timing", async () => {
  vi.mocked(api.checkNativeAI).mockResolvedValue({
    text: true,
    vision: false,
    checkedAt: "now",
    model: "chat-model",
    fingerprint: "identity",
    textFirstOutputMs: 0,
  });
  await render();
  await click("检测问答");
  expect(api.checkNativeAI).toHaveBeenCalledExactlyOnceWith(
    "chat",
    "chat-model",
    15,
  );
  expect(host.textContent).toContain("文字可用");
  expect(host.textContent).toContain("文本首输出 0.00 s");
});
it("rejects invalid wait limits without starting a paid check", async () => {
  await render();
  const input = host.querySelector(
    '[aria-label="检测等待（秒）"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "61");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("检测问答");
  expect(api.checkNativeAI).not.toHaveBeenCalled();
});
it("drops late checks from a different endpoint", async () => {
  let complete!: (value: NativeAICheck) => void;
  vi.mocked(api.checkNativeAI).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await render();
  await click("检测问答");
  await act(async () =>
    useReaderStore.getState().setAIConfig({
      ...config,
      connection: { ...config.connection, url: "https://changed.test/v1" },
    }),
  );
  await act(async () =>
    complete({
      text: true,
      vision: true,
      checkedAt: "now",
      model: "chat-model",
      fingerprint: "old",
    }),
  );
  expect(host.textContent).not.toContain("文字可用");
});
it("does not keep old success after a failed explicit retry", async () => {
  vi.mocked(api.checkNativeAI).mockResolvedValueOnce({
    text: true,
    vision: true,
    checkedAt: "now",
    model: "vision-model",
    fingerprint: "identity",
  });
  await render();
  await click("检测图片");
  expect(host.textContent).toContain("图片可用");
  vi.mocked(api.checkNativeAI).mockRejectedValueOnce(
    new Error("connection interrupted"),
  );
  await click("检测图片");
  expect(host.textContent).not.toContain("图片可用");
  expect(host.textContent).toContain("connection interrupted");
});
