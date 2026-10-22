// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import type { BilingualPDFJob } from "@reader/core";
import { BilingualPDFExport } from "./BilingualPDFExport";
import { paper } from "./papers/fixtures";
vi.mock("@reader/api", () => ({
  api: {
    createBilingualPDF: vi.fn(),
    bilingualPDF: vi.fn(),
    startBilingualPDF: vi.fn(),
    cancelBilingualPDF: vi.fn(),
    attachBilingualPDF: vi.fn(),
  },
}));
const preflight: BilingualPDFJob = {
  id: "job",
  status: "awaiting-confirmation",
  stage: "prepare",
  done: 2,
  total: 2,
  preflight: {
    pages: 2,
    outputPages: 2,
    missingParagraphs: 3,
    noTextPages: [],
    apiConfigured: true,
    warnings: [],
  },
};
const ready: BilingualPDFJob = {
  id: "job",
  status: "ready",
  stage: "ready",
  done: 2,
  total: 2,
};
let host: HTMLDivElement, root: Root;
let doc = paper({ id: "doc", paperId: "paper" });
const save = vi.fn(),
  cancelSave = vi.fn();
const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  )!;
const click = async (name: string) => act(async () => button(name).click());
const mount = async () =>
  act(async () => root.render(<BilingualPDFExport document={doc} />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.clearAllMocks();
  doc = paper({ id: "doc", paperId: "paper" });
  window.readerDesktop = {
    saveBilingualPDF: save,
    cancelBilingualPDFSave: cancelSave,
  } as unknown as Window["readerDesktop"];
  save.mockResolvedValue({ saved: true, fileName: "双语.pdf" });
  cancelSave.mockResolvedValue(undefined);
  vi.mocked(api.createBilingualPDF).mockResolvedValue(preflight);
  vi.mocked(api.startBilingualPDF).mockResolvedValue(ready);
  vi.mocked(api.cancelBilingualPDF).mockResolvedValue(undefined);
  vi.mocked(api.attachBilingualPDF).mockResolvedValue(paper());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.readerDesktop;
  vi.unstubAllGlobals();
});

