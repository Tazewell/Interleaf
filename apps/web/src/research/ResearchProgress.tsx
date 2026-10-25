import type {
  ResearchCoverage,
  ResearchResults,
  ResearchRun,
} from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Progress } from "@reader/ui/components/progress";
import { researchLocationLabel } from "./research-locations";
import { useReaderStore } from "../store";
const phases = {
  snapshot: "准备范围",
  reading: "阅读资料",
  searching: "检索论文",
  synthesizing: "整理报告",
  checking: "核查主张",
};
const statuses = {
  preparing: "待开始",
  queued: "排队中",
  running: "进行中",
  paused: "已暂停",
  interrupted: "已中断",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};
export function Coverage({ coverage: c }: { coverage: ResearchCoverage }) {
  const papers = useReaderStore((state) => state.paperItems);
  const documents = useReaderStore((state) => state.documents);
  return (
    <div
      className="space-y-1 text-sm text-muted-foreground"
      aria-label="实际阅读覆盖"
    >
      <p>
        已分析 {c.analyzedPapers} / {c.totalPapers} 篇 · 仅摘要{" "}
        {c.abstractOnlyPapers} 篇 · 不可读 {c.unavailablePapers} 篇 · 剩余{" "}
        {c.pendingPapers} 篇
      </p>
      <p>
        原文单元 {c.readUnits} / {c.totalUnits}（PDF 页 / EPUB
        章节；不代表图表均已读取）
      </p>
      {Object.entries(c.readCoverage ?? {}).map(([id, range], index) => (
        <details key={id}>
          <summary>
            {papers?.find((paper) => paper.id === id)?.title ||
              documents.find((document) => document.paperId === id)?.title ||
              `论文 ${index + 1}`}
            ：{range.readUnits} / {range.totalUnits} 单元
          </summary>
          <ul className="space-y-1 pl-4 text-xs">
            {range.ranges.map((location, index) => (
              <li key={index}>{researchLocationLabel(location)}</li>
            ))}
          </ul>
        </details>
      ))}
      {c.totalPapers === 0 && (
        <p>范围为空。请返回文件夹添加论文或调整研究范围。</p>
      )}
      {c.totalPapers > 0 && c.unavailablePapers === c.totalPapers && (
        <p>
          资料全部不可读。请在论文详情补充摘要、原文，或重试解析后重新开始。
        </p>
      )}
      {c.totalPapers > 0 &&
        c.totalUnits === 0 &&
        c.unavailablePapers < c.totalPapers && (
          <p>
            当前仅有元数据或尚无可读正文。请在论文详情补充摘要或原文，再开始新的研究。
          </p>
        )}
    </div>
  );
}
export function ResearchProgress({
  run,
  results,
  busy,
  controlBusy = busy,
  control,
}: {
  run: ResearchRun;
  results?: ResearchResults;
  busy: boolean;
  controlBusy?: boolean;
  control: (action: "pause" | "resume" | "cancel" | "start") => void;
}) {
  return (
    <section aria-label="研究进度" className="space-y-2 rounded-lg border p-3">
      <p role="status">
        {statuses[run.status]} · {phases[run.phase]} · 阶段 {run.done} /{" "}
        {run.total}
      </p>
      <Progress
        value={run.total ? (100 * run.done) / run.total : null}
        aria-label="阶段进度"
      />
      <Coverage coverage={run.coverage} />
      {run.limitReason && (
        <p>
          本次预算已用尽：{run.limitReason}。剩余 {run.coverage.pendingPapers}{" "}
          篇。
        </p>
      )}
      {run.error && <p role="alert">{run.error}</p>}
      {run.usage && (
        <p className="text-xs text-muted-foreground">
          累计模型请求 {run.usage.modelRequests} 次 · 本次{" "}
          {run.usage.attemptRequests} /{" "}
          {run.usage.attemptBudget.maxModelRequests} 次
        </p>
      )}
      {results?.batches?.map((batch, index) => (
        <div key={index} className="text-sm">
          <p>
            {batch.stage === "ideas" ? "想法分析" : "查新分析"}：证据片段{" "}
            {batch.done} / {batch.total}，已完成 {batch.completedBatches}{" "}
            批（不等于论文阅读覆盖）
          </p>
          {batch.sources.map((source, index) => (
            <p key={source.sourceId}>
              证据来源 {index + 1}：{source.done} / {source.total} 片段
            </p>
          ))}
        </div>
      ))}
      {!!results?.pendingIdeaIds?.length && (
        <p>尚有 {results.pendingIdeaIds.length} 个想法未完成核查。</p>
      )}
      <div className="flex flex-wrap gap-2">
        {["running", "queued"].includes(run.status) && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => control("pause")}
            >
              暂停研究
            </Button>
          </>
        )}
        {["preparing", "queued", "running", "paused", "interrupted"].includes(
          run.status,
        ) && (
          <Button
            variant="outline"
            size="sm"
            disabled={controlBusy}
            onClick={() => control("cancel")}
          >
            取消研究
          </Button>
        )}
        {["paused", "interrupted"].includes(run.status) && (
          <Button size="sm" disabled={busy} onClick={() => control("resume")}>
            继续研究（重新计本次预算并调用模型）
          </Button>
        )}
        {run.status === "preparing" && (
          <Button size="sm" disabled={busy} onClick={() => control("start")}>
            开始已创建任务
          </Button>
        )}
      </div>
    </section>
  );
}
