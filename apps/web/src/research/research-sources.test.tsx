// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { researchAPI } from "@reader/api";
import { ResearchPanel } from "./ResearchPanel";
import {
  click,
  flush,
  mockAPI,
  mount,
  render,
  report,
  run,
  type,
} from "./test-helpers";
import type { ResearchEvidence } from "@reader/core";
import { resetResearchLibrary } from "./research-session";
const evidence: ResearchEvidence = {
  id: "a".repeat(32),
  topicId: "topic",
  snapshotId: "snapshot",
  runId: "run",
  documentId: "pdf-doc",
  kind: "local-page",
  revision: "v1",
  contentHash: "hash",
  location: { type: "pdf", page: 7 },
  excerpt: "PDF证据",
  readAt: "2026",
  availability: "valid",
};
let view: ReturnType<typeof mount>;
beforeEach(() => {
  mockAPI();
  view = mount();
});
afterEach(async () => {
  await act(async () => view.root.unmount());
  view.host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("renders source coverage, revision history and authorized candidate import", async () => {
  vi.mocked(researchAPI.listReports).mockResolvedValue([
    {
      ...report,
      stale: true,
      sourceIds: ["a".repeat(32)],
      content:
        "旧报告 [aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] [bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb]",
    },
  ]);
  vi.mocked(researchAPI.listCandidates).mockResolvedValue([
    {
      id: "candidate",
      topicId: "topic",
      identityKey: "doi:10/test",
      title: "候选论文",
      authors: "A",
      doi: "10/test",
      arxiv: "",
      publishedAt: "2026",
      updatedAt: "",
      abstract: "摘要",
      landingUrl: "https://example.org",
      pdfUrl: "",
      aliases: [],
    },
  ]);
  const source = vi.spyOn(researchAPI, "getSource").mockResolvedValue({
    id: "a".repeat(32),
    topicId: "topic",
    snapshotId: "snapshot",
    runId: "run",
    kind: "remote-abstract",
    revision: "v1",
    contentHash: "hash",
    location: { type: "pdf", page: 3 },
    excerpt: "仅摘要",
    readAt: "2026",
    availability: "valid",
  });
  const imported = vi
    .spyOn(researchAPI, "importCandidate")
    .mockRejectedValue(new Error("下载暂不可用"));
  const open = vi.fn();
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={open} />,
  );
  expect(view.host.textContent).toContain("2 / 12");
  expect(view.host.textContent).toContain("历史版本");
  expect(imported).not.toHaveBeenCalled();
  expect(view.host.querySelector('a[href*="bbbbbbbb"]')).toBeNull();
  await click(view.host, "来源 1");
  expect(source).toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(view.host.textContent).toContain("仅摘要");
  await click(view.host, "导入候选论文");
  expect(imported).toHaveBeenCalledTimes(1);
  expect(view.host.textContent).toContain("下载暂不可用");
});
it("validates current evidence before PDF and native EPUB navigation, and rejects stale sources", async () => {
  vi.mocked(researchAPI.listReports).mockResolvedValue([
    { ...report, sourceIds: [evidence.id] },
  ]);
  let finish!: (value: ResearchEvidence) => void;
  const get = vi
    .spyOn(researchAPI, "getSource")
    .mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  const open = vi.fn();
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={open} />,
  );
  const button = Array.from(view.host.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "来源 1",
  )!;
  await act(async () => button.click());
  expect(open).not.toHaveBeenCalled();
  await act(async () => finish(evidence));
  await flush();
  expect(open).toHaveBeenLastCalledWith("pdf-doc", { type: "pdf", page: 7 });
  get.mockResolvedValue({
    ...evidence,
    documentId: "epub-doc",
    kind: "local-passage",
    location: {
      type: "epub",
      href: "chapter-2.xhtml",
      progression: 0.4,
      blockId: "p2",
    },
  });
  await click(view.host, "来源 1");
  expect(open).toHaveBeenLastCalledWith("epub-doc", {
    type: "epub",
    href: "chapter-2.xhtml",
    progression: 0.4,
    blockId: "p2",
  });
  get.mockResolvedValue({ ...evidence, availability: "stale" });
  await click(view.host, "来源 1");
  expect(open).toHaveBeenCalledTimes(2);
  expect(view.host.textContent).toContain("来源已失效");
});
it("ignores a source response from the previous library epoch", async () => {
  vi.mocked(researchAPI.listReports).mockResolvedValue([
    { ...report, sourceIds: [evidence.id] },
  ]);
  let finish!: (value: ResearchEvidence) => void;
  vi.spyOn(researchAPI, "getSource").mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const open = vi.fn();
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={open} />,
  );
  const button = view.host.querySelector(
    '[aria-label="来源 1"]',
  ) as HTMLButtonElement;
  await act(async () => button.click());
  await act(async () => resetResearchLibrary());
  await act(async () => finish(evidence));
  expect(open).not.toHaveBeenCalled();
});
it("keeps the old report after a failed new run and saves edits as a separate safe revision", async () => {
  const original = {
    ...report,
    stale: true,
    content:
      "历史报告\n\n<script>window.evil=1</script>\n\n![remote](https://example.org/track.png)",
  };
  let revisions = [original];
  vi.mocked(researchAPI.listReports).mockImplementation(async () => revisions);
  vi.mocked(researchAPI.getRun).mockResolvedValue({
    ...run,
    status: "failed",
    error: "模型失败",
  });
  const revise = vi
    .spyOn(researchAPI, "reviseReport")
    .mockImplementation(async (_id, input) => {
      const next = {
        ...original,
        id: "edited",
        revision: "v2",
        origin: "user" as const,
        derivedFromId: original.id,
        content: input.content,
      };
      revisions = [original, next];
      return next;
    });
  const markdown = vi
    .spyOn(researchAPI, "markdown")
    .mockResolvedValue("# 用户笔记\n<script>alert(1)</script>");
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "新的研究");
  await click(view.host, "开始研究");
  expect(view.host.textContent).toContain("模型失败");
  expect(view.host.textContent).toContain("历史报告");
  expect(view.host.querySelector("script,img")).toBeNull();
  await click(view.host, "编辑报告");
  await type(view.host, "用户笔记", "编辑研究报告");
  await click(view.host, "保存新版本");
  expect(revise).toHaveBeenCalledWith(
    "report",
    expect.objectContaining({
      content: "用户笔记",
      requestId: expect.stringMatching(/^[a-f0-9]{32}$/),
    }),
    expect.any(AbortSignal),
  );
  expect(view.host.textContent).toContain("用户编辑版本");
  expect(original.content).toContain("历史报告");
  expect(revisions).toHaveLength(2);
  await click(view.host, "导出 Markdown");
  expect(markdown).toHaveBeenCalledWith("edited", expect.any(AbortSignal));
  expect(view.host.querySelector("script,img")).toBeNull();
  expect(
    (
      view.host.querySelector(
        '[aria-label="导出 Markdown 内容"]',
      ) as HTMLTextAreaElement
    ).value,
  ).toContain("<script>alert(1)</script>");
});
it("reuses an uncertain candidate import request after leaving and returning to the topic", async () => {
  const candidate = {
    id: "candidate",
    topicId: "topic",
    identityKey: "doi:10/test",
    title: "重试论文",
    authors: "A",
    doi: "10/test",
    arxiv: "",
    publishedAt: "2026",
    updatedAt: "",
    abstract: "摘要",
    landingUrl: "https://example.org",
    pdfUrl: "",
    aliases: [],
  };
  vi.mocked(researchAPI.listCandidates).mockImplementation(async (topic) =>
    topic === "topic" ? [candidate] : [],
  );
  const imported = vi
    .spyOn(researchAPI, "importCandidate")
    .mockRejectedValue(new Error("响应丢失"));
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await click(view.host, "导入重试论文");
  const requestId = imported.mock.calls[0][2];
  await render(
    view.root,
    <ResearchPanel topicId="other" onOpenDocument={async () => {}} />,
  );
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await click(view.host, "导入重试论文");
  expect(imported.mock.calls[1][2]).toBe(requestId);
  expect(imported).toHaveBeenCalledTimes(2);
});
