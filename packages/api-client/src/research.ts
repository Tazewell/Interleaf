import type {
  ResearchTopic,
  ResearchTopicInput,
  ResearchTopicPatch,
  ResearchSession,
  ResearchSessionInput,
} from "@reader/core";
import { request } from "./transport";

const topicPath = (id: string) =>
  `/api/research/topics/${encodeURIComponent(id)}`;

export const researchAPI = {
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
