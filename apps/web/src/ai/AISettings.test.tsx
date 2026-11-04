// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeAIConfig } from "@interleaf/core";
import { api } from "@interleaf/api";
import { AISettings } from "./AISettings";
import { useReaderStore } from "../store";

// These integration tests exercise multiple real Base UI popups. On the
// two-core CI runner their focus/positioning work can exceed the global 10s
// limit; keep the additional budget local to this file.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("@interleaf/api", () => ({
  api: {
    aiConfig: vi.fn(),
    saveAIConfig: vi.fn(),
    agentModels: vi.fn(async () => []),
  },
}));

let root: Root, host: HTMLDivElement;
const saved: NativeAIConfig = {
  version: 2,
  connection: {
    protocol: "openai",
    url: "https://relay.example/v1",
    hasKey: true,
  },
  models: { chat: "old-chat", translation: "old-translation" },
  efforts: { chat: "high" },
  apiModels: ["old-chat", "old-history"],
  translationPrompt: "保留术语",
};
const input = (label: string) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const select = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

async function choose(label: string, value: string) {
  const trigger = select(label);
  expect(trigger, `missing ${label}`).not.toBeNull();
  await act(async () => trigger!.click());
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((element) => element.textContent === value);
  expect(option, `missing option ${value}`).toBeDefined();
  await act(async () => {
    option!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option!.click();
  });
}

