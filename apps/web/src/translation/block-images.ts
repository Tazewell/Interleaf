type Render = (
  blockId: string,
  signal: AbortSignal,
  width: number,
) => Promise<Blob>;

export type BlockImageRender = (
  blockId: string,
  width: number,
  signal?: AbortSignal,
  sourceKey?: string,
) => Promise<string>;

interface Entry {
  blockId: string;
  sourceKey: string;
  width: number;
  controller: AbortController;
  state: "queued" | "running" | "complete" | "cancelled";
  clients: Set<object>;
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (reason: unknown) => void;
  url?: string;
  superseded?: boolean;
  used: number;
}

const aborted = () => new DOMException("图片加载已取消", "AbortError");

/** Leased sharp crops: two renders, 32 waiters, and 16 unused completed URLs. */
export function blockImageCache(render: Render) {
  const entries = new Map<string, Entry>();
  const all = new Set<Entry>();
  const queue: Entry[] = [];
  let active = 0,
    clock = 0,
    disposed = false;

  function forget(entry: Entry) {
    if (entries.get(entry.blockId) === entry) entries.delete(entry.blockId);
    all.delete(entry);
    if (entry.url) {
      URL.revokeObjectURL(entry.url);
      entry.url = undefined;
    }
  }
  function cancel(entry: Entry) {
    if (entry.state === "cancelled") return;
    entry.state = "cancelled";
    entry.controller.abort();
    entry.reject(aborted());
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    forget(entry);
  }
  function trim() {
    const idle: Entry[] = [];
    for (const entry of all) {
      if (entry.state !== "complete" || entry.clients.size) continue;
      if (entry.superseded) forget(entry);
      else idle.push(entry);
    }
    idle
      .sort((a, b) => b.used - a.used)
      .slice(16)
      .forEach(forget);
  }
  function pump() {
    while (!disposed && active < 2 && queue.length) {
      const entry = queue.shift()!;
      entry.state = "running";
      active++;
      void (async () => {
        try {
          const blob = await render(
            entry.blockId,
            entry.controller.signal,
            entry.width,
          );
          entry.controller.signal.throwIfAborted();
          entry.url = URL.createObjectURL(blob);
          entry.state = "complete";
          entry.used = ++clock;
          entry.resolve(entry.url);
          trim();
        } catch (error) {
          entry.reject(error);
          forget(entry);
        } finally {
          active--;
          pump();
        }
      })();
    }
  }
  function consume(entry: Entry, signal?: AbortSignal) {
    const client = {};
    entry.clients.add(client);
    entry.used = ++clock;
    return new Promise<string>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", onAbort);
        entry.controller.signal.removeEventListener("abort", onAbort);
        entry.clients.delete(client);
        if (
          !entry.clients.size &&
          (entry.state === "queued" || entry.state === "running")
        )
          cancel(entry);
        trim();
      };
      const onAbort = () => {
        reject(aborted());
        release();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.controller.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      entry.promise.then(
        (url) => {
          if (released) return;
          resolve(url);
          // A provided signal holds the URL until the consumer stops displaying it.
          if (!signal) release();
        },
        (error) => {
          reject(error);
          release();
        },
      );
    });
  }
  const url: BlockImageRender = (blockId, width, signal, sourceKey = "") => {
    if (disposed || signal?.aborted) return Promise.reject(aborted());
    width = Number.isFinite(width)
      ? Math.max(256, Math.ceil(width / 256) * 256)
      : 256;
    const previous = entries.get(blockId);
    if (previous && previous.sourceKey === sourceKey && previous.width >= width)
      return consume(previous, signal);
    if (active >= 2 && queue.length >= 32)
      return Promise.reject(new Error("图片渲染队列已满"));
    if (previous) {
      previous.superseded = true;
      // A different crop cannot reuse unfinished work for the old source.
      if (previous.sourceKey !== sourceKey && previous.state !== "complete")
        cancel(previous);
    }
    let resolve!: Entry["resolve"], reject!: Entry["reject"];
    const promise = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const entry: Entry = {
      blockId,
      sourceKey,
      width,
      controller: new AbortController(),
      state: "queued",
      clients: new Set(),
      promise,
      resolve,
      reject,
      used: ++clock,
    };
    entries.set(blockId, entry);
    all.add(entry);
    queue.push(entry);
    const result = consume(entry, signal);
    trim();
    pump();
    return result;
  };
  return {
    url,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of all) cancel(entry);
      entries.clear();
    },
  };
}
