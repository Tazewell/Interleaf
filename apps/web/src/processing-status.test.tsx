// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Processing } from "@interleaf/core";
import { api } from "@interleaf/api";
import { CoverProcessing } from "./ProcessingStatus";

vi.mock("@interleaf/api", () => ({
  api: { process: vi.fn(async () => ({})) },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const job: Processing = {
  documentId: "paper",
  phase: "learning",
  status: "running",
  pagesDone: 3,
  pagesTotal: 13,
  translationsDone: 0,
  translationsTotal: 0,
  detail: "正在解析 PDF",
  updatedAt: "2026-11-01T00:00:00Z",
};
let host: HTMLDivElement, root: Root;
const onSettings = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async (value: Processing, unavailable = false) =>
  act(async () =>
    root.render(
      <CoverProcessing
        job={value}
        onSettings={onSettings}
        unavailable={unavailable}
      />,
    ),
  );

it.each([
  ["queued", "等待索引"],
  ["running", "建立索引中"],
  ["ready", "可搜索"],
  ["partial", "部分可搜索"],
  ["unavailable", "可阅读"],
  ["failed", "索引失败"],
] as const)(
  "distinguishes %s text availability from background layout on covers",
  async (status, label) => {
    await render({
      ...job,
      textIndex: {
        status,
        totalPages: 13,
        searchablePages: status === "ready" ? 13 : status === "partial" ? 4 : 0,
      },
    });
    expect(host.querySelector(".processing-availability")?.textContent).toBe(
      label,
    );
    expect(host.querySelector(".processing-label")?.textContent).toBe(
      "后台解析",
    );
    expect(
      host.querySelector('[role="progressbar"]')?.getAttribute("aria-label"),
    ).toBe("版面解析进度");
    if (status === "partial") {
      expect(
        host.querySelector(".processing-availability")?.getAttribute("title"),
      ).toContain("4 / 13 页");
      expect(host.textContent).not.toContain("全文可搜索");
    }
    if (status === "unavailable")
      expect(
        host.querySelector(".processing-availability")?.textContent,
      ).not.toContain("可搜索");
  },
);

it("keeps readable text available while queued layout waits", async () => {
  await render({
    ...job,
    status: "queued",
    textIndex: { status: "ready", totalPages: 13, searchablePages: 13 },
  });
  expect(host.querySelector(".processing-availability")?.textContent).toBe(
    "可搜索",
  );
  expect(host.querySelector(".processing-label")?.textContent).toBe(
    "等待版面解析",
  );
});

it("retries only layout when searchable text is already ready", async () => {
  await render({
    ...job,
    status: "failed",
    textIndex: { status: "ready", totalPages: 13, searchablePages: 13 },
  });
  expect(host.querySelector(".processing-label")?.textContent).toBe(
    "版面解析失败",
  );
  expect(
    host.querySelector(".processing-availability")?.getAttribute("title"),
  ).not.toContain("后台继续");
  const retry = host.querySelector<HTMLButtonElement>(
    '[aria-label="重试解析"]',
  )!;
  expect(retry).not.toBeNull();
  await act(async () => retry.click());
  expect(api.process).toHaveBeenCalledExactlyOnceWith("paper");
  expect(host.querySelector(".processing-availability")?.textContent).toBe(
    "可搜索",
  );
});

it("retains historical cover labels when availability is missing", async () => {
  await render(job);
  expect(host.querySelector(".processing-label")?.textContent).toBe("学习中");
  expect(host.querySelector(".processing-availability")).toBeNull();
});

it("keeps paused covers quiet and stops activity while progress is offline", async () => {
  const ready = {
    ...job,
    textIndex: {
      status: "ready" as const,
      totalPages: 13,
      searchablePages: 13,
    },
  };
  await render({ ...ready, status: "paused" });
  expect(host.querySelector(".cover-processing")).toBeNull();
  await render(ready, true);
  expect(host.textContent).toContain("离线");
  expect(host.querySelector('[data-active="true"]')).toBeNull();
});

it.each(["waiting", "failed"] as const)(
  "preserves %s translation actions with text availability",
  async (status) => {
    await render({
      ...job,
      phase: "translating",
      status,
      pagesDone: 13,
      translationsDone: 2,
      translationsTotal: 10,
      textIndex: { status: "ready", totalPages: 13, searchablePages: 13 },
    });
    expect(host.querySelector(".processing-label")?.textContent).toBe(
      status === "waiting" ? "翻译待配置" : "翻译失败",
    );
    const action = host.querySelector<HTMLButtonElement>(
      `[aria-label="${status === "waiting" ? "等待 AI 配置" : "重试翻译"}"]`,
    )!;
    await act(async () => action.click());
    if (status === "waiting") expect(onSettings).toHaveBeenCalledOnce();
    else expect(api.process).toHaveBeenCalledExactlyOnceWith("paper");
    expect(host.textContent).toContain("2/10");
  },
);
