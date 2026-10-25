// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { researchAPI } from "@reader/api";
import { ResearchPanel } from "./ResearchPanel";
import { ResearchNavigation } from "./ResearchNavigation";
import { usePaperUI } from "../papers/state";
import {
  click,
  mockAPI,
  mount,
  render,
  results,
  report,
  run,
  type,
} from "./test-helpers";
import { researchStore, resetResearchLibrary } from "./research-session";
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
  vi.useRealTimers();
});

const checkpoint = {
  ...results,
  partialIdeas: [
    {
      id: "checkpoint",
      problem: "运行中阶段想法",
      mechanism: "机制",
      basis: [],
      hypotheses: [],
      changes: [],
      nearestWorkIds: [],
      minimumExperiment: "实验",
      baselines: [],
      ablations: [],
      falsification: "证伪",
      resources: "",
      claims: [],
    },
  ],
  batches: [
    {
      stage: "ideas" as const,
      done: 3,
      total: 11,
      completedBatches: 1,
      sources: [],
    },
  ],
};
it.each(["run", "results", "refresh"])(
  "fences a delayed same-run %s batch behind terminal SSE results",
  async (stage) => {
    const initialMessage = {
      id: "m",
      sessionId: "session",
      runId: "run",
      role: "user" as const,
      content: "研究",
      createdAt: "2026",
    };
    vi.mocked(researchAPI.listMessages).mockResolvedValue([initialMessage]);
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
    vi.useFakeTimers();
    await act(async () =>
      view.root.render(
        <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
      ),
    );
    const oldResults = { ...checkpoint, pendingIdeaIds: ["old-pending-idea"] };
    const oldReport = { ...report, id: "old-report", content: "旧批次报告" };
    let finishRun!: (value: typeof run) => void,
      finishResults!: (value: typeof oldResults) => void,
      finishRefresh!: (value: (typeof report)[]) => void;
    if (stage === "run")
      vi.mocked(researchAPI.getRun).mockImplementationOnce(
        async () => new Promise((resolve) => (finishRun = resolve)),
      );
    if (stage === "results")
      vi.mocked(researchAPI.getResults).mockImplementationOnce(
        async () => new Promise((resolve) => (finishResults = resolve)),
      );
    if (stage === "refresh")
      vi.mocked(researchAPI.listReports).mockImplementationOnce(
        async () => new Promise((resolve) => (finishRefresh = resolve)),
      );
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(
      stage === "run"
        ? finishRun
        : stage === "results"
          ? finishResults
          : finishRefresh,
    ).toBeTypeOf("function");
    vi.mocked(researchAPI.getRun).mockResolvedValue({
      ...run,
      status: "completed",
      phase: "checking",
      done: 3,
      latestReportId: "final-report",
      coverage: { ...run.coverage, pendingPapers: 0 },
    });
    vi.mocked(researchAPI.getResults).mockResolvedValue({
      ...results,
      ideas: [
        {
          ...checkpoint.partialIdeas[0],
          id: "final-idea",
          problem: "最终想法",
        },
      ],
      batches: [
        {
          stage: "ideas",
          done: 11,
          total: 11,
          completedBatches: 4,
          sources: [],
        },
      ],
      novelty: [
        {
          ideaId: "final-idea",
          asOf: "2026",
          coverage: run.coverage,
          queryIds: [],
          caveats: [],
          rows: [
            {
              claimId: "claim",
              status: "not_found",
              relatedWorkIds: [],
              evidenceIds: [],
              overlap: "",
              difference: "完成核查",
              unverified: "",
            },
          ],
        },
      ],
    });
    vi.mocked(researchAPI.listReports).mockResolvedValue([
      { ...report, id: "final-report", content: "最终报告" },
    ]);
    vi.mocked(researchAPI.listCandidates).mockResolvedValue([
      {
        id: "final-candidate",
        topicId: "topic",
        identityKey: "doi:10/final",
        title: "最终候选",
        authors: "A",
        doi: "10/final",
        arxiv: "",
        publishedAt: "2026",
        updatedAt: "2026",
        abstract: "摘要",
        landingUrl: "",
        pdfUrl: "",
        aliases: [],
      },
    ]);
    vi.mocked(researchAPI.listSearches).mockResolvedValue([
      {
        id: "final-search",
        runId: "run",
        query: "最终查询",
        source: "arxiv",
        filters: {},
        status: "ok",
        candidateIds: [],
        fetchedAt: "2026",
      },
    ]);
    vi.mocked(researchAPI.listMessages).mockResolvedValue([
      initialMessage,
      {
        ...initialMessage,
        id: "final-answer",
        role: "assistant",
        content: "最终回答",
      },
    ]);
    await act(async () => {
      stream.enqueue(
        new TextEncoder().encode('id: 10\nevent: done\ndata: {"ok":true}\n\n'),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    const store = researchStore("topic");
    const assertFinal = () => {
      const state = store.snapshot();
      expect(state.run?.status).toBe("completed");
      expect(state.results?.pendingIdeaIds).toEqual([]);
      expect(state.results?.partialIdeas).toEqual([]);
      expect(state.results?.ideas[0]?.id).toBe("final-idea");
      expect(state.results?.novelty[0]?.rows[0]?.status).toBe("not_found");
      expect(state.results?.batches[0]?.done).toBe(11);
      expect(state.reports[0]?.id).toBe("final-report");
      expect(state.candidates[0]?.id).toBe("final-candidate");
      expect(state.searches[0]?.id).toBe("final-search");
      expect(state.messages[1]?.id).toBe("final-answer");
    };
    assertFinal();
    expect(view.host.textContent).toContain("最终想法");
    expect(view.host.textContent).toContain("最终报告");
    const reads = {
      results: vi.mocked(researchAPI.getResults).mock.calls.length,
      reports: vi.mocked(researchAPI.listReports).mock.calls.length,
    };
    // Any further stage of the old batch must be fenced, even if a mock ignores
    // abort and a later GET would return an older cached report/message payload.
    vi.mocked(researchAPI.listReports).mockResolvedValue([oldReport]);
    vi.mocked(researchAPI.listCandidates).mockResolvedValue([]);
    vi.mocked(researchAPI.listSearches).mockResolvedValue([]);
    vi.mocked(researchAPI.listMessages).mockResolvedValue([initialMessage]);
    await act(async () => {
      if (stage === "run") finishRun(run);
      else if (stage === "results") finishResults(oldResults);
      else finishRefresh([oldReport]);
    });
    assertFinal();
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    assertFinal();
    expect(researchAPI.getResults).toHaveBeenCalledTimes(reads.results);
    expect(researchAPI.listReports).toHaveBeenCalledTimes(reads.reports);
    expect(researchAPI.events).toHaveBeenCalledTimes(1);
    expect(researchAPI.createRun).not.toHaveBeenCalled();
    expect(researchAPI.controlRun).not.toHaveBeenCalled();
  },
);
it("refreshes checkpoints over one healthy SSE and stops read polling on unmount", async () => {
  vi.mocked(researchAPI.listMessages).mockResolvedValue([
    {
      id: "m",
      sessionId: "session",
      runId: "run",
      role: "user",
      content: "后台研究",
      createdAt: "2026",
    },
  ]);
  vi.useFakeTimers();
  await act(async () =>
    view.root.render(
      <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
    ),
  );
  expect(researchAPI.events).toHaveBeenCalledTimes(1);
  vi.mocked(researchAPI.getRun).mockResolvedValue({
    ...run,
    phase: "checking",
    done: 2,
  });
  vi.mocked(researchAPI.getResults).mockResolvedValue(checkpoint);
  vi.mocked(researchAPI.listSearches).mockResolvedValue([
    {
      id: "query",
      runId: "run",
      query: "新批次检索",
      source: "arxiv",
      filters: {},
      status: "ok",
      candidateIds: [],
      fetchedAt: "2026",
    },
  ]);
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(view.host.textContent).toContain("核查主张");
  expect(view.host.textContent).toContain("证据片段 3 / 11");
  expect(view.host.textContent).toContain("运行中阶段想法");
  expect(view.host.textContent).toContain("新批次检索");
  expect(researchAPI.events).toHaveBeenCalledTimes(1);
  expect(researchAPI.createRun).not.toHaveBeenCalled();
  expect(researchAPI.controlRun).not.toHaveBeenCalled();
  await act(async () => view.root.render(null));
  const reads = vi.mocked(researchAPI.getRun).mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(researchAPI.getRun).toHaveBeenCalledTimes(reads);
});
it.each(["session", "library", "run"])(
  "aborts and ignores a delayed checkpoint after %s ownership changes",
  async (owner) => {
    vi.mocked(researchAPI.listMessages).mockImplementation(async (sid) =>
      sid === "session"
        ? [
            {
              id: "m",
              sessionId: sid,
              runId: "run",
              role: "user",
              content: "研究",
              createdAt: "2026",
            },
          ]
        : [],
    );
    vi.useFakeTimers();
    await act(async () =>
      view.root.render(
        <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
      ),
    );
    let finish!: (value: typeof checkpoint) => void;
    let readSignal: AbortSignal | undefined;
    if (owner === "run")
      vi.mocked(researchAPI.getRun).mockResolvedValue({
        ...run,
        status: "completed",
      });
    vi.mocked(researchAPI.getResults).mockImplementationOnce(
      async (_id, signal) => {
        readSignal = signal;
        return new Promise((resolve) => (finish = resolve));
      },
    );
    const calls = vi.mocked(researchAPI.getResults).mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(researchAPI.getResults).toHaveBeenCalledTimes(calls + 1);
    expect(readSignal).toBeDefined();
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(researchAPI.getResults).toHaveBeenCalledTimes(calls + 1);
    if (owner === "session")
      await act(async () => researchStore("topic").selectSession("empty"));
    else if (owner === "library") {
      vi.mocked(researchAPI.listMessages).mockResolvedValue([]);
      await act(async () => resetResearchLibrary());
    } else {
      vi.mocked(researchAPI.createRun).mockResolvedValue({
        ...run,
        id: "new-run",
      });
      vi.mocked(researchAPI.controlRun).mockResolvedValue({
        ...run,
        id: "new-run",
      });
      vi.mocked(researchAPI.getRun).mockImplementation(async (id) => ({
        ...run,
        id,
      }));
      await type(view.host, "新任务");
      const button = Array.from(view.host.querySelectorAll("button")).find(
        (button) => button.textContent === "开始研究",
      )!;
      await act(async () => button.click());
      expect(researchStore("topic").snapshot().run?.id).toBe("new-run");
    }
    expect(readSignal?.aborted).toBe(true);
    await act(async () => finish(checkpoint));
    expect(view.host.textContent).not.toContain("运行中阶段想法");
    if (owner !== "run") {
      const reads = vi.mocked(researchAPI.getRun).mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(6000));
      expect(researchAPI.getRun).toHaveBeenCalledTimes(reads);
      expect(researchAPI.createRun).not.toHaveBeenCalled();
      expect(researchAPI.controlRun).not.toHaveBeenCalled();
    } else {
      expect(researchAPI.createRun).toHaveBeenCalledTimes(1);
      expect(researchAPI.controlRun).toHaveBeenCalledTimes(1);
    }
  },
);
it("switches topics without mixing evidence or canceling explicit background work", async () => {
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "后台综述");
  await click(view.host, "开始研究");
  const signal = vi.mocked(researchAPI.events).mock.calls[0]?.[2];
  expect(signal?.aborted).toBe(false);
  await render(
    view.root,
    <ResearchPanel topicId="other" onOpenDocument={async () => {}} />,
  );
  expect(signal?.aborted).toBe(true);
  expect(researchAPI.controlRun).not.toHaveBeenCalledWith(
    "run",
    "cancel",
    expect.anything(),
    expect.anything(),
  );
  expect(view.host.textContent).not.toContain("后台综述");
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  expect(view.host.textContent).toContain("后台综述");
  expect(researchAPI.createRun).toHaveBeenCalledTimes(1);
  await click(view.host, "取消研究");
  expect(researchAPI.controlRun).toHaveBeenLastCalledWith(
    run.id,
    "cancel",
    expect.objectContaining({
      requestId: expect.stringMatching(/^[a-f0-9]{32}$/),
    }),
    expect.any(AbortSignal),
  );
});
it("rejects a late create response after library migration and does not start it", async () => {
  let finish!: (value: typeof run) => void;
  vi.mocked(researchAPI.createRun).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "旧库问题");
  const button = Array.from(view.host.querySelectorAll("button")).find(
    (b) => b.textContent === "开始研究",
  )!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(researchAPI.createRun).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(researchAPI.createRun).mock.calls[0][3];
  await act(async () => resetResearchLibrary());
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(run));
  expect(researchAPI.controlRun).not.toHaveBeenCalled();
  expect(view.host.textContent).not.toContain("旧库问题");
});
it("subscribes to an existing saved run without creating or starting work", async () => {
  vi.mocked(researchAPI.listMessages).mockResolvedValue([
    {
      id: "message",
      sessionId: "session",
      runId: "run",
      role: "user",
      content: "保存的问题",
      createdAt: "2026",
    },
  ]);
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  expect(view.host.textContent).toContain("保存的问题");
  expect(researchAPI.events).toHaveBeenCalledWith(
    "run",
    0,
    expect.any(AbortSignal),
  );
  expect(researchAPI.createRun).not.toHaveBeenCalled();
  expect(researchAPI.controlRun).not.toHaveBeenCalled();
});
it("can explicitly cancel while the start response is still pending", async () => {
  vi.mocked(researchAPI.createRun).mockResolvedValue({
    ...run,
    status: "preparing",
  });
  vi.mocked(researchAPI.controlRun).mockImplementation(async (_id, action) =>
    action === "start" ? new Promise(() => {}) : { ...run, status: "canceled" },
  );
  vi.mocked(researchAPI.getRun).mockResolvedValue({
    ...run,
    status: "canceled",
  });
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await type(view.host, "等待启动");
  await click(view.host, "开始研究");
  await click(view.host, "取消研究");
  expect(researchAPI.controlRun).toHaveBeenCalledWith(
    "run",
    "cancel",
    expect.anything(),
    expect.any(AbortSignal),
  );
  expect(view.host.textContent).toContain("已取消");
});
it("ignores an old run result resolving after a new run in the same session", async () => {
  let finish!: (
    value: Awaited<ReturnType<typeof researchAPI.getResults>>,
  ) => void;
  let reads = 0;
  vi.mocked(researchAPI.listMessages).mockResolvedValue([
    {
      id: "m",
      sessionId: "session",
      runId: "old",
      role: "user",
      content: "旧问题",
      createdAt: "2026",
    },
  ]);
  vi.mocked(researchAPI.getRun).mockImplementation(async (id) => ({
    ...run,
    id,
    status: id === "old" ? "completed" : "running",
  }));
  vi.mocked(researchAPI.getResults).mockImplementation(async (id) => {
    if (id === "old" && ++reads === 2)
      return new Promise((resolve) => (finish = resolve));
    return {
      ideas: [],
      partialIdeas: [],
      novelty: [],
      queries: [],
      pendingIdeaIds: [],
      batches: [],
      capability: "text-search-assistance",
    };
  });
  vi.mocked(researchAPI.createRun).mockResolvedValue({ ...run, id: "new" });
  vi.mocked(researchAPI.controlRun).mockResolvedValue({ ...run, id: "new" });
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await act(async () => {
    void researchStore("topic").recover();
  });
  await type(view.host, "新问题");
  await click(view.host, "开始研究");
  await act(async () =>
    finish({
      ideas: [],
      partialIdeas: [
        {
          id: "old-idea",
          problem: "过期想法",
          mechanism: "旧机制",
          hypotheses: [],
          changes: [],
          nearestWorkIds: [],
          minimumExperiment: "",
          baselines: [],
          ablations: [],
          falsification: "",
          resources: "",
          claims: [],
          basis: [],
        },
      ],
      novelty: [],
      queries: [],
      pendingIdeaIds: [],
      batches: [],
      capability: "text-search-assistance",
    }),
  );
  expect(view.host.textContent).not.toContain("过期想法");
  expect(researchStore("topic").snapshot().run?.id).toBe("new");
});
it("clears the previous session run and evidence when switching to an empty session", async () => {
  vi.mocked(researchAPI.listSessions).mockResolvedValue([
    {
      id: "session",
      topicId: "topic",
      title: "一",
      networkAllowed: false,
      createdAt: "2026",
      updatedAt: "2026",
    },
    {
      id: "empty",
      topicId: "topic",
      title: "二",
      networkAllowed: false,
      createdAt: "2026",
      updatedAt: "2026",
    },
  ]);
  vi.mocked(researchAPI.listMessages).mockImplementation(async (sid) =>
    sid === "session"
      ? [
          {
            id: "m",
            sessionId: sid,
            runId: "run",
            role: "user",
            content: "旧会话",
            createdAt: "2026",
          },
        ]
      : [],
  );
  vi.mocked(researchAPI.getResults).mockResolvedValue({
    ideas: [],
    partialIdeas: [
      {
        id: "partial",
        problem: "旧会话证据",
        mechanism: "机制",
        hypotheses: [],
        changes: [],
        nearestWorkIds: [],
        minimumExperiment: "",
        baselines: [],
        ablations: [],
        falsification: "",
        resources: "",
        claims: [],
        basis: [],
      },
    ],
    novelty: [],
    queries: [],
    pendingIdeaIds: [],
    batches: [],
    capability: "text-search-assistance",
  });
  await render(
    view.root,
    <ResearchPanel topicId="topic" onOpenDocument={async () => {}} />,
  );
  await act(async () => researchStore("topic").selectSession("session"));
  expect(view.host.textContent).toContain("旧会话证据");
  await act(async () => researchStore("topic").selectSession("empty"));
  expect(view.host.textContent).not.toContain("旧会话证据");
  expect(view.host.querySelector('[aria-label="研究进度"]')).toBeNull();
  expect(researchStore("topic").snapshot().run).toBeUndefined();
});
it("keeps multiple background topics discoverable with read-only status queries", async () => {
  vi.spyOn(researchAPI, "listTopics").mockResolvedValue(
    ["topic", "other"].map((id) => ({
      id,
      title: "同名主题",
      folder: id,
      includeChildren: true,
      networkAllowed: false,
      scopeState: "active",
      createdAt: "2026",
      updatedAt: "2026",
    })),
  );
  vi.mocked(researchAPI.listMessages).mockImplementation(async (sid) => [
    {
      id: `m-${sid}`,
      sessionId: sid,
      runId: sid === "session" ? "run" : "other-run",
      role: "user",
      content: "后台工作",
      createdAt: "2026",
    },
  ]);
  vi.mocked(researchAPI.getRun).mockImplementation(async (id) =>
    id === "run"
      ? run
      : {
          ...run,
          id,
          topicId: "other",
          sessionId: "other-session",
          status: "paused",
        },
  );
  await render(view.root, <ResearchNavigation />);
  expect(view.host.textContent).toContain("研究中");
  expect(view.host.textContent).toContain("已暂停");
  const second = Array.from(view.host.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("已暂停"),
  )!;
  await act(async () => second.click());
  expect(usePaperUI.getState().researchTopicId).toBe("other");
  expect(researchAPI.createRun).not.toHaveBeenCalled();
  expect(researchAPI.controlRun).not.toHaveBeenCalled();
});
