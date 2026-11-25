import { useRef, useState, type ReactNode } from "react";
import {
  CaretRight,
  FileText,
  Pulse,
  TextAlignLeft,
  X,
} from "@phosphor-icons/react";
import type { NativePDFReadingJob } from "@interleaf/core";
import { Button } from "@interleaf/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@interleaf/ui/components/alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@interleaf/ui/components/popover";
import type { TranslationSetup } from "./AssistanceControls";
import { ReadingTranslationProgress } from "./ReadingTranslationProgress";

export function PDFTranslationChooser({
  onFlow,
  onOriginal,
  flowNeedsConnection,
  originalLabel,
}: {
  onFlow: (trigger: HTMLButtonElement) => void;
  onOriginal: (trigger: HTMLButtonElement) => void;
  flowNeedsConnection?: boolean;
  originalLabel?: string;
}) {
  return (
    <div className="pdf-translation-empty">
      <div className="pdf-translation-chooser">
        <h2>选择翻译方式</h2>
        {!originalLabel && <p>这篇论文还没有译文。</p>}
        <div className="pdf-translation-options">
          <Button
            className="pdf-translation-option"
            variant="outline"
            onClick={(event) => onFlow(event.currentTarget)}
          >
            <TextAlignLeft aria-hidden="true" />
            <span>
              <strong>
                {flowNeedsConnection ? "配置 AI 连接" : "开始流式翻译"}
              </strong>
              <small>
                {flowNeedsConnection
                  ? "配置后即可开始流式翻译。"
                  : "逐段生成，完成一段即可阅读。"}
              </small>
            </span>
            <CaretRight aria-hidden="true" />
          </Button>
          <Button
            className="pdf-translation-option"
            variant="outline"
            onClick={(event) => onOriginal(event.currentTarget)}
          >
            <FileText aria-hidden="true" />
            <span>
              <strong>{originalLabel ?? "生成原版译文"}</strong>
              <small>
                {originalLabel
                  ? "保留原页布局与图表位置。"
                  : "保留原页布局与图表位置，整篇生成后阅读。"}
              </small>
            </span>
            <CaretRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PDFOriginalConfirmation({
  open,
  onOpenChange,
  onConfirm,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const later = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        initialFocus={later}
        finalFocus={() => (returnFocus?.isConnected ? returnFocus : undefined)}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>生成原版译文？</AlertDialogTitle>
          <AlertDialogDescription>
            原版译文需要单独生成，会保留原文版面和图表位置。耗时取决于论文长度和模型响应，可能需要等几分钟。等待期间可以继续阅读。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={later}>暂不生成</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>开始生成</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function PDFTranslationTasks({
  running,
  children,
}: {
  running: number;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            className="pdf-translation-tasks-trigger"
            variant="outline"
            size="sm"
          />
        }
        aria-label={running > 0 ? `翻译任务（${running} 项进行中）` : undefined}
      >
        <Pulse aria-hidden="true" />
        翻译任务
        {running > 0 && (
          <span className="pdf-translation-task-count" aria-hidden="true">
            {running}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="pdf-translation-task-list"
      >
        <PopoverHeader className="pdf-translation-task-list-header">
          <PopoverTitle>翻译任务</PopoverTitle>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="关闭翻译任务"
            onClick={close}
          >
            <X aria-hidden="true" />
          </Button>
        </PopoverHeader>
        {typeof children === "function" ? children(close) : children}
      </PopoverContent>
    </Popover>
  );
}

export function PDFOriginalPending({
  job,
  busy,
  error,
  cancelling,
  onRetry,
  onCancel,
  onUseFlow,
  onViewSource,
  flowActionLabel = "使用流式翻译排版",
  translationSetup,
}: {
  job?: NativePDFReadingJob;
  busy: boolean;
  error: string;
  cancelling: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onUseFlow: (trigger: HTMLButtonElement) => void;
  onViewSource?: () => void;
  flowActionLabel?: string;
  translationSetup?: TranslationSetup;
}) {
  const pending = job?.status === "preparing" || job?.status === "running";
  const progressUnavailable = !busy && !!error && pending;
  const setupSection =
    translationSetup &&
    !busy &&
    (error.includes("AI 设置") || error.includes("OpenAI 兼容"))
      ? translationSetup.connectionRequired || error.includes("OpenAI 兼容")
        ? "connection"
        : "models"
      : undefined;
  return (
    <div className="native-pdf-state pdf-original-pending">
      {busy && (
        <ReadingTranslationProgress
          label="原版翻译进度"
          percent={job?.progress?.percent}
        />
      )}
      {(!busy || error) && (
        <p role="status" title={progressUnavailable ? error : undefined}>
          {progressUnavailable ? "暂无法获取进度" : error || "原版译文暂不可用"}
        </p>
      )}
      <div className="native-pdf-state-actions">
        {setupSection && translationSetup && (
          <Button
            variant="outline"
            size="sm"
            onClick={(event) =>
              translationSetup.open(setupSection, event.currentTarget)
            }
          >
            {setupSection === "connection" ? "配置 AI 连接" : "配置翻译模型"}
          </Button>
        )}
        {!busy && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            重试
          </Button>
        )}
        {busy && job?.id && (
          <Button
            variant="outline"
            size="sm"
            disabled={cancelling}
            onClick={onCancel}
          >
            {cancelling ? "正在取消…" : "取消生成"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={(event) => onUseFlow(event.currentTarget)}
        >
          {flowActionLabel}
        </Button>
        {onViewSource && (
          <Button variant="ghost" size="sm" onClick={onViewSource}>
            查看原文
          </Button>
        )}
      </div>
      {busy && pending && !cancelling && (
        <p className="native-pdf-background-hint">
          可以继续读原文，或返回书库。任务会在后台继续。
        </p>
      )}
    </div>
  );
}
