// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, researchAPI } from "@interleaf/api";
import { paper } from "../papers/fixtures";
import { ResearchPanel } from "./ResearchPanel";
import { ResearchReport } from "./ResearchReport";
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
import type { ResearchEvidence } from "@interleaf/core";
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
it.each(["markdown", "revision"])(
  "releases an aborted %s owner without letting its late completion unlock the next session",
  async (kind) => {
    const old = deferred<typeof report>();
    const exportOld = deferred<string>();
    const exportNew = deferred<string>();
    let oldSignal: AbortSignal | undefined;
    vi.spyOn(researchAPI, "markdown").mockImplementation(async (id, signal) => {
      if (id === "report") {
        oldSignal = signal;
        return exportOld.promise;
      }
      return exportNew.promise;
    });
    const revise = vi
      .spyOn(researchAPI, "reviseReport")
      .mockImplementation(async (_id, _input, signal) => {
        oldSignal = signal;
        return old.promise;
      });
    const saved = vi.fn();
    const other = {
      ...report,
      id: "other-report",
      sessionId: "other-session",
      content: "另一会话报告",
    };
    const editor = (reports: (typeof report)[]) => (
      <ResearchReport
        topicId="topic"
        reports={reports}
        onOpenDocument={async () => {}}
        onSaved={saved}
      />
    );
    await render(view.root, editor([report]));
    if (kind === "markdown") await click(view.host, "导出 Markdown");
    else {
      await click(view.host, "编辑报告");
      await type(view.host, "未确认保存笔记", "编辑研究报告");
      await click(view.host, "保存新版本");
    }
    await render(view.root, editor([other]));
    expect(oldSignal?.aborted).toBe(true);
    const button = () =>
      Array.from(view.host.querySelectorAll("button")).find(
        (button) => button.textContent === "导出 Markdown",
      )!;
    expect(button().disabled).toBe(false);
    await click(view.host, "导出 Markdown");
    expect(button().disabled).toBe(true);
    await act(async () => {
      if (kind === "markdown") exportOld.resolve("旧会话导出");
      else
        old.resolve({
          ...report,
          id: "old-revision",
          origin: "user",
          content: "旧保存回包",
        });
    });
    await flush();
    expect(button().disabled).toBe(true);
    expect(view.host.textContent).not.toContain("旧保存回包");
    expect(saved).not.toHaveBeenCalled();
    await act(async () => exportNew.resolve("新会话导出"));
    await flush();
    expect(button().disabled).toBe(false);
    expect(
      (
        view.host.querySelector(
          '[aria-label="导出 Markdown 内容"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("新会话导出");
    if (kind === "revision") {
      const requestId = revise.mock.calls[0][1].requestId;
      await render(view.root, editor([report]));
      await click(view.host, "编辑报告");
      await click(view.host, "保存新版本");
      expect(revise.mock.calls[1][1].requestId).toBe(requestId);
    }
  },
);
it("keeps an in-progress edit and its base when SSE completion appends a model report", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let reports = [report];
  const newer = {
    ...report,
    id: "new-model",
    revision: "model-v2",
    content: "后台新模型报告",
  };
  vi.mocked(researchAPI.listMessages).mockResolvedValue([
    {
      id: "m",
      sessionId: "session",
      runId: "run",
      role: "user",
      content: "背景研究",
      createdAt: "2026",
    },
  ]);
  vi.mocked(researchAPI.listReports).mockImplementation(async () => reports);
  vi.mocked(researchAPI.events).mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
      ),
  );
  const revise = vi
    .spyOn(researchAPI, "reviseReport")
    .mockImplementation(async (_id, input) => {
      const edited = {
        ...report,
        id: "edited",
        origin: "user" as const,
        content: input.content,
        derivedFromId: report.id,
      };
      reports = [...reports, edited];
      return edited;
    });
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await click(view.host, "编辑报告");
  await type(view.host, "尚未保存的用户研究笔记", "编辑研究报告");
  reports = [{ ...report }, newer];
  vi.mocked(researchAPI.getRun).mockResolvedValue({
    ...run,
    status: "completed",
    latestReportId: newer.id,
  });
  await act(async () =>
    stream.enqueue(
      new TextEncoder().encode(
        'id: 10\nevent: done\ndata: {"ok":true,"reportId":"new-model"}\n\n',
      ),
    ),
  );
  await flush();
  expect(
    (
      view.host.querySelector(
        '[aria-label="编辑研究报告"]',
      ) as HTMLTextAreaElement
    )?.value,
  ).toBe("尚未保存的用户研究笔记");
  expect(
    view.host.querySelector('[aria-label="历史版本"]')?.textContent,
  ).toContain("历史版本 1");
  await click(view.host, "保存新版本");
  expect(revise).toHaveBeenCalledWith(
    "report",
    expect.objectContaining({ content: "尚未保存的用户研究笔记" }),
    expect.any(AbortSignal),
  );
  expect(reports.map((report) => report.id)).toEqual([
    "report",
    "new-model",
    "edited",
  ]);
  expect(newer.content).toBe("后台新模型报告");
});
it("restores unsaved report drafts after explicit session navigation", async () => {
  const other = {
    ...report,
    id: "other-report",
    sessionId: "other-session",
    content: "另一会话",
  };
  const editor = (reports: (typeof report)[]) => (
    <ResearchReport
      topicId="topic"
      reports={reports}
      onOpenDocument={async () => {}}
      onSaved={() => {}}
    />
  );
  await render(view.root, editor([report]));
  await click(view.host, "编辑报告");
  await type(view.host, "保留到返回时的草稿", "编辑研究报告");
  await render(view.root, editor([other]));
  await click(view.host, "编辑报告");
  await type(view.host, "第二会话草稿", "编辑研究报告");
  await render(view.root, editor([report]));
  await click(view.host, "编辑报告");
  expect(
    (
      view.host.querySelector(
        '[aria-label="编辑研究报告"]',
      ) as HTMLTextAreaElement
    )?.value,
  ).toBe("保留到返回时的草稿");
});
it("retains separate drafts when the user selects another historical version", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const newer = { ...report, id: "newer", revision: "v2", content: "较新报告" };
  const revise = vi
    .spyOn(researchAPI, "reviseReport")
    .mockResolvedValue(report);
  await render(
    view.root,
    <ResearchReport
      topicId="topic"
      reports={[report, newer]}
      onOpenDocument={async () => {}}
      onSaved={() => {}}
    />,
  );
  const choose = async (index: number) => {
    await click(view.host, "历史版本");
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    expect(options).toHaveLength(2);
    await act(async () => {
      options[index].dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
      options[index].click();
    });
    await flush();
    expect(
      view.host.querySelector('[aria-label="历史版本"]')?.textContent,
    ).toContain(`历史版本 ${index + 1}`);
  };
  await choose(0);
  await click(view.host, "编辑报告");
  await type(view.host, "原版草稿", "编辑研究报告");
  await choose(1);
  await click(view.host, "编辑报告");
  await type(view.host, "新版草稿", "编辑研究报告");
  await choose(0);
  await click(view.host, "编辑报告");
  expect(
    (
      view.host.querySelector(
        '[aria-label="编辑研究报告"]',
      ) as HTMLTextAreaElement
    ).value,
  ).toBe("原版草稿");
  expect(revise).not.toHaveBeenCalled();
});
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

