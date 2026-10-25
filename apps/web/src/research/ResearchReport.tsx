import { useEffect, useRef, useState } from "react";
import { researchAPI } from "@reader/api";
import type {
  DocumentLocation,
  ResearchReport as Report,
  ResearchResults,
} from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Textarea } from "@reader/ui/components/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@reader/ui/components/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@reader/ui/components/table";
import { MessageMarkdown } from "../chat/MessageMarkdown";
import { ResearchSources } from "./ResearchSources";
import { Coverage } from "./ResearchProgress";
import {
  finishResearchOperation,
  researchOperationID,
  researchSignal,
} from "./research-session";
const noSources: string[] = [];
export function ResearchReport({
  topicId,
  reports,
  onOpenDocument,
  onSaved,
}: {
  topicId: string;
  reports: Report[];
  onOpenDocument: (id: string, location: DocumentLocation) => Promise<void>;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState("");
  const [markdown, setMarkdown] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const report =
    reports.find((report) => report.id === selected) ??
    reports[reports.length - 1];
  useEffect(() => {
    setEditing(false);
    setMarkdown(undefined);
    setError("");
    pending.current?.abort();
  }, [report?.id]);
  useEffect(() => () => pending.current?.abort(), []);
  const save = async () => {
    if (!report || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const operation = `revision:${topicId}:${report.id}`;
    const requestId = researchOperationID(operation, content);
    pending.current = new AbortController();
    const signal = AbortSignal.any([pending.current.signal, researchSignal()]);
    try {
      const revision = await researchAPI.reviseReport(
        report.id,
        { requestId, content },
        signal,
      );
      if (signal.aborted || revision.topicId !== topicId) return;
      finishResearchOperation(operation, requestId);
      setSelected(revision.id);
      setEditing(false);
      onSaved();
    } catch (error) {
      if (!signal.aborted) setError((error as Error).message);
    } finally {
      locked.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };
  if (!report)
    return <p className="text-sm text-muted-foreground">暂无已保存的报告。</p>;
  return (
    <section aria-label="研究报告" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">报告</h3>
        <Select
          value={report.id}
          onValueChange={(id) => {
            if (id) setSelected(id);
          }}
          disabled={busy}
        >
          <SelectTrigger aria-label="历史版本" className="w-auto">
            <SelectValue>{`历史版本 ${reports.indexOf(report) + 1} · ${report.origin === "user" ? "用户编辑" : "模型报告"}`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {reports.map((r, index) => (
              <SelectItem key={r.id} value={r.id}>
                {index + 1} · {r.origin === "user" ? "用户编辑" : "模型报告"} ·{" "}
                {r.createdAt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setContent(report.content);
            setEditing(true);
          }}
        >
          编辑报告
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            pending.current?.abort();
            pending.current = new AbortController();
            const signal = AbortSignal.any([
              pending.current.signal,
              researchSignal(),
            ]);
            setError("");
            setBusy(true);
            try {
              const text = await researchAPI.markdown(report.id, signal);
              if (!signal.aborted) setMarkdown(text);
            } catch (error) {
              if (!signal.aborted) setError((error as Error).message);
            } finally {
              if (!signal.aborted) setBusy(false);
            }
          }}
        >
          导出 Markdown
        </Button>
      </div>
      {report.stale && (
        <p className="text-sm text-muted-foreground">
          部分来源已失效。历史报告仍可阅读和编辑，引用打开前会重新校验。
        </p>
      )}
      {report.origin === "user" && (
        <p className="text-sm text-muted-foreground">
          用户编辑版本 · 未重新进行模型核查
        </p>
      )}
      <Coverage coverage={report.coverage} />
      {error && <p role="alert">{error}</p>}
      {editing ? (
        <div className="space-y-2">
          <Textarea
            aria-label="编辑研究报告"
            className="min-h-64"
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !content.trim()}
              onClick={() => void save()}
            >
              保存新版本
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              取消编辑
            </Button>
          </div>
        </div>
      ) : (
        <ResearchSources
          topicId={topicId}
          sourceIds={report.sourceIds ?? noSources}
          onOpenDocument={onOpenDocument}
        >
          <MessageMarkdown content={report.content} animated={false} />
        </ResearchSources>
      )}
      {markdown !== undefined && (
        <div className="space-y-2">
          <Textarea
            readOnly
            aria-label="导出 Markdown 内容"
            className="min-h-40"
            value={markdown}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
              );
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = "research.md";
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            下载 Markdown
          </Button>
        </div>
      )}
    </section>
  );
}
const noveltyLabels = {
  high_overlap: "高度重叠",
  partial_overlap: "部分重叠",
  not_found: "本次未发现",
  insufficient: "证据不足",
};
export function ResearchIdeas({
  results,
  busy,
  onCheck,
}: {
  results: ResearchResults;
  busy: boolean;
  onCheck: (ideaId: string) => void;
}) {
  return (
    <section aria-label="研究想法与查新" className="space-y-3">
      <h3 className="font-medium">想法与查新</h3>
      {!!results.partialIdeas?.length && (
        <p className="text-sm text-muted-foreground">
          以下为未完成证据范围的阶段想法，尚不可用于查新。
        </p>
      )}
      {[
        ...(results.partialIdeas ?? []).map((idea) => ({
          idea,
          partial: true,
        })),
        ...results.ideas.map((idea) => ({ idea, partial: false })),
      ].map(({ idea, partial }) => (
        <article
          key={`${partial}:${idea.id}`}
          className="space-y-2 rounded-lg border p-3"
        >
          <h4>
            {idea.problem}
            {partial ? "（阶段结果）" : ""}
          </h4>
          <p>{idea.mechanism}</p>
          <p>假设：{idea.hypotheses.join("；")}</p>
          <p>改动：{idea.changes.join("；")}</p>
          <p>最小实验：{idea.minimumExperiment}</p>
          <p>
            基线：{idea.baselines.join("；")} · 消融：
            {idea.ablations.join("；")}
          </p>
          <p>证伪：{idea.falsification}</p>
          <p>资源：{idea.resources}</p>
          {idea.basis.map((fact, index) => (
            <MessageMarkdown
              key={index}
              content={`${fact.text} ${fact.evidenceIds.map((id) => `[${id}]`).join(" ")}`}
              animated={false}
            />
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || partial}
            onClick={() => onCheck(idea.id)}
          >
            联网核查此想法
          </Button>
        </article>
      ))}
      {results.novelty.map((report) => (
        <div key={report.ideaId} className="space-y-2">
          <p className="text-sm">查询截至 {report.asOf} · 文本检索辅助</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>主张</TableHead>
                <TableHead>证据结论</TableHead>
                <TableHead>重叠与差异</TableHead>
                <TableHead>尚未验证</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((row) => (
                <TableRow key={row.claimId}>
                  <TableCell>
                    {results.ideas
                      .flatMap((idea) => idea.claims)
                      .find((claim) => claim.id === row.claimId)?.text ??
                      row.claimId}
                  </TableCell>
                  <TableCell>{noveltyLabels[row.status]}</TableCell>
                  <TableCell>
                    <MessageMarkdown
                      content={`${row.overlap}\n\n${row.difference}\n\n${row.evidenceIds.map((id) => `[${id}]`).join(" ")}`}
                      animated={false}
                    />
                  </TableCell>
                  <TableCell>{row.unverified}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-sm text-muted-foreground">
            {report.caveats.join("；")}
          </p>
        </div>
      ))}
      {!!results.queries.length && (
        <details>
          <summary>查新查询与时间</summary>
          {results.queries.map((query, index) => (
            <p key={index} className="text-sm">
              {query.source} · {query.query} · {query.fromYear}–{query.toYear} ·{" "}
              {query.status} · {query.fetchedAt || "尚未完成"}
              {query.exclusions.length
                ? ` · 排除：${query.exclusions.join("；")}`
                : ""}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
