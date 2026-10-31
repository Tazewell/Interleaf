import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "@reader/api";
import type { AICapability, DocumentLocation } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Checkbox } from "@reader/ui/components/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@reader/ui/components/select";
import {
  researchEpoch,
  researchStore,
  running,
  subscribeResearchEpoch,
} from "./research-session";
import { ResearchChat } from "./ResearchChat";
import { ResearchProgress } from "./ResearchProgress";
import { ResearchScope } from "./ResearchScope";
import { ResearchReport, ResearchIdeas } from "./ResearchReport";
import { ResearchSources } from "./ResearchSources";
import { ResearchCandidates } from "./ResearchCandidates";
import { refreshAIConfig, useReaderStore } from "../store";
import { usePaperUI } from "../papers/state";
export function ResearchPanel(props: {
  topicId: string;
  onOpenDocument: (id: string, location: DocumentLocation) => Promise<void>;
}) {
  const epoch = useSyncExternalStore(subscribeResearchEpoch, researchEpoch);
  return <ResearchPanelView key={`${epoch}:${props.topicId}`} {...props} />;
}
function ResearchPanelView({
  topicId,
  onOpenDocument,
}: {
  topicId: string;
  onOpenDocument: (id: string, location: DocumentLocation) => Promise<void>;
}) {
  const store = useMemo(() => researchStore(topicId), [topicId]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const config = useReaderStore((s) => s.aiConfig);
  const catalogRevision = useReaderStore((s) => s.aiCatalogRevision);
  const model = config?.models.research || config?.models.chat;
  const [capability, setCapability] = useState<AICapability>();
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    if (!config)
      void refreshAIConfig().catch((error) => setCatalogError(error.message));
  }, [config]);
  useEffect(() => {
    const controller = new AbortController();
    setCapability(undefined);
    if (config?.connection.url && model)
      void api
        .agentModels("research", controller.signal)
        .then((models) => {
          if (!controller.signal.aborted) {
            setCapability(
              models.find((candidate) => candidate.id === model)?.capability,
            );
            setCatalogError("");
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setCatalogError(error.message);
        });
    return () => controller.abort();
  }, [config, model, catalogRevision]);
  const blocked =
    !config?.connection.url ||
    !model ||
    capability?.text === false;
  const active = running(state.run);
  const session = state.sessions.find(
    (session) => session.id === state.sessionId,
  );
  const reports = useMemo(
    () =>
      state.reports.filter((report) => report.sessionId === state.sessionId),
    [state.reports, state.sessionId],
  );
  const sourceIds = useMemo(
    () => [
      ...new Set(
        [
          ...(state.results?.ideas ?? []),
          ...(state.results?.partialIdeas ?? []),
        ]
          .flatMap((idea) => idea.basis.flatMap((fact) => fact.evidenceIds))
          .concat(
            (state.results?.novelty ?? []).flatMap((report) =>
              report.rows.flatMap((row) => row.evidenceIds),
            ),
          ),
      ),
    ],
    [state.results],
  );
  const fontScale = useReaderStore((s) => s.theme.assistantFontScale ?? 1);
  return (
    <main className="library-main overflow-y-auto" aria-label="主题研究">
      <header className="library-topbar">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => usePaperUI.getState().setResearchTopic(null)}
        >
          返回论文库
        </Button>
        <h1 className="min-w-0 truncate text-base font-medium">
          {state.topic?.title || "主题研究"}
        </h1>
      </header>
      <div
        className="mx-auto w-full max-w-4xl space-y-5 p-6"
        style={{ fontSize: `${13 * fontScale}px` }}
      >
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {!!state.sessions.length && (
              <Select
                value={state.sessionId}
                disabled={state.busy}
                onValueChange={(id) => {
                  if (id) void store.selectSession(id);
                }}
              >
                <SelectTrigger aria-label="研究会话" className="w-52">
                  <SelectValue>{session?.title || "选择会话"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {state.sessions.map((session) => (
                    <SelectItem key={session.id} value={session.id}>
                      {session.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={state.busy || state.loading}
              onClick={() => void store.newSession()}
            >
              新会话
            </Button>
            {session && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={session.networkAllowed}
                  disabled={
                    state.networkBusy || (state.busy && !session.networkAllowed)
                  }
                  onCheckedChange={(value) =>
                    void store.setNetwork(value === true)
                  }
                  aria-label="允许会话联网检索"
                />
                允许联网检索
              </label>
            )}
          </div>
        </header>
        {state.loading && <p role="status">读取研究…</p>}
        {state.error && (
          <div role="alert" className="space-y-2">
            <p>{state.error}</p>
            <Button
              size="sm"
              variant="outline"
              disabled={state.busy}
              onClick={() =>
                void (state.topic ? store.recover() : store.load())
              }
            >
              重试查询
            </Button>
          </div>
        )}
        {blocked && (
          <p role="status">
            {!config?.connection.url || !model
              ? "请在设置中配置 API 地址和问答 / 研究模型后开始研究。"
              : "当前模型不可用，请在设置中检查连接。"}
          </p>
        )}
        {!blocked && capability && capability.tools !== "passed" && (
          <p className="text-sm text-muted-foreground">
            受限文字模式：由 Interleaf 控制资料读取，模型不调用工具。
          </p>
        )}
        {capability && !capability.vision && (
          <p className="text-sm text-muted-foreground">
            当前使用文本研究；图表图片未读取。可在设置中配置并检查视觉模型。
          </p>
        )}
        {catalogError && (
          <p className="text-sm text-muted-foreground">
            模型能力读取失败：{catalogError}。可在设置中重新检查。
          </p>
        )}
        {state.topic && (
          <ResearchScope
            topic={state.topic}
            busy={state.busy || active}
            onSaved={() => void store.load()}
          />
        )}
        {state.run && (
          <ResearchProgress
            run={state.run}
            results={state.results}
            busy={state.busy}
            controlBusy={state.controlBusy ?? false}
            control={(action) => void store.control(action)}
          />
        )}
        <ResearchChat
          state={state}
          disabled={
            blocked ||
            state.loading ||
            state.busy ||
            !!state.uncertain ||
            active ||
            ["paused", "interrupted", "preparing"].includes(
              state.run?.status ?? "",
            )
          }
          onSend={(question, mode, online) =>
            void store.send(question, mode, online)
          }
        />
        <ResearchReport
          topicId={topicId}
          sessionId={state.sessionId}
          reports={reports}
          onOpenDocument={onOpenDocument}
          onSaved={() => void store.recover()}
        />
        {state.results && (
          <ResearchSources
            topicId={topicId}
            sourceIds={sourceIds}
            onOpenDocument={onOpenDocument}
          >
            <ResearchIdeas
              results={state.results}
              busy={
                blocked ||
                active ||
                state.busy ||
                !!state.uncertain ||
                ["paused", "interrupted", "preparing"].includes(
                  state.run?.status ?? "",
                )
              }
              onCheck={(id) =>
                void store.send(
                  "核查此想法的相关工作、重叠与未验证主张",
                  "novelty",
                  true,
                  id,
                )
              }
            />
          </ResearchSources>
        )}
        <ResearchCandidates
          topicId={topicId}
          candidates={state.candidates}
          searches={state.searches}
        />
      </div>
    </main>
  );
}
