import { useEffect, useRef, useState } from "react";
import type {
  BilingualPDFJob,
  BilingualPDFOptions,
  Document,
} from "@interleaf/core";
import { api } from "@interleaf/api";
import { Button } from "@interleaf/ui/components/button";
import { Checkbox } from "@interleaf/ui/components/checkbox";
import { Input } from "@interleaf/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@interleaf/ui/components/radio-group";

type Session = {
  active: boolean;
  controller: AbortController;
  jobId?: string;
  pending?: Promise<void>;
  cleanup?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  querying?: boolean;
  startError?: string;
};
const newSession = (): Session => ({
  active: true,
  controller: new AbortController(),
});
const stages = {
  prepare: "预检",
  translating: "翻译",
  layout: "排版",
  composing: "生成",
  ready: "完成",
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "双语导出失败，请重试";

export function BilingualPDFExport({ document: doc }: { document: Document }) {
  if (
    doc.type !== "pdf" ||
    doc.metadataOnly ||
    doc.deletedAt ||
    !window.interleafDesktop?.saveBilingualPDF
  )
    return null;
  return <ExportArea key={`${doc.id}:${doc.paperId || ""}`} document={doc} />;
}

function ExportArea({ document: doc }: { document: Document }) {
  const [layout, setLayout] =
    useState<BilingualPDFOptions["layout"]>("side-by-side");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [job, setJob] = useState<BilingualPDFJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [queryFailed, setQueryFailed] = useState(false);
  const [recoveringStart, setRecoveringStart] = useState(false);
  const [keep, setKeep] = useState(false);
  const [attach, setAttach] = useState(false);
  const [saved, setSaved] = useState("");
  const [attached, setAttached] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const session = useRef<Session>(newSession());
  const mounted = useRef(false);
  const lock = useRef(false);
  const alive = (s: Session) =>
    mounted.current && s.active && session.current === s;
  const release = (s: Session): Promise<void> => {
    if (!s.jobId) return Promise.resolve();
    if (!s.cleanup) {
      const input = { documentId: doc.id, jobId: s.jobId };
      s.cleanup = Promise.all([
        window.interleafDesktop?.cancelBilingualPDFSave?.(input),
        api.cancelBilingualPDF(doc.id, s.jobId),
      ]).then(
        () => {},
        (e) => {
          s.cleanup = undefined;
          throw e;
        },
      );
    }
    return s.cleanup;
  };
  const invalidate = (s: Session) => {
    s.active = false;
    s.controller.abort();
    clearTimeout(s.timer);
  };
  const reset = async () => {
    const s = session.current;
    invalidate(s);
    lock.current = true;
    setBusy(true);
    try {
      // Retain the create response so a server-created job is always reclaimed.
      await s.pending?.catch(() => {});
      await release(s);
      if (!mounted.current || session.current !== s) return;
      session.current = newSession();
      setJob(null);
      setError("");
      setQueryFailed(false);
      setRecoveringStart(false);
      setKeep(false);
      setSaved("");
      setAttached(false);
      setAttachmentError("");
    } catch (e) {
      if (mounted.current) setError(`取消任务失败：${message(e)}`);
    } finally {
      if (mounted.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    // Effects may be replayed in development StrictMode.
    if (!session.current.active) session.current = newSession();
    const unsubscribe = window.interleafDesktop?.onLibraryChanged?.(() => {
      void reset();
    });
    return () => {
      mounted.current = false;
      const s = session.current;
      invalidate(s);
      void release(s).catch(() => {});
      unsubscribe?.();
    };
  }, []);

  const query = async (s: Session) => {
    if (!alive(s) || s.querying || !s.jobId) return;
    s.querying = true;
    setQueryFailed(false);
    setError("");
    try {
      const result = await api.bilingualPDF(
        doc.id,
        s.jobId,
        s.controller.signal,
      );
      if (!alive(s)) return;
      update(s, result);
      setRecoveringStart(false);
      if (result.status === "awaiting-confirmation")
        setError(s.startError || "");
      else s.startError = undefined;
    } catch (e) {
      if (alive(s)) {
        setError(
          s.startError
            ? `${s.startError}；查询失败：${message(e)}`
            : message(e),
        );
        setQueryFailed(true);
      }
    } finally {
      s.querying = false;
    }
  };
  const update = (s: Session, result: BilingualPDFJob) => {
    if (!alive(s)) return;
    s.jobId = result.id;
    setJob(result);
    if (["preparing", "translating", "running"].includes(result.status)) {
      s.timer = setTimeout(() => {
        void query(s);
      }, 750);
    }
  };
  const prepare = async () => {
    if (lock.current || !session.current.active) return;
    const page = (value: string) => (value === "" ? undefined : Number(value));
    const fromPage = page(from),
      toPage = page(to);
    if (
      [fromPage, toPage].some(
        (value) =>
          value !== undefined && (!Number.isSafeInteger(value) || value < 1),
      ) ||
      (fromPage !== undefined && toPage !== undefined && fromPage > toPage)
    ) {
      setError("请输入有效的起止页码");
      return;
    }
    const s = session.current;
    lock.current = true;
    setBusy(true);
    setError("");
    const options = {
      layout,
      ...(fromPage !== undefined && { fromPage }),
      ...(toPage !== undefined && { toPage }),
    };
    // Do not abort POST: aborting fetch can discard the only copy of the job ID.
    s.pending = api.createBilingualPDF(doc.id, options).then(async (result) => {
      s.jobId = result.id;
      if (!alive(s)) {
        await release(s);
        return;
      }
      update(s, result);
    });
    try {
      await s.pending;
    } catch (e) {
      if (alive(s)) setError(message(e));
    } finally {
      if (alive(s)) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  const start = async () => {
    const s = session.current,
      preflight = job?.preflight;
    if (
      lock.current ||
      recoveringStart ||
      !alive(s) ||
      !job ||
      job.status !== "awaiting-confirmation" ||
      !preflight ||
      (preflight.noTextPages.length > 0 && !keep) ||
      (preflight.missingParagraphs > 0 && !preflight.apiConfigured)
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    s.startError = undefined;
    try {
      update(
        s,
        await api.startBilingualPDF(
          doc.id,
          job.id,
          {
            translateMissing: preflight.missingParagraphs > 0,
            keepOriginalPages: keep ? preflight.noTextPages : [],
          },
          s.controller.signal,
        ),
      );
    } catch (e) {
      if (alive(s)) {
        // POST may already have started paid work. Resolve the existing job
        // before enabling another explicit start; never replay POST here.
        s.startError = message(e);
        setRecoveringStart(true);
        await query(s);
      }
    } finally {
      if (alive(s)) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  const attachFile = async (s: Session) => {
    if (!s.jobId || !doc.paperId || !alive(s)) return;
    setAttachmentError("");
    try {
      await api.attachBilingualPDF(doc.id, s.jobId, s.controller.signal);
      if (alive(s)) setAttached(true);
    } catch (e) {
      if (alive(s))
        setAttachmentError(`附件添加失败：${message(e)}。已保存的文件保留。`);
    }
  };
  const save = async (retryAttachment = false) => {
    const s = session.current;
    if (lock.current || !alive(s) || job?.status !== "ready") return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (retryAttachment) await attachFile(s);
      else {
        const result = await window.interleafDesktop!.saveBilingualPDF!({
          documentId: doc.id,
          jobId: job.id,
        });
        if (!alive(s) || !result.saved) return;
        setSaved(result.fileName || "双语 PDF");
        if (attach) await attachFile(s);
      }
    } catch (e) {
      if (alive(s)) setError(message(e));
    } finally {
      if (alive(s)) {
        lock.current = false;
        setBusy(false);
      }
    }
  };
  const preflight = job?.preflight;
  return (
    <section aria-label="双语 PDF" className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">双语 PDF</h3>
      {!job && (
        <>
          <RadioGroup
            aria-label="双语 PDF 布局"
            value={layout}
            disabled={busy}
            onValueChange={(value) =>
              setLayout(value as BilingualPDFOptions["layout"])
            }
            className="grid-cols-2"
          >
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="side-by-side" />
              左右并排
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="alternating" />
              逐页交替
            </label>
          </RadioGroup>
          <div className="flex items-center gap-2">
            <Input
              aria-label="起始页"
              type="number"
              min="1"
              placeholder="起始页"
              disabled={busy}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span>—</span>
            <Input
              aria-label="结束页"
              type="number"
              min="1"
              placeholder="结束页"
              disabled={busy}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">留空导出全部页面。</p>
        </>
      )}
      {doc.paperId && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            aria-label="添加为此文献的翻译附件"
            checked={attach}
            disabled={busy || !!saved}
            onCheckedChange={(value) => setAttach(!!value)}
          />
          添加为此文献的翻译附件
        </label>
      )}
      {job && (
        <p role="status" className="text-sm">
          {stages[job.stage]} {job.done} / {job.total}
        </p>
      )}
      {job?.status === "awaiting-confirmation" && preflight && (
        <div className="space-y-2 text-sm">
          <p>
            {preflight.pages} 页原文 → {preflight.outputPages} 页导出；需翻译{" "}
            {preflight.missingParagraphs} 段。
          </p>
          {preflight.missingParagraphs > 0 && (
            <p className="text-xs leading-5 text-muted-foreground">
              将使用设置中的 API 翻译缺少的段落，可能产生 API 费用。
            </p>
          )}
          {preflight.missingParagraphs > 0 && !preflight.apiConfigured && (
            <p role="alert" className="text-sm text-destructive">
              请先在设置 → Agent 连接 → API 中配置 API
              URL、密钥和模型，再重新预检。
            </p>
          )}
          {preflight.noTextPages.length > 0 && (
            <label className="flex items-start gap-2">
              <Checkbox
                aria-label="保留无可翻译横排文字页的原文"
                checked={keep}
                disabled={busy}
                onCheckedChange={(value) => setKeep(!!value)}
              />
              <span>
                第 {preflight.noTextPages.join("、")}{" "}
                页无可翻译横排文字，保留原文
              </span>
            </label>
          )}
          {preflight.warnings.map((warning, index) => (
            <p key={index} className="text-xs text-muted-foreground">
              {warning}
            </p>
          ))}
        </div>
      )}
      {saved && (
        <p role="status" className="text-sm">
          已保存：{saved}
        </p>
      )}
      {attached && (
        <p role="status" className="text-sm">
          已添加翻译附件
        </p>
      )}
      {(error || job?.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || job?.error}
        </p>
      )}
      {attachmentError && (
        <p role="alert" className="text-sm text-destructive">
          {attachmentError}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {queryFailed && (
          <Button
            variant="outline"
            disabled={busy || !session.current.active}
            onClick={() => void query(session.current)}
          >
            重试查询
          </Button>
        )}
        {(job || busy || !session.current.active) && (
          <Button variant="outline" onClick={() => void reset()}>
            {job &&
            ["awaiting-confirmation", "failed", "ready"].includes(job.status)
              ? "重新设置"
              : "取消双语导出"}
          </Button>
        )}
        {!job && (
          <Button
            variant="outline"
            disabled={busy || !session.current.active}
            onClick={() => void prepare()}
          >
            预检双语 PDF
          </Button>
        )}
        {job?.status === "awaiting-confirmation" && preflight && (
          <Button
            disabled={
              busy ||
              recoveringStart ||
              !session.current.active ||
              (preflight.noTextPages.length > 0 && !keep) ||
              (preflight.missingParagraphs > 0 && !preflight.apiConfigured)
            }
            onClick={() => void start()}
          >
            {preflight.missingParagraphs > 0 ? "翻译并导出" : "生成双语 PDF"}
          </Button>
        )}
        {job?.status === "ready" && !saved && (
          <Button
            disabled={busy || !session.current.active}
            onClick={() => void save()}
          >
            保存双语 PDF
          </Button>
        )}
        {attachmentError && (
          <Button
            variant="outline"
            disabled={busy || !session.current.active}
            onClick={() => void save(true)}
          >
            重试添加附件
          </Button>
        )}
      </div>
    </section>
  );
}
