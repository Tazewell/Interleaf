// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import type { NativeAIConfig } from "@reader/core";
import { TaskModels, taskChoice } from "./TaskModels";
import { ModelSelector } from "./ModelSelector";
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
vi.mock("./ProviderIdentity", () => ({ ProviderIcon: () => <span /> }));
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

async function selectorOptions() {
  const popover = host.querySelector(
    '[aria-label="选择模型和 Effort"]',
  ) as HTMLButtonElement;
  if (!document.querySelector(".effort-panel"))
    await act(async () => popover.click());
  const select = document.querySelector(
    '[aria-label="选择模型"]',
  ) as HTMLButtonElement;
  if (select.getAttribute("aria-expanded") !== "true")
    await act(async () => select.click());
  return (
    Array.from(document.querySelectorAll('[role="listbox"]')).at(-1)
      ?.textContent ?? ""
  );
}
it.each([false, true])(
  "refreshes another ModelSelector after an explicit check changes text=%s",
  async (before) => {
    let candidateText = before;
    config.models.translation = "candidate";
    useReaderStore.setState({ aiConfig: config });
    vi.mocked(api.agentModels).mockImplementation(async () => [
      {
        id: "opus",
        name: "Opus",
        description: "",
        isDefault: true,
        capability: { text: true, vision: false, checkedAt: "initial" },
      },
      {
        id: "candidate",
        name: "Candidate",
        description: "",
        isDefault: false,
        capability: {
          text: candidateText,
          vision: false,
          checkedAt: candidateText ? "passed" : "failed",
        },
      },
    ]);
    vi.mocked(api.checkNativeAI).mockImplementation(async () => {
      candidateText = !before;
      return {
        text: candidateText,
        vision: false,
        checkedAt: "new",
        model: "candidate",
        fingerprint: "connection-model",
      };
    });
    await act(async () =>
      root.render(
        <>
          <TaskModels disabled={false} />
          <ModelSelector disabled={false} onSettings={() => {}} />
        </>,
      ),
    );
    expect((await selectorOptions()).includes("Candidate")).toBe(before);
    await act(async () =>
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent === "检测翻译")!
        .click(),
    );
    expect((await selectorOptions()).includes("Candidate")).toBe(!before);
    expect(useReaderStore.getState().aiConfig).toBe(config);
  },
);

it("does not refresh the new endpoint consumers when an old endpoint check completes", async () => {
  let complete!: (value: Awaited<ReturnType<typeof api.checkNativeAI>>) => void;
  config.models.translation = "candidate";
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.checkNativeAI).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  vi.mocked(api.agentModels).mockImplementation(async () =>
    useReaderStore.getState().aiConfig?.connection.url ===
    "https://endpoint-b.test/v1"
      ? [
          {
            id: "opus",
            name: "B current model",
            description: "",
            isDefault: true,
          },
        ]
      : [
          {
            id: "opus",
            name: "A current model",
            description: "",
            isDefault: true,
          },
        ],
  );
  await act(async () =>
    root.render(
      <>
        <TaskModels disabled={false} />
        <ModelSelector disabled={false} onSettings={() => {}} />
      </>,
    ),
  );
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "检测翻译")!
      .click(),
  );
  config = {
    ...config,
    connection: { ...config.connection, url: "https://endpoint-b.test/v1" },
  };
  await act(async () => useReaderStore.getState().setAIConfig(config));
  expect(await selectorOptions()).toContain("B current model");
  const requests = vi.mocked(api.agentModels).mock.calls.length;
  await act(async () =>
    complete({
      text: true,
      vision: false,
      checkedAt: "late",
      model: "candidate",
      fingerprint: "old-endpoint",
    }),
  );
  expect(await selectorOptions()).toContain("B current model");
  expect(await selectorOptions()).not.toContain("Candidate");
  expect(api.agentModels).toHaveBeenCalledTimes(requests);
});

it("refreshes matching endpoint consumers when settings change during a check", async () => {
  let complete!: (value: Awaited<ReturnType<typeof api.checkNativeAI>>) => void;
  let text = false;
  config.models.translation = "candidate";
  useReaderStore.setState({ aiConfig: config });
  vi.mocked(api.checkNativeAI).mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  vi.mocked(api.agentModels).mockImplementation(async () => [
    { id: "opus", name: "Opus", description: "", isDefault: true },
    {
      id: "candidate",
      name: "Candidate",
      description: "",
      isDefault: false,
      capability: { text, vision: false, checkedAt: "now" },
    },
  ]);
  await act(async () =>
    root.render(
      <>
        <TaskModels disabled={false} />
        <ModelSelector disabled={false} onSettings={() => {}} />
      </>,
    ),
  );
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "检测翻译")!
      .click(),
  );
  config = { ...config, translationPrompt: "concurrent preference" };
  await act(async () => useReaderStore.getState().setAIConfig(config));
  expect(await selectorOptions()).not.toContain("Candidate");
  text = true;
  await act(async () =>
    complete({
      text: true,
      vision: false,
      checkedAt: "now",
      model: "candidate",
      fingerprint: "same-endpoint",
    }),
  );
  expect(await selectorOptions()).toContain("Candidate");
});
