// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { researchAPI } from "@reader/api";
import { ResearchPanel } from "./ResearchPanel";
import { ResearchNavigation } from "./ResearchNavigation";
import { usePaperUI } from "../papers/state";
import { click, mockAPI, mount, render, run, type } from "./test-helpers";
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
});
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
