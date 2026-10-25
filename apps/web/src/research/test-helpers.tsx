import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { api, researchAPI } from "@reader/api";
import type {
  ResearchCoverage,
  ResearchReport,
  ResearchRun,
  ResearchTopic,
} from "@reader/core";
import { useReaderStore } from "../store";
import { resetResearchLibrary } from "./research-session";
import { usePaperUI } from "../papers/state";
export const coverage: ResearchCoverage = {
  totalPapers: 3,
  analyzedPapers: 1,
  abstractOnlyPapers: 1,
  unavailablePapers: 1,
  pendingPapers: 1,
  readUnits: 2,
  totalUnits: 12,
  readCoverage: {
    paper: { readUnits: 2, totalUnits: 12, ranges: [{ type: "pdf", page: 2 }] },
  },
};
export const topic: ResearchTopic = {
  id: "topic",
  title: "同名论文",
  folder: "ML",
  includeChildren: true,
  networkAllowed: false,
  scopeState: "active",
  createdAt: "2026-10-24",
  updatedAt: "2026-10-24",
};
export const session = {
  id: "session",
  topicId: "topic",
  title: "研究",
  networkAllowed: false,
  createdAt: "2026-10-24",
  updatedAt: "2026-10-24",
};
export const run: ResearchRun = {
  id: "run",
  topicId: "topic",
  sessionId: "session",
  userMessageId: "1".repeat(32),
  status: "running",
  phase: "reading",
  snapshotId: "snapshot",
  revision: "v1",
  done: 1,
  total: 3,
  coverage,
  updatedAt: "2026-10-24",
};
export const report: ResearchReport = {
  id: "report",
  topicId: "topic",
  sessionId: "session",
  runId: "run",
  kind: "overview",
  revision: "v1",
  sourceRevision: "v1",
  origin: "model",
  content: "已保存的研究报告",
  sourceIds: [],
  coverage,
  stale: false,
  createdAt: "2026-10-24",
};
export const results = {
  ideas: [],
  partialIdeas: [],
  novelty: [],
  queries: [],
  pendingIdeaIds: [],
  batches: [],
  capability: "text-search-assistance" as const,
};
export function mockAPI() {
  resetResearchLibrary();
  usePaperUI.setState({ researchTopicId: null, researchTarget: null });
  vi.spyOn(api, "agentModels").mockResolvedValue([]);
  const messages: import("@reader/core").ResearchMessage[] = [];
  vi.spyOn(researchAPI, "getTopic").mockImplementation(async (id) => ({
    ...topic,
    id,
  }));
  vi.spyOn(researchAPI, "listSessions").mockImplementation(async (id) => [
    {
      ...session,
      id: id === "topic" ? "session" : `${id}-session`,
      topicId: id,
    },
  ]);
  vi.spyOn(researchAPI, "listMessages").mockImplementation(async (sid) =>
    messages.filter((message) => message.sessionId === sid),
  );
  vi.spyOn(researchAPI, "listReports").mockResolvedValue([]);
  vi.spyOn(researchAPI, "listCandidates").mockResolvedValue([]);
  vi.spyOn(researchAPI, "listSearches").mockResolvedValue([]);
  vi.spyOn(researchAPI, "getResults").mockResolvedValue(results);
  vi.spyOn(researchAPI, "getRun").mockResolvedValue(run);
  vi.spyOn(researchAPI, "createRun").mockImplementation(
    async (_topic, sid, input) => {
      messages.push({
        id: input.userMessageId,
        sessionId: sid,
        runId: run.id,
        role: "user",
        content: input.question,
        createdAt: "2026",
      });
      return { ...run, userMessageId: input.userMessageId };
    },
  );
  vi.spyOn(researchAPI, "controlRun").mockResolvedValue(run);
  vi.spyOn(researchAPI, "events").mockImplementation(
    async (_id, _after, signal) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      ),
  );
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
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
}
export async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
export function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return { host, root };
}
export async function render(root: Root, element: React.ReactNode) {
  await act(async () => root.render(element));
  await flush();
}
export async function click(host: HTMLElement, label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(
    (b) =>
      b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`缺少按钮 ${label}: ${host.textContent}`);
  await act(async () => button.click());
  await flush();
}
export async function type(
  host: HTMLElement,
  value: string,
  label = "研究问题",
) {
  const input = host.querySelector(
    `[aria-label="${label}"]`,
  ) as HTMLTextAreaElement;
  if (!input) throw new Error(`缺少输入框 ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
