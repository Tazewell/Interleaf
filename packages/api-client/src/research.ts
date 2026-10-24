import type {
  ResearchTopic,
  ResearchTopicInput,
  ResearchTopicPatch,
  ResearchSession,
  ResearchSessionInput,
  ResearchEvidence,
  ResearchRun,
  ResearchResults,
  ResearchRunInput,
  ResearchControl,
  ResearchReport,
  ResearchMessage,
  ResearchCandidate,
  ResearchSearch,
  Document,
} from "@reader/core";
import { request, requestResponse } from "./transport";

const topicPath = (id: string) =>
  `/api/research/topics/${encodeURIComponent(id)}`;

export const researchAPI = {
  setNetwork: (sessionId: string, allowed: boolean, signal?: AbortSignal) =>
    request<void>(
      `/api/research/sessions/${encodeURIComponent(sessionId)}/network`,
      { method: "PATCH", body: JSON.stringify({ allowed }), signal },
    ),
  listCandidates: (topicId: string, signal?: AbortSignal) =>
    request<ResearchCandidate[]>(`${topicPath(topicId)}/candidates`, {
      signal,
    }),
  listSearches: (topicId: string, signal?: AbortSignal) =>
    request<ResearchSearch[]>(`${topicPath(topicId)}/searches`, { signal }),
  importCandidate: (
    topicId: string,
    candidateId: string,
    requestId: string,
    signal?: AbortSignal,
  ) =>
    request<Document>(
      `${topicPath(topicId)}/candidates/${encodeURIComponent(candidateId)}/import`,
      { method: "POST", body: JSON.stringify({ requestId }), signal },
    ),
  createRun: (
    topicId: string,
    sessionId: string,
    input: ResearchRunInput,
    signal?: AbortSignal,
  ) =>
    request<ResearchRun>(
      `${topicPath(topicId)}/sessions/${encodeURIComponent(sessionId)}/runs`,
      { method: "POST", body: JSON.stringify(input), signal },
    ),
  getRun: (runId: string, signal?: AbortSignal) =>
    request<ResearchRun>(`/api/research/runs/${encodeURIComponent(runId)}`, {
      signal,
    }),
  getResults: (runId: string, signal?: AbortSignal) =>
    request<ResearchResults>(
      `/api/research/runs/${encodeURIComponent(runId)}/results`,
      { signal },
    ),
  controlRun: (
    runId: string,
    action: "start" | "pause" | "resume" | "cancel",
    input: ResearchControl,
    signal?: AbortSignal,
  ) =>
    request<ResearchRun>(
      `/api/research/runs/${encodeURIComponent(runId)}/${action}`,
      { method: "POST", body: JSON.stringify(input), signal },
    ),
  events: (runId: string, after = 0, signal?: AbortSignal) =>
    requestResponse(
      `/api/research/runs/${encodeURIComponent(runId)}/events?after=${after}`,
      { signal },
    ),
  listMessages: (sessionId: string, signal?: AbortSignal) =>
    request<ResearchMessage[]>(
      `/api/research/sessions/${encodeURIComponent(sessionId)}/messages`,
      { signal },
    ),
  listReports: (topicId: string, signal?: AbortSignal) =>
    request<ResearchReport[]>(`${topicPath(topicId)}/reports`, { signal }),
  getReport: (reportId: string, signal?: AbortSignal) =>
    request<ResearchReport>(
      `/api/research/reports/${encodeURIComponent(reportId)}`,
      { signal },
    ),
  reviseReport: (
    reportId: string,
    input: { requestId: string; content: string },
    signal?: AbortSignal,
  ) =>
    request<ResearchReport>(
      `/api/research/reports/${encodeURIComponent(reportId)}/revisions`,
      { method: "POST", body: JSON.stringify(input), signal },
    ),
  markdown: async (reportId: string, signal?: AbortSignal) =>
    (
      await requestResponse(
        `/api/research/reports/${encodeURIComponent(reportId)}/markdown`,
        { signal },
      )
    ).text(),
  getSource: (sourceId: string, signal?: AbortSignal) =>
    request<ResearchEvidence>(
      `/api/research/sources/${encodeURIComponent(sourceId)}`,
      { signal },
    ),
  createTopic: (input: ResearchTopicInput, signal?: AbortSignal) =>
    request<ResearchTopic>("/api/research/topics", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    }),
  listTopics: (signal?: AbortSignal) =>
    request<ResearchTopic[]>("/api/research/topics", { signal }),
  getTopic: (topicId: string, signal?: AbortSignal) =>
    request<ResearchTopic>(topicPath(topicId), { signal }),
  updateTopic: (
    topicId: string,
    input: ResearchTopicPatch,
    signal?: AbortSignal,
  ) =>
    request<ResearchTopic>(topicPath(topicId), {
      method: "PATCH",
      body: JSON.stringify(input),
      signal,
    }),
  createSession: (
    topicId: string,
    input: ResearchSessionInput,
    signal?: AbortSignal,
  ) =>
    request<ResearchSession>(`${topicPath(topicId)}/sessions`, {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    }),
  listSessions: (topicId: string, signal?: AbortSignal) =>
    request<ResearchSession[]>(`${topicPath(topicId)}/sessions`, { signal }),
};
