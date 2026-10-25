import { useEffect, useState, useSyncExternalStore } from "react";
import { researchAPI } from "@reader/api";
import type { ResearchRun, ResearchTopic } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import {
  researchEpoch,
  researchSignal,
  subscribeResearchEpoch,
} from "./research-session";
import { usePaperUI } from "../papers/state";
const labels: Record<ResearchRun["status"], string> = {
  preparing: "待开始",
  queued: "排队中",
  running: "研究中",
  paused: "已暂停",
  interrupted: "已中断",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};
export function ResearchNavigation() {
  const epoch = useSyncExternalStore(subscribeResearchEpoch, researchEpoch);
  const selected = usePaperUI((s) => s.researchTopicId);
  const [topics, setTopics] = useState<
    { topic: ResearchTopic; status?: string }[]
  >([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, researchSignal()]);
    let timer: ReturnType<typeof setTimeout>;
    setTopics([]);
    const load = async () => {
      try {
        const list = await researchAPI.listTopics(signal);
        const statuses = await Promise.all(
          list.map(async (topic) => {
            try {
              const sessions = await researchAPI.listSessions(topic.id, signal);
              const runs = (
                await Promise.all(
                  sessions
                    .filter((s) => s.topicId === topic.id)
                    .map(async (session) => {
                      const messages = await researchAPI.listMessages(
                        session.id,
                        signal,
                      );
                      const id = [...messages]
                        .reverse()
                        .find(
                          (m) => m.sessionId === session.id && m.runId,
                        )?.runId;
                      const run = id
                        ? await researchAPI.getRun(id, signal)
                        : undefined;
                      return run?.topicId === topic.id &&
                        run.sessionId === session.id
                        ? run
                        : undefined;
                    }),
                )
              ).filter((run): run is ResearchRun => !!run);
              const priority = [
                "running",
                "queued",
                "paused",
                "interrupted",
                "preparing",
                "failed",
                "completed",
                "canceled",
              ];
              runs.sort(
                (a, b) =>
                  priority.indexOf(a.status) - priority.indexOf(b.status),
              );
              return {
                topic,
                status: runs[0] ? labels[runs[0].status] : undefined,
              };
            } catch {
              return { topic, status: "状态待查询" };
            }
          }),
        );
        if (!signal.aborted) {
          setTopics(statuses);
          setError("");
        }
      } catch (error) {
        if (!signal.aborted) setError((error as Error).message);
      }
      if (!signal.aborted) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [epoch, selected, retry]);
  if (!topics.length && !error) return null;
  return (
    <nav aria-label="主题研究任务" className="mt-3 space-y-1">
      <p className="px-2 text-xs text-muted-foreground">主题研究</p>
      {topics.map(({ topic, status }) => (
        <Button
          key={topic.id}
          variant="ghost"
          className={`nav-item w-full min-w-0 ${selected === topic.id ? "active" : ""}`}
          onClick={() => usePaperUI.getState().setResearchTopic(topic.id)}
        >
          <span className="min-w-0 flex-1 truncate">{topic.title}</span>
          {status && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {status}
            </span>
          )}
        </Button>
      ))}
      {error && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setRetry((n) => n + 1)}
        >
          重试读取研究任务
        </Button>
      )}
    </nav>
  );
}
