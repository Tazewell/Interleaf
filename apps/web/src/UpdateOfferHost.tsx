import { useEffect, useRef, useState } from "react";
import { ArrowRight, DownloadSimple } from "@phosphor-icons/react";
import type { UpdateOffer } from "@interleaf/core";
import { Button } from "@interleaf/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@interleaf/ui/components/dialog";

export function UpdateOfferHost({ onOffer }: { onOffer?: () => void }) {
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [submission, setSubmission] = useState<"idle" | "busy" | "failed">(
    "idle",
  );
  const pending = useRef<{ offer: UpdateOffer; submitting: boolean } | null>(
    null,
  );
  const later = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const desktop = window.interleafDesktop;
    if (!desktop?.respondToUpdateOffer) return;
    const unsubscribe = desktop.onUpdateOffer?.((next) => {
      if (pending.current?.offer.id === next.id) return;
      pending.current = { offer: next, submitting: false };
      setOffer(next);
      setSubmission("idle");
      onOffer?.();
    });
    return () => {
      unsubscribe?.();
      pending.current = null;
    };
  }, [onOffer]);

  if (!offer) return null;
  const respond = async (accepted: boolean) => {
    const current = pending.current;
    const desktop = window.interleafDesktop;
    if (
      current?.offer !== offer ||
      current.submitting ||
      !desktop?.respondToUpdateOffer
    )
      return;
    current.submitting = true;
    setSubmission("busy");
    try {
      await desktop.respondToUpdateOffer(offer.id, accepted);
      if (pending.current === current) {
        pending.current = null;
        setOffer(null);
      }
    } catch {
      if (pending.current === current) {
        current.submitting = false;
        setSubmission("failed");
      }
    }
  };
  const installs = offer.actionLabel === "下载并安装";
  const busy = submission === "busy";

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) void respond(false);
      }}
    >
      <DialogContent
        className="update-offer-dialog"
        initialFocus={later}
        showCloseButton={false}
      >
        <DialogHeader className="update-offer-header">
          <img
            className="size-9 shrink-0 rounded-lg dark:hidden"
            src="/brand/logo.svg?v=green-1"
            alt=""
          />
          <img
            className="hidden size-9 shrink-0 rounded-lg dark:block"
            src="/brand/logo-dark.svg?v=green-1"
            alt=""
          />
          <DialogTitle>纸间有新版本</DialogTitle>
        </DialogHeader>
        <dl className="update-offer-versions">
          <div>
            <dt>当前版本</dt>
            <dd>{offer.currentVersion}</dd>
          </div>
          <ArrowRight aria-hidden="true" />
          <div>
            <dt>新版本</dt>
            <dd>{offer.version}</dd>
          </div>
        </dl>
        <DialogDescription>
          {installs
            ? "下载并校验后，纸间会保存阅读数据、退出并自动安装。安装完成后会重新打开。"
            : "下载并校验后会打开磁盘映像。退出纸间，再将新版拖入「应用程序」。"}
        </DialogDescription>
        {submission === "failed" && (
          <p role="alert" className="m-0 text-destructive">
            无法提交更新选择，请重试。
          </p>
        )}
        <DialogFooter className="update-offer-footer">
          <Button
            ref={later}
            variant="ghost"
            size="lg"
            disabled={busy}
            onClick={() => void respond(false)}
          >
            稍后
          </Button>
          <Button
            className="update-offer-action"
            size="lg"
            disabled={busy}
            onClick={() => void respond(true)}
          >
            <DownloadSimple aria-hidden="true" />
            {offer.actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
