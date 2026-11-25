// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PDFOriginalConfirmation,
  PDFOriginalPending,
  PDFTranslationChooser,
  PDFTranslationTasks,
} from "./PDFTranslationControls";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("offers separate entry points and describes the wait before original generation", async () => {
  const onFlow = vi.fn(),
    onOriginal = vi.fn(),
    onConfirm = vi.fn();
  await act(async () =>
    root.render(
      <PDFTranslationChooser onFlow={onFlow} onOriginal={onOriginal} />,
    ),
  );
  const [flow, original] = Array.from(host.querySelectorAll("button"));
  expect(flow.textContent).toContain("开始流式翻译");
  expect(original.textContent).toContain("生成原版译文");
  await act(async () => original.click());
  expect(onOriginal).toHaveBeenCalledWith(original);
  expect(onFlow).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <PDFOriginalConfirmation
        open
        onConfirm={onConfirm}
        onOpenChange={() => {}}
      />,
    ),
  );
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("可能需要等几分钟");
  expect(dialog?.textContent).toContain("等待期间可以继续阅读");
  expect(onConfirm).not.toHaveBeenCalled();
  const action = dialog?.querySelector<HTMLButtonElement>(
    '[data-slot="alert-dialog-action"]',
  );
  await act(async () => action?.click());
  expect(onConfirm).toHaveBeenCalledOnce();
});

it("keeps the task list behind one toolbar control and shows measured original progress with a reading fallback", async () => {
  const onUseFlow = vi.fn();
  await act(async () =>
    root.render(
      <PDFTranslationTasks running={2}>
        <PDFOriginalPending
          job={{
            id: "job",
            cacheKey: "key",
            status: "running",
            stage: "layout",
            done: 0,
            total: 2,
            progress: { elapsedSeconds: 5, percent: 42 },
          }}
          busy
          error=""
          cancelling={false}
          onRetry={() => {}}
          onCancel={() => {}}
          onUseFlow={onUseFlow}
        />
      </PDFTranslationTasks>,
    ),
  );
  const trigger = host.querySelector<HTMLButtonElement>(
    '[aria-label="翻译任务（2 项进行中）"]',
  );
  expect(trigger).not.toBeNull();
  expect(document.querySelector('[role="progressbar"]')).toBeNull();
  await act(async () => trigger?.click());
  expect(
    document
      .querySelector('[role="progressbar"]')
      ?.getAttribute("aria-valuenow"),
  ).toBe("42");
  const fallback = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "使用流式翻译排版",
  );
  await act(async () => fallback?.click());
  expect(onUseFlow).toHaveBeenCalledOnce();
});