async function enter(label: string, value: string) {
  const element = input(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function render(config = saved) {
  useReaderStore.setState({ aiConfig: config, aiModelSaving: false });
  vi.mocked(api.aiConfig).mockResolvedValue(config);
  await act(async () => root.render(<AISettings open />));
}

async function save() {
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(),
  );
}

async function switchTab(label: string) {
  const tab = [
    ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((element) => element.textContent === label);
  expect(tab, `missing tab ${label}`).toBeDefined();
  await act(async () => tab!.click());
  expect(tab!.getAttribute("aria-selected")).toBe("true");
}

beforeEach(() => {
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
  vi.mocked(api.saveAIConfig).mockImplementation(async (update) => ({
    ...saved,
    ...update,
    connection: { ...update.connection, hasKey: !!update.connection.key },
    models: update.models ?? {},
    efforts: update.efforts ?? {},
    apiModels: update.apiModels ?? [],
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("retains connection and translation prompt drafts across AI tabs without saving", async () => {
  await render();
  await enter("API Key", "fake-unsaved-key");
  await switchTab("翻译提示");
  const textarea = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "未保存的术语要求");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await switchTab("模型");
  expect(select("问答模型")?.disabled).toBe(true);
  await switchTab("连接");
  expect(input("API Key").value).toBe("fake-unsaved-key");
  await switchTab("翻译提示");
  expect(host.querySelector("textarea")?.value).toBe("未保存的术语要求");
  expect(api.saveAIConfig).not.toHaveBeenCalled();
});

it("retains model choices across AI tabs and saves only when requested", async () => {
  vi.mocked(api.agentModels).mockResolvedValueOnce([
    { id: "catalog-model", name: "Catalog", description: "", isDefault: false },
  ]);
  await render();
  await switchTab("模型");
  await choose("问答模型", "catalog-model");
  await switchTab("连接");
  await switchTab("翻译提示");
  await switchTab("模型");
  expect(select("问答模型")?.textContent).toContain("catalog-model");
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  const saveModels = [
    ...host.querySelectorAll<HTMLButtonElement>("button"),
  ].find((element) => element.textContent === "保存模型")!;
  await act(async () => saveModels.click());
  expect(api.saveAIConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      models: expect.objectContaining({ chat: "catalog-model" }),
    }),
  );
});

it.each([
  ["DeepSeek", "https://api.deepseek.com/v1"],
  ["阿里百炼", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["Kimi", "https://api.moonshot.cn/v1"],
  ["智谱", "https://open.bigmodel.cn/api/paas/v4"],
  ["MiniMax", "https://api.minimax.cn/v1"],
])(
  "selects %s as an unsaved OpenAI connection draft",
  async (provider, url) => {
    await render();
    await enter("API Key", "fake-typed-key");
    const configCalls = vi.mocked(api.aiConfig).mock.calls.length;
    const catalogCalls = vi.mocked(api.agentModels).mock.calls.length;

    await choose("服务商", provider);

    expect(input("API 地址").value).toBe(url);
    expect(input("API Key").value).toBe("");
    expect(input("API Key").placeholder).not.toContain("留空保留");
    expect(select("API 协议")?.textContent).toContain("OpenAI");
    expect(api.aiConfig).toHaveBeenCalledTimes(configCalls);
    expect(api.agentModels).toHaveBeenCalledTimes(catalogCalls);
    expect(api.saveAIConfig).not.toHaveBeenCalled();
    expect(useReaderStore.getState().aiConfig).toBe(saved);
    if (provider === "阿里百炼") {
      expect(host.textContent).toContain("北京");
      expect(host.textContent).toContain("其它地域");
    }
  },
);

it("saves a different endpoint without carrying its old key or models", async () => {
  await render();
  await choose("服务商", "阿里百炼");
  await save();

  expect(api.saveAIConfig).toHaveBeenCalledExactlyOnceWith({
    version: 2,
    connection: {
      protocol: "openai",
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    models: {},
    efforts: {},
    apiModels: [],
    translationPrompt: "保留术语",
  });
});

it("requires saving the drafted connection before using model controls", async () => {
  vi.mocked(api.agentModels).mockResolvedValueOnce([
    {
      id: "edited-old-model",
      name: "Edited",
      description: "",
      isDefault: false,
    },
  ]);
  await render();
  await switchTab("模型");
  await choose("问答模型", "edited-old-model");
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent === text,
    )!;
  expect(button("刷新模型列表").disabled).toBe(false);
  expect(button("保存模型").disabled).toBe(false);

  await switchTab("连接");
  await choose("服务商", "阿里百炼");

  expect(select("问答模型")?.disabled).toBe(true);
  expect(button("刷新模型列表").disabled).toBe(true);
  expect(button("保存模型").disabled).toBe(true);
  expect(button("检测问答").disabled).toBe(true);
  expect(host.textContent).toContain("先保存连接，再选择模型");

  await enter("API Key", "fake-bailian-key");
  await save();

  expect(select("问答模型")?.disabled).toBe(false);
  expect(select("问答模型")?.textContent).toContain("自动选择推荐模型");
  expect(button("刷新模型列表").disabled).toBe(false);
  expect(button("检测问答").disabled).toBe(false);
});

it("requires saving a typed or explicitly cleared key before using model controls", async () => {
  await render();
  await enter("API Key", "fake-replacement-key");
  expect(select("问答模型")?.disabled).toBe(true);
  await enter("API Key", "");
  expect(select("问答模型")?.disabled).toBe(false);
  const clear = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "清空 Key／无需密钥",
  )!;
  await act(async () => clear.click());
  expect(select("问答模型")?.disabled).toBe(true);
});

it("preserves saved models and the secret when the connection is unchanged", async () => {
  await render();
  expect(select("服务商")?.textContent).toContain("自定义");
  expect(input("API 地址").value).toBe("https://relay.example/v1");
  await save();

  expect(api.saveAIConfig).toHaveBeenCalledExactlyOnceWith({
    version: 2,
    connection: { protocol: "openai", url: "https://relay.example/v1" },
    models: { chat: "old-chat", translation: "old-translation" },
    efforts: { chat: "high" },
    apiModels: ["old-chat", "old-history"],
    translationPrompt: "保留术语",
  });
});

it("keeps custom protocol and URL editable and clears models on a protocol change", async () => {
  await render();
  await choose("API 协议", "Anthropic");
  await enter("API Key", "fake-anthropic-key");
  await save();

  expect(api.saveAIConfig).toHaveBeenCalledExactlyOnceWith({
    version: 2,
    connection: {
      protocol: "anthropic",
      url: "https://relay.example/v1",
      key: "fake-anthropic-key",
    },
    models: {},
    efforts: {},
    apiModels: [],
    translationPrompt: "保留术语",
  });
});

it("keeps a preset URL when entering custom mode, without carrying a typed key", async () => {
  await render();
  await choose("服务商", "Kimi");
  await enter("API Key", "fake-kimi-key");
  await choose("服务商", "自定义");
  expect(input("API 地址").value).toBe("https://api.moonshot.cn/v1");
  expect(input("API 地址").disabled).toBe(false);
  expect(select("API 协议")?.disabled).toBe(false);
  expect(input("API Key").value).toBe("");
  await enter("API 地址", "https://custom.example/messages");
  await choose("API 协议", "Anthropic");
  expect(input("API 地址").value).toBe("https://custom.example/messages");
}, 20_000);

it("preserves the same connection's models when only its key changes", async () => {
  await render();
  await enter("API Key", "fake-replacement-key");
  await save();
  expect(api.saveAIConfig).toHaveBeenCalledExactlyOnceWith({
    version: 2,
    connection: {
      protocol: "openai",
      url: "https://relay.example/v1",
      key: "fake-replacement-key",
    },
    models: { chat: "old-chat", translation: "old-translation" },
    efforts: { chat: "high" },
    apiModels: ["old-chat", "old-history"],
    translationPrompt: "保留术语",
  });
});

it("keeps models when custom URL edits only change normalized casing and slashes", async () => {
  await render();
  await enter("API 地址", " https://RELAY.example:443/v1/ ");
  expect(input("API Key").placeholder).toContain("留空保留");
  await save();
  expect(api.saveAIConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      models: { chat: "old-chat", translation: "old-translation" },
      efforts: { chat: "high" },
      apiModels: ["old-chat", "old-history"],
    }),
  );
});

it("does not carry a key typed before editing a custom endpoint", async () => {
  await render();
  await enter("API Key", "fake-original-key");
  await enter("API 地址", "https://other.example/v1");
  expect(input("API Key").value).toBe("");
  await save();
  expect(api.saveAIConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      connection: { protocol: "openai", url: "https://other.example/v1" },
      models: {},
      efforts: {},
      apiModels: [],
    }),
  );
});