it("uses side by side default and requires explicit translation confirmation", async () => {
  await mount();
  await click("预检双语 PDF");
  expect(api.createBilingualPDF).toHaveBeenCalledWith("doc", {
    layout: "side-by-side",
  });
  expect(api.startBilingualPDF).not.toHaveBeenCalled();
  expect(host.textContent).toContain("3 段");
  await click("翻译并导出");
  expect(api.startBilingualPDF).toHaveBeenCalledWith(
    "doc",
    "job",
    { translateMissing: true, keepOriginalPages: [] },
    expect.any(AbortSignal),
  );
  expect(save).not.toHaveBeenCalled();
  await click("保存双语 PDF");
  expect(save).toHaveBeenCalledWith({ documentId: "doc", jobId: "job" });
  expect(host.textContent).toContain("已保存：双语.pdf");
});
it("offers alternating layout and rejects invalid ranges before creating a job", async () => {
  await mount();
  await act(async () =>
    [...host.querySelectorAll("label")]
      .find((node) => node.textContent === "逐页交替")!
      .querySelector<HTMLElement>('[role="radio"]')!
      .click(),
  );
  const from = host.querySelector<HTMLInputElement>('[aria-label="起始页"]')!;
  const to = host.querySelector<HTMLInputElement>('[aria-label="结束页"]')!;
  const set = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await act(async () => {
    set(from, "4");
    set(to, "2");
  });
  await click("预检双语 PDF");
  expect(api.createBilingualPDF).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => {
    set(from, "1");
    set(to, "2");
  });
  await click("预检双语 PDF");
  expect(api.createBilingualPDF).toHaveBeenCalledWith("doc", {
    layout: "alternating",
    fromPage: 1,
    toPage: 2,
  });
});
it("requires acknowledgement for no safely translatable pages", async () => {
  vi.mocked(api.createBilingualPDF).mockResolvedValue({
    ...preflight,
    preflight: { ...preflight.preflight!, noTextPages: [2] },
  });
  await mount();
  await click("预检双语 PDF");
  expect(button("翻译并导出").disabled).toBe(true);
  expect(host.textContent).toContain("无可翻译横排文字");
  await act(async () =>
    host
      .querySelector<HTMLElement>(
        '[aria-label="保留无可翻译横排文字页的原文"]',
      )!
      .click(),
  );
  await click("翻译并导出");
  expect(api.startBilingualPDF).toHaveBeenCalledWith(
    "doc",
    "job",
    { translateMissing: true, keepOriginalPages: [2] },
    expect.any(AbortSignal),
  );
});
it("points to existing Settings when API is missing and allows cached export without API", async () => {
  vi.mocked(api.createBilingualPDF).mockResolvedValue({
    ...preflight,
    preflight: { ...preflight.preflight!, apiConfigured: false },
  });
  await mount();
  await click("预检双语 PDF");
  expect(button("翻译并导出").disabled).toBe(true);
  expect(host.textContent).toContain("设置");
  expect(host.textContent).toContain("API URL");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await click("重新设置");
  vi.mocked(api.createBilingualPDF).mockResolvedValue({
    ...preflight,
    preflight: {
      ...preflight.preflight!,
      apiConfigured: false,
      missingParagraphs: 0,
    },
  });
  await click("预检双语 PDF");
  await click("生成双语 PDF");
  expect(api.startBilingualPDF).toHaveBeenCalledWith(
    "doc",
    "job",
    { translateMissing: false, keepOriginalPages: [] },
    expect.any(AbortSignal),
  );
});
it("shows actual stage counts and cancels the server job, not just HTTP", async () => {
  vi.mocked(api.createBilingualPDF).mockResolvedValue({
    id: "job",
    status: "translating",
    stage: "translating",
    done: 2,
    total: 7,
  });
  await mount();
  await click("预检双语 PDF");
  expect(host.textContent).toContain("翻译 2 / 7");
  await click("取消双语导出");
  expect(api.cancelBilingualPDF).toHaveBeenCalledWith("doc", "job");
  expect(cancelSave).toHaveBeenCalledWith({ documentId: "doc", jobId: "job" });
  expect(button("预检双语 PDF")).toBeDefined();
});
it("cleans a late create response on unmount even though abort alone cannot cancel it", async () => {
  let resolve!: (job: BilingualPDFJob) => void;
  vi.mocked(api.createBilingualPDF).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  await click("预检双语 PDF");
  expect(vi.mocked(api.createBilingualPDF).mock.calls[0][2]).toBeUndefined();
  await act(async () => root.render(null));
  await act(async () => resolve(preflight));
  expect(api.cancelBilingualPDF).toHaveBeenCalledWith("doc", "job");
  expect(save).not.toHaveBeenCalled();
});
it("cancels ready jobs on document switch and ignores a late native save without attachment", async () => {
  await mount();
  await click("预检双语 PDF");
  await click("翻译并导出");
  await act(async () =>
    host
      .querySelector<HTMLElement>('[aria-label="添加为此文献的翻译附件"]')!
      .click(),
  );
  let resolve!: (result: { saved: boolean; fileName?: string }) => void;
  save.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await click("保存双语 PDF");
  doc = paper({ id: "next", paperId: "next-paper" });
  await mount();
  await act(async () => resolve({ saved: true, fileName: "late.pdf" }));
  expect(api.cancelBilingualPDF).toHaveBeenCalledWith("doc", "job");
  expect(cancelSave).toHaveBeenCalledWith({ documentId: "doc", jobId: "job" });
  expect(api.attachBilingualPDF).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("late.pdf");
});
it("does not attach on picker cancel and prevents duplicate saves", async () => {
  await mount();
  await click("预检双语 PDF");
  await click("翻译并导出");
  await act(async () =>
    host
      .querySelector<HTMLElement>('[aria-label="添加为此文献的翻译附件"]')!
      .click(),
  );
  save.mockResolvedValueOnce({ saved: false });
  await click("保存双语 PDF");
  expect(api.attachBilingualPDF).not.toHaveBeenCalled();
  let resolve!: (result: { saved: boolean }) => void;
  save.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => {
    button("保存双语 PDF").click();
    button("保存双语 PDF").click();
  });
  expect(save).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ saved: true }));
  expect(api.attachBilingualPDF).toHaveBeenCalledOnce();
});
it("reports attachment errors separately and retries without saving again", async () => {
  vi.mocked(api.attachBilingualPDF).mockRejectedValueOnce(
    new Error("来源文献已合并或删除"),
  );
  await mount();
  await click("预检双语 PDF");
  await click("翻译并导出");
  await act(async () =>
    host
      .querySelector<HTMLElement>('[aria-label="添加为此文献的翻译附件"]')!
      .click(),
  );
  await click("保存双语 PDF");
  expect(host.textContent).toContain("已保存：双语.pdf");
  expect(host.textContent).toContain("附件添加失败");
  await click("重试添加附件");
  expect(save).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("已添加翻译附件");
});
it("offers attachments only for PaperItems and hides the feature outside desktop PDF", async () => {
  doc = paper({ paperId: undefined });
  await mount();
  expect(
    host.querySelector('[aria-label="添加为此文献的翻译附件"]'),
  ).toBeNull();
  doc = paper({ type: "epub" });
  await mount();
  expect(host.textContent).toBe("");
  doc = paper();
  delete window.readerDesktop;
  await mount();
  expect(host.textContent).toBe("");
});
it("aborts start and ignores its late completion after unmount", async () => {
  let resolve!: (result: BilingualPDFJob) => void;
  vi.mocked(api.startBilingualPDF).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  await click("预检双语 PDF");
  await click("翻译并导出");
  const signal = vi.mocked(api.startBilingualPDF).mock.calls[0][3]!;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(ready));
  expect(api.cancelBilingualPDF).toHaveBeenCalledWith("doc", "job");
  expect(save).not.toHaveBeenCalled();
});
it("polls genuine counts and cancels a failed job before retrying", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(api.createBilingualPDF).mockResolvedValueOnce({
      id: "job",
      status: "running",
      stage: "layout",
      done: 1,
      total: 8,
    });
    vi.mocked(api.bilingualPDF).mockResolvedValueOnce({
      id: "job",
      status: "failed",
      stage: "layout",
      done: 3,
      total: 8,
      error: "第 4 页排版失败",
    });
    await mount();
    await click("预检双语 PDF");
    expect(host.textContent).toContain("排版 1 / 8");
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(host.textContent).toContain("排版 3 / 8");
    expect(host.textContent).toContain("第 4 页排版失败");
    await click("重新设置");
    expect(api.cancelBilingualPDF).toHaveBeenCalledWith("doc", "job");
    await click("预检双语 PDF");
    expect(api.cancelBilingualPDF).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it("resets a ready job on library change before accepting another export", async () => {
  let change!: () => void;
  window.readerDesktop!.onLibraryChanged = (callback) => {
    change = callback;
    return () => {};
  };
  await mount();
  await click("预检双语 PDF");
  await click("翻译并导出");
  await act(async () => change());
  expect(cancelSave).toHaveBeenCalledWith({ documentId: "doc", jobId: "job" });
  expect(api.cancelBilingualPDF).toHaveBeenCalledWith("doc", "job");
  expect(button("预检双语 PDF")).toBeDefined();
});
it("keeps cancellation failure visible and retries DELETE before freeing the UI", async () => {
  vi.mocked(api.cancelBilingualPDF).mockRejectedValueOnce(
    new Error("无法连接本地服务"),
  );
  await mount();
  await click("预检双语 PDF");
  await click("重新设置");
  expect(host.textContent).toContain("取消任务失败");
  expect(api.createBilingualPDF).toHaveBeenCalledTimes(1);
  await click("重新设置");
  expect(api.cancelBilingualPDF).toHaveBeenCalledTimes(2);
  expect(button("预检双语 PDF").disabled).toBe(false);
});
