import { nativeConfigUpdate } from "@interleaf/core";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@interleaf/api";
import type { NativeAIConfig, AgentModel } from "@interleaf/core";
import { ModelSelector, selectedAgentModel } from "./ModelSelector";
import { useReaderStore } from "./store";
vi.mock("@interleaf/api", () => ({
  api: { agentModels: vi.fn(), aiConfig: vi.fn(), saveAIConfig: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// Branding has its own tests. Keep model interactions independent of Lobe's
// avatar style runtime, while exercising the real Base UI popover/select/slider.
vi.mock("./ProviderIdentity", () => ({ ProviderIcon: () => <span /> }));
const models: AgentModel[] = [
  {
    id: "model-a",
    name: "Model A",
    description: "First model",
    isDefault: true,
    aliases: ["fast"],
  },
  {
    id: "model-b",
    name: "Model B",
    description: "Second model",
    isDefault: false,
  },
];
let root: Root;
let host: HTMLDivElement;
let config: NativeAIConfig;
const onSettings = vi.fn();
async function render() {
  await act(async () =>
    root.render(<ModelSelector disabled={false} onSettings={onSettings} />),
  );
}
async function open() {
  if (!document.querySelector(".effort-panel")) {
    await act(async () =>
      (
        host.querySelector(
          '[aria-label="选择模型和 Effort"]',
        ) as HTMLButtonElement
      ).click(),
    );
  }
  await act(async () =>
    (
      document.querySelector('[aria-label="选择模型"]') as HTMLButtonElement
    ).click(),
  );
}
async function chooseB() {
  await open();
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (item) => item.textContent?.includes("Model B"),
  )!;
  expect(option).toBeDefined();
  await act(async () => {
    option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    (option as HTMLElement).click();
  });
}
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
      hasKey: false,
    },
    models: { chat: "model-a", translation: "other-model" },
    efforts: {},
    apiModels: [],
  };
  useReaderStore.setState({ aiConfig: config, aiModelSaving: false });
  vi.mocked(api.agentModels).mockResolvedValue(models);
  vi.mocked(api.aiConfig).mockImplementation(async () => config);
  vi.mocked(api.saveAIConfig).mockImplementation(async (value) => ({
    ...config,
    ...value,
    connection: { ...config.connection, ...value.connection },
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
it("saves the selected model while preserving the latest connection configuration", async () => {
  await render();
  config = { ...config, connection: { ...config.connection, hasKey: true } };
  await chooseB();
  expect(api.saveAIConfig).toHaveBeenCalledWith({
    ...nativeConfigUpdate(config),
    models: { ...config.models, chat: "model-b" },
  });
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe(
    "Model B",
  );
  expect(useReaderStore.getState().aiModelSaving).toBe(false);
});
it("keeps the previous model after a failed save", async () => {
  vi.mocked(api.saveAIConfig).mockRejectedValue(new Error("save failed"));
  await render();
  await chooseB();
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe(
    "Model A",
  );
  expect(useReaderStore.getState().aiConfig?.models.chat).toBe("model-a");
  expect(useReaderStore.getState().aiModelSaving).toBe(false);
});
it("rejects a model save when the endpoint changed elsewhere", async () => {
  await render();
  config = {
    ...config,
    connection: { ...config.connection, url: "https://changed.test/v1" },
  };
  await chooseB();
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  expect(useReaderStore.getState().aiConfig?.connection.url).toBe(
    "https://changed.test/v1",
  );
});
it("does not replace the new endpoint catalog with a late response", async () => {
  let finish!: (value: AgentModel[]) => void;
  vi.mocked(api.agentModels)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue([
      { id: "sonnet", name: "Sonnet", description: "", isDefault: true },
    ]);
  await render();
  const signal = vi.mocked(api.agentModels).mock.calls[0]![1]!;
  await act(async () =>
    useReaderStore.getState().setAIConfig({
      ...config,
      connection: { ...config.connection, url: "https://changed.test/v1" },
      models: { chat: "sonnet" },
    }),
  );
  await act(async () => finish(models));
  expect(signal.aborted).toBe(true);
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe("Sonnet");
});

it("hides a completed previous endpoint catalog while the next catalog is pending or failed", async () => {
  vi.mocked(api.agentModels).mockResolvedValueOnce([
    {
      ...models[0]!,
      effortInfo: { mode: "fixed", note: "A-only metadata" },
      capability: { text: true, vision: true, checkedAt: "A" },
    },
    models[1]!,
  ]);
  await render();
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe(
    "Model A",
  );
  expect(host.querySelector(".model-trigger-effort")?.textContent).toBe(
    "固定／自动",
  );
  let fail!: (error: Error) => void;
  vi.mocked(api.agentModels).mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  config = {
    ...config,
    connection: { ...config.connection, url: "https://endpoint-b.test/v1" },
  };
  await act(async () => useReaderStore.getState().setAIConfig(config));
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe(
    "model-a",
  );
  expect(host.querySelector(".model-trigger-effort")?.textContent).toBe(
    "Medium",
  );
  await open();
  const names = () =>
    Array.from(document.querySelectorAll('[role="option"]')).map(
      (item) => item.textContent,
    );
  expect(names()).not.toContain("Model B");
  expect(names()).toContain("model-a");
  await act(async () => fail(new Error("B catalog unavailable")));
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe(
    "model-a",
  );
  expect(names()).not.toContain("Model B");
  expect(document.querySelector(".effort-panel")?.textContent).not.toContain(
    "A-only metadata",
  );
  expect(api.saveAIConfig).not.toHaveBeenCalled();
});

it("invalidates a connection save with identical public fields after key replacement", async () => {
  config = { ...config, connection: { ...config.connection, hasKey: true } };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.agentModels).mockResolvedValueOnce([
    { ...models[0]!, effortInfo: { mode: "fixed", note: "Old key metadata" } },
    models[1]!,
  ]);
  await render();
  expect(host.querySelector(".model-trigger-effort")?.textContent).toBe(
    "固定／自动",
  );
  let complete!: (models: AgentModel[]) => void;
  vi.mocked(api.agentModels).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const saved = JSON.parse(JSON.stringify(config)) as NativeAIConfig;
  await act(async () => useReaderStore.getState().setAIConfig(saved));
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe(
    "model-a",
  );
  expect(host.querySelector(".model-trigger-effort")?.textContent).toBe(
    "Medium",
  );
  await open();
  expect(
    Array.from(document.querySelectorAll('[role="option"]')).map(
      (item) => item.textContent,
    ),
  ).not.toContain("Model B");
  await act(async () => complete([]));
  expect(host.querySelector(".model-trigger-name")?.textContent).toBe(
    "model-a",
  );
  expect(document.querySelector(".effort-panel")?.textContent).not.toContain(
    "Old key metadata",
  );
});
it("resolves aliases and preserves custom model IDs", () => {
  expect(selectedAgentModel(models, "fast")?.id).toBe("model-a");
  expect(selectedAgentModel(models, "custom-model")?.id).toBe("custom-model");
  expect(selectedAgentModel(models, "")?.id).toBe("model-a");
  const recommended = [
    models[0]!,
    { ...models[1]!, recommendedFor: ["chat" as const] },
  ];
  expect(selectedAgentModel(recommended, "")?.id).toBe("model-b");
  expect(selectedAgentModel(recommended, "", "translation")?.id).toBe(
    "model-a",
  );
});

async function openEffort() {
  await act(async () =>
    (
      host.querySelector(
        '[aria-label="选择模型和 Effort"]',
      ) as HTMLButtonElement
    ).click(),
  );
}
async function effortKey(key: string) {
  const slider = document.querySelector('input[type="range"]')!;
  await act(async () => {
    slider.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    slider.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  });
}
it.each(["openai", "anthropic"] as const)(
  "always offers four effort levels for %s",
  async (protocol) => {
    config = {
      ...config,
      connection: { ...config.connection, protocol },
      models: { chat: "model-a" },
    };
    useReaderStore.setState({ aiConfig: config });
    await render();
    await openEffort();
    const slider = document.querySelector('input[type="range"]')!;
    expect(slider.getAttribute("min")).toBe("0");
    expect(slider.getAttribute("max")).toBe("3");
    expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
    await effortKey("End");
    expect(api.saveAIConfig).toHaveBeenCalledWith({
      ...nativeConfigUpdate(config),
      efforts: { chat: "max" },
    });
    expect(document.querySelector(".effort-title")?.textContent).toBe("Max");
  },
);
it("restores the previous effort if saving fails", async () => {
  config = { ...config, efforts: { chat: "high" } };
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.saveAIConfig).mockRejectedValue(new Error("save failed"));
  await render();
  await openEffort();
  await effortKey("Home");
  expect(document.querySelector(".effort-title")?.textContent).toBe("High");
  expect(useReaderStore.getState().aiModelSaving).toBe(false);
});
it("resets to Medium while preserving other model preferences", async () => {
  config = {
    ...config,
    efforts: {
      chat: "max",
      translation: "low",
      research: "high",
    },
  };
  useReaderStore.setState({ aiConfig: config });
  await render();
  await openEffort();
  await act(async () =>
    (
      document.querySelector(
        '[aria-label="恢复默认 Effort"]',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(api.saveAIConfig).toHaveBeenCalledWith({
    ...nativeConfigUpdate(config),
    efforts: { ...config.efforts, chat: "medium" },
  });
  expect(document.querySelector(".effort-title")?.textContent).toBe("Medium");
});
it("does not save effort to a model that changed elsewhere", async () => {
  await render();
  await openEffort();
  config = { ...config, models: { ...config.models, chat: "model-b" } };
  await effortKey("End");
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  expect(useReaderStore.getState().aiConfig?.models.chat).toBe("model-b");
});

it("drags the thumb through effort levels and saves only on release", async () => {
  await render();
  await openEffort();
  const thumb = document.querySelector(
    '[data-slot="slider-thumb"]',
  ) as HTMLElement;
  const control = thumb.parentElement!;
  const rect = (left: number, width: number) => ({
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 32,
    width,
    height: 32,
    toJSON() {},
  });
  vi.spyOn(control, "getBoundingClientRect").mockReturnValue(rect(0, 300));
  vi.spyOn(thumb, "getBoundingClientRect").mockImplementation(() => {
    const value = Number(
      (thumb.querySelector("input") as HTMLInputElement).value,
    );
    return rect((272 * value) / 3, 28);
  });
  const pointer = (type: string, x: number, buttons = 1) =>
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: 16,
    });
  await act(async () => {
    thumb.dispatchEvent(pointer("pointerdown", 105));
  });
  await act(async () => {
    document.dispatchEvent(pointer("pointermove", 196));
  });
  expect(document.querySelector(".effort-title")?.textContent).toBe("High");
  expect(api.saveAIConfig).not.toHaveBeenCalled();
  await act(async () => {
    document.dispatchEvent(pointer("pointermove", 287));
  });
  expect(document.querySelector(".effort-title")?.textContent).toBe("Max");
  await act(async () => {
    document.dispatchEvent(pointer("pointerup", 287, 0));
  });
  expect(api.saveAIConfig).toHaveBeenCalledExactlyOnceWith({
    ...nativeConfigUpdate(config),
    efforts: { chat: "max" },
  });
});

it("keeps the slider interactive during saving and persists the latest choice", async () => {
  let finish!: (value: NativeAIConfig) => void;
  vi.mocked(api.saveAIConfig).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await openEffort();
  const panel = document.querySelector(".effort-panel");
  await effortKey("End");
  expect(useReaderStore.getState().aiModelSaving).toBe(true);
  expect(
    (document.querySelector('input[type="range"]') as HTMLInputElement)
      .disabled,
  ).toBe(false);
  expect(document.querySelector(".effort-panel")).toBe(panel);
  await effortKey("Home");
  expect(document.querySelector(".effort-title")?.textContent).toBe("Low");
  expect(api.saveAIConfig).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ...config, efforts: { chat: "max" } }));
  expect(api.saveAIConfig).toHaveBeenCalledTimes(2);
  expect(useReaderStore.getState().aiConfig?.efforts?.chat).toBe("low");
  expect(document.querySelector(".effort-title")?.textContent).toBe("Low");
  expect(useReaderStore.getState().aiModelSaving).toBe(false);
});