it("compares the draft with the latest connection before carrying models", async () => {
  await render();
  vi.mocked(api.aiConfig).mockResolvedValueOnce({
    ...saved,
    connection: { ...saved.connection, url: "https://newer.example/v1" },
    models: { chat: "newer-model" },
    translationPrompt: "最新提示词",
  });
  await save();
  expect(api.saveAIConfig).toHaveBeenCalledExactlyOnceWith({
    version: 2,
    connection: { protocol: "openai", url: "https://relay.example/v1" },
    models: {},
    efforts: {},
    apiModels: [],
    translationPrompt: "最新提示词",
  });
});

it("can explicitly save a changed connection without a key", async () => {
  await render();
  await choose("服务商", "DeepSeek");
  const clear = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "清空 Key／无需密钥",
  )!;
  await act(async () => clear.click());
  await save();
  expect(api.saveAIConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      connection: {
        protocol: "openai",
        url: "https://api.deepseek.com/v1",
        key: null,
      },
      models: {},
      efforts: {},
      apiModels: [],
    }),
  );
});

it.each([
  ["https://api.deepseek.com", "openai", "DeepSeek"],
  ["https://api.deepseek.com/v1/", "openai", "DeepSeek"],
  ["https://dashscope.aliyuncs.com/compatible-mode/v1", "openai", "阿里百炼"],
  ["https://api.moonshot.cn/v1", "openai", "Kimi"],
  ["https://open.bigmodel.cn/api/paas/v4", "openai", "智谱"],
  ["https://api.minimax.cn/v1", "openai", "MiniMax"],
  ["https://api.deepseek.com/beta", "openai", "自定义"],
  ["https://api.deepseek.com/v1?route=custom", "openai", "自定义"],
  ["https://api.deepseek.com/v1", "anthropic", "自定义"],
  [
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "openai",
    "自定义",
  ],
  ["https://coding.dashscope.aliyuncs.com/v1", "openai", "自定义"],
  ["https://api.deepseek.com.example/v1", "openai", "自定义"],
])(
  "recognizes %s with %s without rewriting its URL",
  async (url, protocol, provider) => {
    await render({
      ...saved,
      connection: {
        ...saved.connection,
        url,
        protocol: protocol as "openai" | "anthropic",
      },
    });
    expect(select("服务商")?.textContent).toContain(provider);
    expect(input("API 地址").value).toBe(url);
    expect(api.saveAIConfig).not.toHaveBeenCalled();
  },
);