it("shows the validated source's readable paper identity", async () => {
  vi.mocked(researchAPI.listReports).mockResolvedValue([
    { ...report, sourceIds: [evidence.id] },
  ]);
  vi.spyOn(researchAPI, "getSource").mockResolvedValue({
    ...evidence,
    paperId: "paper-a",
  });
  vi.spyOn(api, "paper").mockResolvedValue(
    { ...paper({
      id: "paper-a",
      title: "Uncertainty graph study",
      citationKey: "Graph2026",
    }), primaryDocumentId: "pdf-doc", citationKey: "Graph2026", attachments: [] },
  );
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await click(view.host, "来源 1");
  expect(view.host.textContent).toContain("Uncertainty graph study");
  expect(view.host.textContent).toContain("Graph2026");
});

it("shows remote provenance without fetching the public paper", async () => {
  vi.mocked(researchAPI.listReports).mockResolvedValue([
    { ...report, sourceIds: [evidence.id] },
  ]);
  vi.spyOn(researchAPI, "getSource").mockResolvedValue({
    ...evidence,
    documentId: undefined,
    kind: "remote-abstract",
    candidateId: "candidate",
  });
  vi.mocked(researchAPI.listCandidates).mockResolvedValue([
    {
      id: "candidate",
      topicId: "topic",
      identityKey: "doi:10.1000/provenance",
      title: "Remote graph study",
      authors: "Fixture",
      doi: "10.1000/provenance",
      arxiv: "",
      publishedAt: "2026",
      updatedAt: "",
      abstract: "Abstract",
      landingUrl: "https://example.org/paper",
      pdfUrl: "",
      aliases: [],
    },
  ]);
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await click(view.host, "来源 1");
  const provenance = view.host.querySelector('[aria-label="来源出处"]');
  expect(provenance?.textContent).toContain("Remote graph study");
  expect(provenance?.textContent).toContain("10.1000/provenance");
  expect(provenance?.textContent).toContain("https://example.org/paper");
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
