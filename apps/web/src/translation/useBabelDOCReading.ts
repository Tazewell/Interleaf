import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { NativePDFReadingJob } from "@interleaf/core";
import { api } from "@interleaf/api";

type Snapshot = {
  job?: NativePDFReadingJob;
  checking: boolean;
  busy: boolean;
  cancelling: boolean;
  requested: boolean;
  error: string;
};
type Task = {
  snapshot: Snapshot;
  request?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Set<() => void>;
};

const idle: Snapshot = {
  checking: false,
  busy: false,
  cancelling: false,
  requested: false,
  error: "",
};
const tasks = new Map<string, Task>();
const visible = new Set<string>();
const readyListeners = new Set<(documentId: string, jobId: string) => void>();

export function observeOriginalTranslationReady(
  listener: (documentId: string, jobId: string) => void,
) {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

export function showOriginalTranslationInReader(documentId: string) {
  visible.add(documentId);
  return () => {
    visible.delete(documentId);
  };
}

function taskFor(documentId: string) {
  let task = tasks.get(documentId);
  if (!task) {
    task = { snapshot: idle, listeners: new Set() };
    tasks.set(documentId, task);
  }
  return task;
}

function publish(task: Task, snapshot: Snapshot) {
  task.snapshot = snapshot;
  for (const listener of task.listeners) listener();
}

function stop(task: Task) {
  clearTimeout(task.timer);
  task.request?.abort();
  task.request = undefined;
}

function poll(
  documentId: string,
  task: Task,
  job: NativePDFReadingJob,
  failures = 0,
) {
  const controller = task.request;
  task.timer = setTimeout(
    async () => {
      if (!controller || task.request !== controller) return;
      try {
        const result = await api.nativePDFReading(
          documentId,
          job.id,
          controller.signal,
        );
        if (task.request !== controller) return;
        accept(documentId, task, result);
        if (result.status === "ready" && !visible.has(documentId)) {
          for (const listener of readyListeners)
            listener(documentId, result.id);
        }
      } catch (error) {
        if (task.request !== controller) return;
        const status =
          error instanceof Error && "status" in error
            ? Number(error.status)
            : 0;
        if (failures < 3 && (!status || status >= 500)) {
          poll(documentId, task, job, failures + 1);
        } else {
          reject(task, controller, error);
        }
      }
    },
    750 * 2 ** failures,
  );
}

function accept(
  documentId: string,
  task: Task,
  job: NativePDFReadingJob | null,
) {
  const busy = job?.status === "preparing" || job?.status === "running";
  publish(task, {
    ...idle,
    job: job ?? undefined,
    busy,
    error: job?.status === "failed" ? job.error || "原版翻译失败，请重试" : "",
  });
  if (busy) poll(documentId, task, job);
  else task.request = undefined;
}

function reject(task: Task, controller: AbortController, error: unknown) {
  if (task.request !== controller) return;
  task.request = undefined;
  publish(task, {
    ...task.snapshot,
    checking: false,
    busy: false,
    cancelling: false,
    error: error instanceof Error ? error.message : "暂时无法获取原版翻译状态",
  });
}

async function fetchTask(
  documentId: string,
  task: Task,
  action: "lookup" | "start" | "retry",
) {
  if (task.snapshot.busy || task.snapshot.cancelling) return;
  stop(task);
  const controller = new AbortController();
  task.request = controller;
  const checking = action === "lookup";
  publish(task, {
    ...(checking ? task.snapshot : idle),
    checking,
    busy: !checking,
    requested: !checking || task.snapshot.requested,
    error: "",
  });
  try {
    const signal = controller.signal;
    const job =
      action === "lookup"
        ? await api.findNativePDFReading(documentId, signal)
        : action === "retry"
          ? await api.createNativePDFReading(
              documentId,
              signal,
              "translation-only",
              "babeldoc",
              true,
            )
          : await api.createNativePDFReading(
              documentId,
              signal,
              "translation-only",
              "babeldoc",
            );
    if (task.request === controller) accept(documentId, task, job);
  } catch (error) {
    reject(task, controller, error);
  }
}

async function cancelTask(documentId: string, task: Task) {
  const job = task.snapshot.job;
  if (!job || !task.snapshot.busy || task.snapshot.cancelling) return;
  stop(task);
  publish(task, { ...task.snapshot, cancelling: true });
  try {
    await api.cancelNativePDFReading(documentId, job.id);
    publish(task, idle);
  } catch (error) {
    task.request = new AbortController();
    publish(task, {
      ...task.snapshot,
      cancelling: false,
      error: error instanceof Error ? error.message : "取消生成失败，请重试",
    });
    poll(documentId, task, job);
  }
}

/** The renderer keeps polling accepted tasks after the reader has closed. */
export function useBabelDOCReading(documentId: string, enabled = true) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled) return () => {};
      const task = taskFor(documentId);
      task.listeners.add(listener);
      return () => {
        task.listeners.delete(listener);
      };
    },
    [documentId, enabled],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (enabled ? taskFor(documentId).snapshot : idle),
    () => idle,
  );
  useEffect(() => {
    if (enabled) {
      const task = taskFor(documentId);
      if (!task.snapshot.checking) void fetchTask(documentId, task, "lookup");
    }
  }, [documentId, enabled]);
  return {
    ...snapshot,
    start: () => fetchTask(documentId, taskFor(documentId), "start"),
    retry: () => {
      const task = taskFor(documentId);
      const job = task.snapshot.job;
      return fetchTask(
        documentId,
        task,
        job?.status === "failed" ? "retry" : job ? "lookup" : "start",
      );
    },
    cancel: () => cancelTask(documentId, taskFor(documentId)),
  };
}
