// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReaderSelection } from "@interleaf/core";
import { api } from "@interleaf/api";
import { SelectionTranslation } from "./SelectionTranslation";
vi.mock("@interleaf/api", () => ({ api: { translateSelection: vi.fn() } }));
const first: ReaderSelection = {
  text: "one",
  context: { before: "before", after: "after" },
  location: { type: "pdf", page: 1 },
  anchor: { x: 100, top: 80, bottom: 100 },
};
const second = { ...first, text: "two" };
let root: Root, host: HTMLDivElement;
const close = vi.fn();
const render = async (
  selection: ReaderSelection | null,
  options: { inline?: boolean; delayMs?: number } = {},
) => {
  await act(async () =>
    root.render(
      <SelectionTranslation
        selection={selection}
        onClose={close}
        {...options}
      />,
    ),
  );
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(api.translateSelection).mockReset();
  close.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("cancels replaced and closed requests and ignores late results", async () => {
  const pending: ((value: { text: string }) => void)[] = [];
  vi.mocked(api.translateSelection).mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  await render(first);
  expect(api.translateSelection).toHaveBeenCalledWith(
    first,
    expect.any(AbortSignal),
  );
  await render(second);
  expect(vi.mocked(api.translateSelection).mock.calls[0][1].aborted).toBe(true);
  await act(async () => pending[0]({ text: "旧结果" }));
  expect(document.body.textContent).not.toContain("旧结果");
  await act(async () => pending[1]({ text: "新结果" }));
  expect(document.body.textContent).toContain("新结果");
  await render(null);
  expect(vi.mocked(api.translateSelection).mock.calls[1][1].aborted).toBe(true);
});
it("shows failures and closes on scroll", async () => {
  vi.mocked(api.translateSelection).mockRejectedValueOnce(
    new Error("模型不可用"),
  );
  await render(first);
  expect(document.body.textContent).toContain("模型不可用");
  expect(api.translateSelection).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new Event("scroll")));
  expect(close).toHaveBeenCalledOnce();
});

it("renders the inline translation with its caller instead of opening another popover", async () => {
  vi.mocked(api.translateSelection).mockResolvedValueOnce({
    text: "选中文字的译文",
  });
  await render(first, { inline: true });
  expect(host.querySelector("[data-selection-translation]")).not.toBeNull();
  expect(host.textContent).toContain("选中文字的译文");
});

it("debounces automatic requests until the latest selection settles", async () => {
  vi.useFakeTimers();
  vi.mocked(api.translateSelection).mockResolvedValue({ text: "最新译文" });
  await render(first, { inline: true, delayMs: 350 });
  expect(api.translateSelection).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(200));
  await render(second, { inline: true, delayMs: 350 });
  await act(async () => vi.advanceTimersByTime(349));
  expect(api.translateSelection).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  expect(api.translateSelection).toHaveBeenCalledExactlyOnceWith(
    second,
    expect.any(AbortSignal),
  );
  expect(host.textContent).toContain("最新译文");
});

it("does not start a queued request when the translation is closed", async () => {
  vi.useFakeTimers();
  vi.mocked(api.translateSelection).mockResolvedValue({ text: "不应请求" });
  await render(first, { inline: true, delayMs: 350 });
  await render(null, { inline: true, delayMs: 350 });
  await act(async () => vi.advanceTimersByTime(500));
  expect(api.translateSelection).not.toHaveBeenCalled();
  expect(host.querySelector("[data-selection-translation]")).toBeNull();
});

it("retains one result when only the selection anchor changes", async () => {
  vi.mocked(api.translateSelection).mockResolvedValue({ text: "保留译文" });
  await render(first, { inline: true });
  await render(
    { ...first, anchor: { x: 200, top: 100, bottom: 120 } },
    { inline: true },
  );
  expect(api.translateSelection).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("保留译文");
  await render(
    { ...first, location: { type: "pdf", page: 2 } },
    { inline: true },
  );
  expect(api.translateSelection).toHaveBeenCalledTimes(2);
});

it("retries a failed request only on demand and aborts the replaced attempt", async () => {
  let finish: (value: { text: string }) => void;
  vi.mocked(api.translateSelection)
    .mockRejectedValueOnce(new Error("服务暂时不可用"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  await render(first, { inline: true });
  expect(host.textContent).toContain("服务暂时不可用");
  expect(api.translateSelection).toHaveBeenCalledTimes(1);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="重试翻译"]')!.click(),
  );
  expect(api.translateSelection).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.translateSelection).mock.calls[0][1].aborted).toBe(true);
  expect(host.textContent).not.toContain("服务暂时不可用");
  await act(async () => finish!({ text: "重试成功" }));
  expect(host.textContent).toContain("重试成功");
});

it("leaves inline scroll dismissal to its parent and cancels when the close action is pressed", async () => {
  vi.useFakeTimers();
  vi.mocked(api.translateSelection).mockResolvedValue({ text: "不应请求" });
  await render(first, { inline: true, delayMs: 350 });
  await act(async () => {
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  });
  expect(close).not.toHaveBeenCalled();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="关闭划词翻译"]')!
      .click(),
  );
  expect(close).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTime(500));
  expect(api.translateSelection).not.toHaveBeenCalled();
});

it.each([
  ["empty", "   ", "请选择文字"],
  ["too long", "😀".repeat(12001), "12000"],
])(
  "rejects %s selections locally without calling the model",
  async (_label, text, message) => {
    vi.mocked(api.translateSelection).mockResolvedValue({ text: "不应请求" });
    await render({ ...first, text }, { inline: true });
    expect(api.translateSelection).not.toHaveBeenCalled();
    expect(host.textContent).toContain(message);
  },
);

it("allows 12000 Unicode characters instead of counting UTF-16 code units", async () => {
  vi.mocked(api.translateSelection).mockResolvedValue({ text: "边界译文" });
  await render({ ...first, text: "😀".repeat(12000) }, { inline: true });
  expect(api.translateSelection).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("边界译文");
});

it("does not translate an unpositioned standalone popover", async () => {
  vi.mocked(api.translateSelection).mockResolvedValue({ text: "不应请求" });
  await render({ ...first, anchor: undefined });
  expect(api.translateSelection).not.toHaveBeenCalled();
});
