// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeAIConfig, ProxySettingsState } from "@interleaf/core";
import { api } from "@interleaf/api";
import { toast } from "sonner";
import { Settings } from "./Settings";
import { useReaderStore } from "./store";

vi.mock("@interleaf/api", () => ({
  api: {
    connectorStatus: vi.fn(async () => ({ available: true })),
    journalRankConfig: vi.fn(async () => ({
      enabled: true,
      hasKey: false,
      selected: [],
      available: [],
    })),
    providers: vi.fn(),
    aiConfig: vi.fn(),
    saveAIConfig: vi.fn(),
    checkNativeAI: vi.fn(),
    agentModels: vi.fn(async () => []),
    saveLibraryPreferences: vi.fn(async (value) => value),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock("@interleaf/ui/components/dialog", () => {
  const Content = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: Content,
    DialogHeader: Content,
    DialogTitle: Content,
    DialogDescription: Content,
  };
});
let root: Root, host: HTMLDivElement;
const config: NativeAIConfig = {
  version: 2,
  connection: {
    protocol: "openai",
    url: "https://example.test/v1",
    hasKey: true,
  },
  models: { chat: "manual" },
  efforts: {},
  apiModels: [],
};
const input = (label: string) =>
  host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
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
  useReaderStore.setState({ aiConfig: config, aiModelSaving: false });
  vi.mocked(api.aiConfig).mockResolvedValue(config);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.interleafDesktop;
  vi.unstubAllGlobals();
});
it("groups proxy settings and log export under diagnostics without a network tab", async () => {
  const exportLogs = vi.fn(async () => true);
  window.interleafDesktop = {
    platform: "darwin",
    proxySettings: vi.fn(async (): Promise<ProxySettingsState> => ({
      settings: { mode: "manual", host: "127.0.0.1", port: 7890 },
      restartRequired: false,
    })),
    saveProxySettings: vi.fn(),
    checkProxy: vi.fn(),
    restart: vi.fn(),
    exportDiagnostics: exportLogs,
    checkForUpdates: vi.fn(),
    writeClipboardText: vi.fn(),
    writeClipboardImage: vi.fn(),
    setAppearance: vi.fn(),
    importFiles: vi.fn(),
    importLargePapers: vi.fn(),
    showDocumentFile: vi.fn(),
    openDocumentFile: vi.fn(),
    openExternal: vi.fn(),
    onBeforeClose: vi.fn(),
    onLibraryChanged: vi.fn(),
  };
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  const tabs = Array.from(
    host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  expect(tabs.map((tab) => tab.textContent)).not.toContain("网络");
  const diagnostics = tabs.find((tab) => tab.textContent === "诊断")!;
  await act(async () => diagnostics.click());
  const panel = input("代理地址").closest('[role="tabpanel"]')!;
  expect(panel.getAttribute("aria-labelledby")).toBe(diagnostics.id);
  expect(panel.textContent).toContain("chatgpt.com/robots.txt");
  const exportButton = Array.from(
    panel.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === "导出全部日志")!;
  await act(async () => exportButton.click());
  expect(exportLogs).toHaveBeenCalledOnce();
});
it("keeps selection auto-copy opt-in and lets reading settings toggle it", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const previous = useReaderStore.getState().theme;
  useReaderStore.setState({
    theme: { ...previous, autoCopySelection: undefined },
  });
  try {
    await act(async () =>
      root.render(<Settings open onOpenChange={() => {}} />),
    );
    const reading = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((tab) => tab.textContent === "阅读")!;
    await act(async () => reading.click());
    const label = [...host.querySelectorAll("label")].find((node) =>
      node.textContent?.includes("自动复制选中文字"),
    )!;
    const checkbox =
      label.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await act(async () => checkbox.click());
    expect(useReaderStore.getState().theme.autoCopySelection).toBe(true);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await act(async () => checkbox.click());
    expect(useReaderStore.getState().theme.autoCopySelection).toBe(false);
  } finally {
    await act(async () => useReaderStore.setState({ theme: previous }));
  }
});

it("does not expose automatic chapter context", async () => {
  await act(async () => root.render(<Settings open onOpenChange={() => {}} />));
  expect(host.querySelector('[aria-label="提问时附带本章原文"]')).toBeNull();
});

it("switches appearance through its own tabs while keeping display settings selected", async () => {
  const previous = useReaderStore.getState().theme;
  useReaderStore.setState({
    theme: { ...previous, appearance: "light", mode: "light" },
  });
  try {
    await act(async () =>
      root.render(<Settings open onOpenChange={() => {}} />),
    );
    const categories = host.querySelector('[aria-label="设置分类"]')!;
    expect(categories.getAttribute("aria-orientation")).toBe("vertical");
    const display = [
      ...categories.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((tab) => tab.textContent === "显示")!;
    await act(async () => display.click());
    const appearances = host.querySelector('[aria-label="界面主题"]')!;
    const dark = [
      ...appearances.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((tab) => tab.textContent === "深色")!;
    await act(async () => dark.click());
    expect(useReaderStore.getState().theme.appearance).toBe("dark");
    expect(dark.getAttribute("aria-selected")).toBe("true");
    expect(display.getAttribute("aria-selected")).toBe("true");
    const displayPanel = host.querySelector(
      '[aria-labelledby="' + display.id + '"]',
    )!;
    expect(displayPanel.hasAttribute("hidden")).toBe(false);
  } finally {
    await act(async () => useReaderStore.setState({ theme: previous }));
  }
});
