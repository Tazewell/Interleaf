// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, researchAPI } from "@interleaf/api";
import { ResearchPanel } from "./ResearchPanel";
import {
  click,
  flush,
  mockAPI,
  mount,
  render,
  report,
  results,
  run,
  type,
} from "./test-helpers";
import { useReaderStore } from "../store";
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
it("sends once and recovers the same research after start response loss", async () => {
  vi.mocked(researchAPI.controlRun).mockRejectedValue(new Error("连接断开"));
  vi.mocked(researchAPI.getRun).mockResolvedValue({
    ...run,
    status: "completed",
    latestReportId: "report",
  });
  vi.mocked(researchAPI.listReports).mockResolvedValue([report]);
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "综述这组论文");
  await click(view.host, "开始研究");
  await flush();
  expect(view.host.textContent).toContain("已保存的研究报告");
  expect(researchAPI.createRun).toHaveBeenCalledTimes(1);
  expect(researchAPI.controlRun).toHaveBeenCalledTimes(1);
  expect(researchAPI.getRun).toHaveBeenCalledWith(
    "run",
    expect.any(AbortSignal),
  );
});
it("deduplicates SSE sequences and recovers a dropped done by GET only", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
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
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "测试流");
  await click(view.host, "开始研究");
  await act(async () =>
    stream.enqueue(
      new TextEncoder().encode(
        'id: 1\nevent: delta\ndata: {"text":"唯一片段"}\n\nid: 1\nevent: delta\ndata: {"text":"唯一片段"}\n\n',
      ),
    ),
  );
  await flush();
  expect(view.host.textContent?.match(/唯一片段/g)).toHaveLength(1);
  vi.mocked(researchAPI.getRun).mockResolvedValue({
    ...run,
    status: "completed",
    latestReportId: "report",
  });
  vi.mocked(researchAPI.listReports).mockResolvedValue([report]);
  await act(async () => stream.close());
  await flush();
  expect(view.host.textContent).toContain("已保存的研究报告");
  expect(view.host.textContent).toContain("已完成");
  expect(researchAPI.createRun).toHaveBeenCalledTimes(1);
  expect(researchAPI.controlRun).toHaveBeenCalledTimes(1);
});
it("applies a reset snapshot sharing the last sequence without POST replay", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
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
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "测试重置");
  await click(view.host, "开始研究");
  await act(async () =>
    stream.enqueue(
      new TextEncoder().encode(
        'id: 4\nevent: delta\ndata: {"text":"片段"}\n\n',
      ),
    ),
  );
  await flush();
  vi.mocked(researchAPI.getRun).mockResolvedValue({
    ...run,
    status: "paused",
    limitReason: "模型请求预算",
    coverage: { ...run.coverage, pendingPapers: 2 },
  });
  await act(async () =>
    stream.enqueue(
      new TextEncoder().encode(
        `id: 4\nevent: reset\ndata: ${JSON.stringify({ run: { ...run, status: "paused", limitReason: "模型请求预算", coverage: { ...run.coverage, pendingPapers: 2 } } })}\n\n`,
      ),
    ),
  );
  await flush();
  expect(view.host.textContent).toContain("剩余 2 篇");
  expect(view.host.textContent).toContain(
    "继续研究（重新计本次预算并调用模型）",
  );
  expect(researchAPI.createRun).toHaveBeenCalledTimes(1);
  expect(researchAPI.controlRun).toHaveBeenCalledTimes(1);
});
it("sends an explicit online action with allow-task and ordinary research with inherit", async () => {
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "找相关论文");
  await click(view.host, "联网找论文");
  expect(researchAPI.createRun).toHaveBeenCalledWith(
    "topic",
    "session",
    expect.objectContaining({ network: "allow-task", mode: "question" }),
    expect.any(AbortSignal),
  );
});
it("offers query retry without replaying a POST when recovery also fails", async () => {
  vi.mocked(researchAPI.controlRun).mockRejectedValue(new Error("连接断开"));
  vi.mocked(researchAPI.getRun).mockRejectedValue(new Error("查询失败"));
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "综述");
  await click(view.host, "开始研究");
  expect(view.host.textContent).toContain("查询失败");
  vi.mocked(researchAPI.getRun).mockResolvedValue({
    ...run,
    status: "completed",
  });
  await click(view.host, "重试查询");
  expect(researchAPI.createRun).toHaveBeenCalledTimes(1);
  expect(researchAPI.controlRun).toHaveBeenCalledTimes(1);
});
it.each(["rejected", "disconnect", "ambiguous"])(
  "handles %s create through real transport without automatic replay",
  async (kind) => {
    vi.mocked(researchAPI.createRun).mockRestore();
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        posts++;
        if (posts > 1)
          return new Response(
            JSON.stringify({
              ...run,
              userMessageId: JSON.parse(init.body).userMessageId,
            }),
          );
        if (kind === "disconnect") throw new TypeError("network disconnected");
        return new Response(
          JSON.stringify({
            error: "请先允许本次任务联网",
            ...(kind === "rejected"
              ? { code: "research_create_rejected" }
              : {}),
          }),
          { status: kind === "rejected" ? 400 : 500 },
        );
      }),
    );
    await render(
      view.root,
      <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
    );
    await type(view.host, "https://example.org/paper");
    await click(view.host, "开始研究");
    expect(posts).toBe(1);
    expect(researchAPI.controlRun).not.toHaveBeenCalled();
    if (kind === "rejected") {
      expect(
        (
          view.host.querySelector(
            'textarea[aria-label="研究问题"]',
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("https://example.org/paper");
      expect(view.host.textContent).toContain("请先允许本次任务联网");
      await click(view.host, "联网找论文");
      expect(posts).toBe(2);
      expect(researchAPI.controlRun).toHaveBeenCalledTimes(1);
    } else {
      await click(view.host, "重试查询");
      await type(view.host, "新问题");
      await click(view.host, "开始研究");
      expect(posts).toBe(1);
      expect(researchAPI.controlRun).not.toHaveBeenCalled();
    }
  },
);
it("recovers a lost create response by matching the run userMessageId, not the saved message id", async () => {
  let requestId = "";
  vi.mocked(researchAPI.createRun).mockImplementation(
    async (_topic, _session, input) => {
      requestId = input.userMessageId;
      throw new Error("创建响应丢失");
    },
  );
  vi.mocked(researchAPI.listMessages).mockImplementation(async () =>
    requestId
      ? [
          {
            id: "server-message-id",
            sessionId: "session",
            runId: "created-run",
            role: "user",
            content: "创建丢失问题",
            createdAt: "2026",
          },
        ]
      : [],
  );
  vi.mocked(researchAPI.getRun).mockImplementation(async (id) => ({
    ...run,
    id,
    userMessageId: requestId,
    status: "preparing",
  }));
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "创建丢失问题");
  await click(view.host, "开始研究");
  expect(view.host.textContent).toContain("开始已创建任务");
  expect(researchAPI.getRun).toHaveBeenCalledWith(
    "created-run",
    expect.any(AbortSignal),
  );
  expect(researchAPI.createRun).toHaveBeenCalledTimes(1);
  expect(researchAPI.controlRun).not.toHaveBeenCalled();
});
it.each(["empty", "metadata", "failed"])(
  "offers an actionable %s scope while keeping honest coverage",
  async (kind) => {
    const total = kind === "empty" ? 0 : 3;
    vi.mocked(researchAPI.listMessages).mockResolvedValue([
      {
        id: "message",
        sessionId: "session",
        runId: "run",
        role: "user",
        content: "综述",
        createdAt: "2026",
      },
    ]);
    vi.mocked(researchAPI.getRun).mockResolvedValue({
      ...run,
      status: "paused",
      coverage: {
        totalPapers: total,
        analyzedPapers: 0,
        abstractOnlyPapers: 0,
        unavailablePapers: kind === "failed" ? 3 : 0,
        pendingPapers: total,
        readUnits: 0,
        totalUnits: 0,
        readCoverage: {},
      },
    });
    await render(
      view.root,
      <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
    );
    expect(view.host.textContent).toContain(
      kind === "empty"
        ? "范围为空"
        : kind === "metadata"
          ? "补充摘要或原文"
          : "全部不可读",
    );
    expect(view.host.textContent).toContain("0 / 0");
  },
);
it("shows partial evidence batches as fragments and never offers their IDs for novelty", async () => {
  vi.mocked(researchAPI.listMessages).mockResolvedValue([
    {
      id: "message",
      sessionId: "session",
      runId: "run",
      role: "user",
      content: "想法",
      createdAt: "2026",
    },
  ]);
  vi.mocked(researchAPI.getRun).mockResolvedValue({
    ...run,
    status: "paused",
    limitReason: "模型请求预算",
  });
  vi.mocked(researchAPI.getResults).mockResolvedValue({
    ...results,
    partialIdeas: [
      {
        id: "partial",
        problem: "阶段问题",
        mechanism: "机制",
        hypotheses: [],
        changes: [],
        nearestWorkIds: [],
        minimumExperiment: "实验",
        baselines: [],
        ablations: [],
        falsification: "证伪",
        resources: "单卡",
        claims: [],
        basis: [],
      },
    ],
    pendingIdeaIds: ["unfinished"],
    batches: [
      {
        stage: "ideas",
        done: 3,
        total: 11,
        completedBatches: 1,
        sources: [{ sourceId: "source", done: 3, total: 11 }],
      },
    ],
  });
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  expect(view.host.textContent).toContain("证据片段 3 / 11");
  expect(view.host.textContent).toContain("阶段结果");
  expect(view.host.textContent).toContain("尚有 1 个想法未完成核查");
  const check = Array.from(view.host.querySelectorAll("button")).find(
    (b) => b.textContent === "联网核查此想法",
  )!;
  expect(check.disabled).toBe(true);
  await act(async () => check.click());
  expect(researchAPI.createRun).not.toHaveBeenCalled();
  await click(view.host, "继续研究（重新计本次预算并调用模型）");
  expect(researchAPI.controlRun).toHaveBeenCalledWith(
    "run",
    "resume",
    expect.objectContaining({
      budget: {
        maxModelRequests: 200,
        maxSearchRequests: 24,
        maxRemoteReads: 8,
        maxMinutes: 30,
      },
    }),
    expect.any(AbortSignal),
  );
});
it("keeps reports readable without API configuration or tool support and explains text-only coverage", async () => {
  vi.mocked(researchAPI.listReports).mockResolvedValue([report]);
  useReaderStore.setState({
    aiConfig: {
      version: 2,
      connection: { protocol: "openai", url: "", hasKey: false },
      models: {},
      efforts: {},
      apiModels: [],
    },
  });
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "研究");
  expect(view.host.textContent).toContain("请在设置中配置 API 地址");
  expect(view.host.textContent).toContain("已保存的研究报告");
  expect(
    Array.from(view.host.querySelectorAll("button")).find(
      (b) => b.textContent === "开始研究",
    )?.disabled,
  ).toBe(true);
  vi.mocked(api.agentModels).mockResolvedValue([
    {
      id: "model",
      name: "Model",
      description: "",
      isDefault: true,
      capability: {
        text: true,
        vision: false,
        tools: "unsupported",
        checkedAt: "2026",
      },
    },
  ]);
  await act(async () =>
    useReaderStore.setState({
      aiConfig: {
        version: 2,
        connection: {
          protocol: "openai",
          url: "http://localhost:1234",
          hasKey: false,
        },
        models: { chat: "model" },
        efforts: {},
        apiModels: [],
      },
    }),
  );
  await flush();
  expect(view.host.textContent).toContain("受限文字模式");
  expect(view.host.textContent).toContain("图表图片未读取");
  expect(researchAPI.createRun).not.toHaveBeenCalled();
  await click(view.host, "开始研究");
  expect(researchAPI.createRun).toHaveBeenCalledTimes(1);
  expect(researchAPI.controlRun).toHaveBeenCalledWith(
    "run",
    "start",
    expect.any(Object),
    expect.any(AbortSignal),
  );
});
it("presents native evidence ranges as pages and chapters instead of raw protocol JSON", async () => {
  vi.mocked(researchAPI.listReports).mockResolvedValue([
    {
      ...report,
      coverage: {
        ...report.coverage,
        readCoverage: {
          paper: {
            readUnits: 2,
            totalUnits: 12,
            ranges: [
              { type: "pdf", page: 7, blockId: "internal-block" },
              { type: "epub", href: "chapter-2.xhtml", progression: 0.4 },
              { type: "abstract" },
              { type: "html", paragraph: 3 },
            ],
          },
        },
      },
    },
  ]);
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  expect(view.host.textContent).toContain("PDF 第 7 页");
  expect(view.host.textContent).toContain("EPUB 章节：chapter-2.xhtml");
  expect(view.host.textContent).toContain("网页第 3 段");
  expect(view.host.textContent).not.toContain('"type"');
  expect(view.host.textContent).not.toContain("internal-block");
});
it("renders section draft content incrementally and replaces it with the final delta", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
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
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "综述");
  await click(view.host, "开始研究");
  const frame = (id: number, kind: string, data: unknown) =>
    new TextEncoder().encode(
      `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  await act(async () =>
    stream.enqueue(
      frame(1, "draft", { text: '{"content":"阶段正文', reset: true }),
    ),
  );
  await flush();
  expect(view.host.textContent).toContain("阶段正文");
  expect(view.host.textContent).not.toContain('"content"');
  await act(async () =>
    stream.enqueue(frame(2, "delta", { text: "最终报告" })),
  );
  await flush();
  expect(view.host.textContent).toContain("最终报告");
  expect(view.host.textContent).not.toContain("阶段正文");
});
