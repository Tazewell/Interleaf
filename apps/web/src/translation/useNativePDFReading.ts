import { useEffect, useReducer, useRef, useState } from "react";
import type {
  NativePDFReadingJob,
  NativePDFReadingLayout,
} from "@interleaf/core";
import { api } from "@interleaf/api";

type Session = {
  documentId: string;
  active: boolean;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  job?: NativePDFReadingJob;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "原版式生成失败，请重试";

/** Leaving the view detaches; only the explicit cancel action cancels accepted work. */
export function useNativePDFReading(
  documentId: string,
  revision: string,
  layout: NativePDFReadingLayout = "side-by-side",
) {
  const [attempt, retry] = useReducer((value: number) => value + 1, 0);
  const [job, setJob] = useState<NativePDFReadingJob>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const session = useRef<Session | undefined>(undefined);
  useEffect(() => {
    const current: Session = {
      documentId,
      active: true,
      controller: new AbortController(),
    };
    session.current = current;
    setJob(undefined);
    setError("");
    setBusy(true);
    setCancelling(false);
    const alive = () => current.active && session.current === current;
    const accept = (value: NativePDFReadingJob) => {
      if (!alive()) return;
      current.job = value;
      setJob(value);
      if (value.status === "ready" || value.status === "failed") {
        setBusy(false);
        if (value.status === "failed")
          setError(value.error || "原版式生成失败，请重试");
        return;
      }
      current.timer = setTimeout(() => void poll(), 750);
    };
    const failed = (reason: unknown) => {
      if (!alive() || current.controller.signal.aborted) return;
      setBusy(false);
      setError(message(reason));
    };
    const poll = async () => {
      if (!alive() || !current.job) return;
      try {
        accept(
          await api.nativePDFReading(
            documentId,
            current.job.id,
            current.controller.signal,
          ),
        );
      } catch (reason) {
        failed(reason);
      }
    };
    void api
      .createNativePDFReading(documentId, current.controller.signal, layout)
      .then(accept, failed);
    return () => {
      current.active = false;
      current.controller.abort();
      clearTimeout(current.timer);
    };
  }, [documentId, revision, layout, attempt]);
  const cancel = async () => {
    const current = session.current;
    if (!current?.active || !current.job || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelNativePDFReading(current.documentId, current.job.id);
      if (!current.active || session.current !== current) return;
      current.active = false;
      current.controller.abort();
      clearTimeout(current.timer);
      setJob(undefined);
      setBusy(false);
      setError("已取消生成");
    } catch (reason) {
      if (current.active && session.current === current)
        setError(message(reason));
    } finally {
      if (session.current === current) setCancelling(false);
    }
  };
  return { job, error, busy, cancelling, cancel, retry };
}
