import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  FileMagnifyingGlass as FileSearch,
  Pause,
  ArrowCounterClockwise as RotateCcw,
  Translate as Languages,
} from "@phosphor-icons/react";
import type { EPUBLocation, LibraryMode, Processing } from "@interleaf/core";
import { api } from "@interleaf/api";
import { Button } from "@interleaf/ui/components/button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@interleaf/ui/components/alert-dialog";
import { toast } from "sonner";
import { ReadingTranslationProgress } from "./ReadingTranslationProgress";
import type { PageRange } from "./chapters";

type Action = "start" | "start-flow" | "pause" | "resume" | "chapter";
export type TranslationSetup = {
  connectionRequired: boolean;
  open: (section: "connection" | "models", trigger: HTMLButtonElement) => void;
};

/**
 * Papers translate the whole document with start, pause and resume. Books
 * translate the current chapter on request; the server caps each request.
 */
export function AssistanceControls({
  documentId,
  processing,
  library = "papers",
  chapter,
  epubChapter,
  promptHost,
  translationSetup,
  showProgress = false,
  hidden = false,
  actionsHost,
  flowEntry,
  onJobChange,
}: {
  documentId: string;
  processing?: Processing;
  library?: LibraryMode;
  /** The chapter at the reading position, read when the button is pressed. */
  chapter?: () => PageRange | undefined;
  epubChapter?: () => EPUBLocation | undefined;
  promptHost?: HTMLElement | null;
  translationSetup?: TranslationSetup;
  showProgress?: boolean;
  hidden?: boolean;
  actionsHost?: HTMLElement | null;
  flowEntry?: Ref<(trigger: HTMLButtonElement) => void>;
  onJobChange?: (job: Processing | undefined) => void;
}) {
  const [saved, setSaved] = useState<Processing>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const serial = useRef(0);
  const job =
    saved?.documentId === documentId &&
    (!processing ||
      Date.parse(saved.updatedAt) > Date.parse(processing.updatedAt))
      ? saved
      : processing;
  useEffect(() => {
    onJobChange?.(job);
  }, [job, onJobChange]);
  useEffect(() => {
    let alive = true;
    setSaved(undefined);
    setBusy(false);
    setConfirming(false);
    void api
      .assistance(documentId)
      .then((p) => {
        if (alive) setSaved(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
      serial.current++;
    };
  }, [documentId]);
  const complete = job?.status === "complete";
  const paperParsing =
    library === "papers" &&
    !epubChapter &&
    job?.phase === "learning" &&
    !job.retranslating &&
    !complete;
  const parsingPending = paperParsing && job.status !== "failed";
  const [action, label]: [Action, string] =
    job?.enabled && job.status === "failed"
      ? ["resume", "重试翻译"]
      : job?.enabled && !complete
        ? ["pause", "暂停翻译"]
        : !job?.enabled
          ? epubChapter &&
            (!job?.startedAt || job.translating?.status === "complete")
            ? ["chapter", "翻译本章"]
            : job?.startedAt && !job.manualTranslation
              ? ["resume", "继续翻译"]
              : ["start", "翻译"]
          : library === "books"
            ? ["chapter", "翻译本章"]
            : ["start", "翻译完成"];
  const finished = complete && action !== "chapter";
  const actionLabel = paperParsing
    ? job.status === "failed"
      ? "重试解析"
      : job.status === "running"
        ? "解析中"
        : "等待解析"
    : job?.retranslating
      ? action === "pause"
        ? "暂停重译"
        : "继续重译"
      : label;
  const run = async (requestedAction: Action) => {
    if (requestedAction !== "chapter")
      return api.setAssistance(documentId, requestedAction);
    if (epubChapter) {
      const location = epubChapter();
      if (!location?.href) throw new Error("正文仍在加载，请稍后再试");
      await api.translateEPUBChapter(documentId, location);
      return api.assistance(documentId);
    }
    const range = chapter?.();
    if (!range) return undefined;
    const result = await api.translateRange(
      documentId,
      range.fromPage,
      range.toPage,
    );
    if (result.parsing) toast("正在解析本章，完成后开始翻译");
    return api.assistance(documentId);
  };
  const runAction = async (requestedAction: Action = action) => {
    if (busy) return;
    const operation = ++serial.current;
    setBusy(true);
    try {
      const next = await run(requestedAction);
      if (next && operation === serial.current) setSaved(next);
    } catch (e) {
      if (operation === serial.current) toast.error((e as Error).message);
    } finally {
      if (operation === serial.current) setBusy(false);
    }
  };
  useImperativeHandle(flowEntry, () => (trigger) => {
    if (translationSetup?.connectionRequired) {
      translationSetup.open("connection", trigger);
    } else {
      void runAction("start-flow");
    }
  });
  const done = job?.translationsDone ?? 0;
  const total = job?.translationsTotal ?? 0;
  const translated =
    !job?.retranslating &&
    (job?.phase === "ready" ||
      job?.translating?.status === "complete" ||
      (total > 0 && done >= total));
  const needsPrompt =
    promptHost && job && !complete && !paperParsing && !translated;
  const moveAction = needsPrompt && action !== "pause" && action !== "chapter";
  const translationStatus = job?.translating?.status ?? job?.status;
  const waitingForSetup =
    needsPrompt && job.enabled && translationStatus === "waiting";
  const setupSection =
    translationSetup &&
    (translationSetup.connectionRequired && (moveAction || waitingForSetup)
      ? "connection"
      : waitingForSetup
        ? "models"
        : undefined);
  const promptDetail =
    done > 0 && done < total
      ? `已翻译 ${done} / ${total} 段`
      : setupSection
        ? "完成配置后即可翻译全文。"
        : undefined;
  // Jobs created before origin was persisted can still report their translation
  // stage. Plain legacy PDF parsing does not imply a pending translation.
  const hasTranslationStage =
    job?.phase === "translating" || job?.translating !== undefined;
  const showTranslationProgress =
    showProgress &&
    action === "pause" &&
    (job?.translationOrigin === "manual" ||
      (job?.translationOrigin === undefined && hasTranslationStage)) &&
    (translationStatus === "queued" || translationStatus === "running");
  const measuredProgress =
    hasTranslationStage && translationStatus === "running" && total > 0;
  if (hidden) return null;
  const actionButton = !moveAction &&
    !(showTranslationProgress && parsingPending) && (
      <Button
        variant="ghost"
        size={showTranslationProgress ? "icon-sm" : "sm"}
        aria-label={showTranslationProgress ? actionLabel : undefined}
        disabled={busy || !job || finished || parsingPending}
        title={
          showTranslationProgress
            ? actionLabel
            : action === "chapter"
              ? "翻译当前完整章节，复用已完成译文"
              : job?.enabled
                ? job.detail
                : epubChapter
                  ? "继续已请求章节的翻译"
                  : "使用当前 AI 连接翻译全文与公式"
        }
        onClick={() => void runAction()}
      >
        {parsingPending ? (
          <FileSearch />
        ) : finished ? (
          <Check />
        ) : action === "pause" ? (
          <Pause />
        ) : action === "resume" && job?.status === "failed" ? (
          <RotateCcw />
        ) : (
          <Languages />
        )}
        {!showTranslationProgress && actionLabel}
      </Button>
    );
  const actions = (
    <div className="assistance-controls">
      {showTranslationProgress ? (
        <div className="translation-task-progress">
          <ReadingTranslationProgress
            label={
              paperParsing
                ? "正在准备翻译"
                : translationStatus === "queued"
                  ? "等待翻译"
                  : "翻译进度"
            }
            percent={
              measuredProgress ? Math.min(99, (done / total) * 100) : undefined
            }
            compact
          />
          {actionButton}
        </div>
      ) : (
        actionButton
      )}
      {finished && library === "papers" && !epubChapter && (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                title="重新翻译"
                aria-label="重新翻译"
              />
            }
          >
            <RotateCcw />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>重新翻译全文？</AlertDialogTitle>
              <AlertDialogDescription>
                将重新解析全文版面，并使用当前 Agent
                翻译模型和已保存的翻译提示词重新翻译。解析成功前保留现有内容；仍能对应原文的旧译文会在新结果完成后逐段替换。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
              <Button
                disabled={busy}
                onClick={async () => {
                  const operation = ++serial.current;
                  setBusy(true);
                  try {
                    const next = await api.setAssistance(
                      documentId,
                      "retranslate",
                    );
                    if (operation === serial.current) {
                      setConfirming(false);
                      setSaved(next);
                    }
                  } catch (e) {
                    if (operation === serial.current)
                      toast.error((e as Error).message);
                  } finally {
                    if (operation === serial.current) setBusy(false);
                  }
                }}
              >
                {busy ? "正在开始…" : "开始重新翻译"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
  return (
    <>
      {actionsHost === undefined
        ? actions
        : actionsHost && createPortal(actions, actionsHost)}
      {promptHost &&
        job &&
        (moveAction || setupSection) &&
        createPortal(
          <div className="translation-prompt">
            <div className="translation-prompt-copy" role="status">
              <strong>
                {job.retranslating
                  ? "重译尚未完成"
                  : done > 0
                    ? "译文尚未完成"
                    : "这篇论文还没有译文"}
              </strong>
              {promptDetail && <span>{promptDetail}</span>}
            </div>
            <Button
              className="translation-prompt-action"
              size="sm"
              disabled={busy}
              onClick={(event) => {
                if (setupSection)
                  translationSetup?.open(setupSection, event.currentTarget);
                else void runAction();
              }}
            >
              <Languages aria-hidden="true" />
              {setupSection === "connection"
                ? "配置 AI 连接"
                : setupSection === "models"
                  ? "配置翻译模型"
                  : busy
                    ? "正在提交…"
                    : actionLabel === "翻译"
                      ? "开始翻译"
                      : actionLabel}
            </Button>
          </div>,
          promptHost,
        )}
    </>
  );
}
