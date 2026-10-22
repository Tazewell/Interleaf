// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import type { NativeAIConfig } from "@reader/core";
import { TaskModels, taskChoice } from "./TaskModels";
import { useReaderStore } from "./store";
vi.mock("@reader/api", () => ({
  api: {
    agentModels: vi.fn(),
    aiConfig: vi.fn(),
    saveAIConfig: vi.fn(),
    checkNativeAI: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
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
    models: { chat: "opus" },
    efforts: { chat: "high" },
    apiModels: [],
  };
  useReaderStore.setState({ aiConfig: config, aiModelSaving: false });
  vi.mocked(api.agentModels).mockResolvedValue([]);
  vi.mocked(api.aiConfig).mockImplementation(async () => config);
  vi.mocked(api.saveAIConfig).mockImplementation(async (value) => {
    config = {
      ...config,
      ...value,
      connection: { ...config.connection, ...value.connection },
    };
    return config;
  });
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
async function type(label: string, value: string) {
  const input = host.querySelector(
    `[aria-label="${label}"]`,
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function save() {
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "保存模型")!
      .click(),
  );
}
it("inherits research effort and keeps translation automatic", () => {
  expect(taskChoice(config, "research")).toEqual({ model: "", effort: "high" });
  expect(taskChoice(config, "translation")).toEqual({
    model: "",
    effort: "medium",
  });
});
it("saves a manual translation choice without overwriting unedited roles or key", async () => {
  await render();
  await type("翻译模型", "manual-fast");
  config = {
    ...config,
    models: { ...config.models, research: "concurrent-research" },
  };
  await save();
  expect(config.models).toEqual({
    chat: "opus",
    translation: "manual-fast",
    research: "concurrent-research",
  });
  expect(api.saveAIConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      connection: { protocol: "openai", url: "https://example.test/v1" },
    }),
  );
  expect(config.connection.hasKey).toBe(true);
});
it("keeps typed models after catalog failure", async () => {
  vi.mocked(api.agentModels).mockRejectedValue(
    new Error("catalog unavailable"),
  );
  await render();
  expect(
    (host.querySelector('[aria-label="问答模型"]') as HTMLInputElement).value,
  ).toBe("opus");
  await type("问答模型", "hand-entered");
  await save();
  expect(config.models.chat).toBe("hand-entered");
  expect(config.apiModels).toContain("hand-entered");
});
it("leaves the image model empty until a verified image model is configured", async () => {
  await render();
  expect(
    (host.querySelector('[aria-label="图片模型"]') as HTMLInputElement).value,
  ).toBe("");
  expect(api.checkNativeAI).not.toHaveBeenCalled();
});
it("rejects a stale model save after the endpoint changes", async () => {
  await render();
  await type("翻译模型", "manual-fast");
  config = {
    ...config,
    connection: { ...config.connection, url: "https://changed.test/v1" },
  };
  await save();
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  expect(useReaderStore.getState().aiConfig?.connection.url).toBe(
    "https://changed.test/v1",
  );
});
it("disables fixed effort and shows a tunable role mapping", async () => {
  config.models.translation = "tunable";
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValue([
    {
      id: "opus",
      name: "Opus",
      description: "",
      isDefault: true,
      effortInfo: { mode: "fixed", note: "固定模式" },
    },
    {
      id: "tunable",
      name: "Tunable",
      description: "",
      isDefault: false,
      effortInfo: {
        mode: "levels",
        note: "官方映射",
        mappings: { medium: "high" },
      },
    },
  ]);
  await render();
  expect(
    (host.querySelector('[aria-label="问答 Effort"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (host.querySelector('[aria-label="翻译 Effort"]') as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(host.textContent).toContain("medium → high");
});
