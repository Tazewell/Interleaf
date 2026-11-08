import { afterEach, expect, it, vi } from "vitest";
import { blockImageCache } from "./block-images";

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("runs two crops at a time with at most 32 pending requests", async () => {
  const work = Array.from({ length: 34 }, () => deferred<Blob>());
  const render = vi.fn(
    (_id: string, _signal: AbortSignal, _width: number) =>
      work[render.mock.calls.length - 1].promise,
  );
  const cache = blockImageCache(render);
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:ok",
    revokeObjectURL: vi.fn(),
  });
  const requests = Array.from({ length: 34 }, (_, i) =>
    cache.url(`p1-b${i}`, 600),
  );
  const settled = Promise.allSettled(requests);
  expect(render).toHaveBeenCalledTimes(2);
  await expect(cache.url("overflow", 600)).rejects.toThrow();
  work[0].resolve(new Blob());
  await requests[0];
  await Promise.resolve();
  expect(render).toHaveBeenCalledTimes(3);
  cache.dispose();
  work.forEach((job) => job.resolve(new Blob()));
  await settled;
});

it("cancels queued consumers and aborts active work only after the last lease", async () => {
  const job = deferred<Blob>();
  const render = vi.fn(
    (_id: string, _signal: AbortSignal, _width: number) => job.promise,
  );
  const cache = blockImageCache(render);
  const first = new AbortController(),
    second = new AbortController(),
    queued = new AbortController();
  const p1 = cache.url("same", 600, first.signal);
  const p2 = cache.url("same", 600, second.signal);
  const active = cache.url("other", 600);
  const waiting = cache.url("queued", 600, queued.signal);
  const done = Promise.allSettled([p1, p2, active, waiting]);
  queued.abort();
  first.abort();
  expect(render.mock.calls[0][1].aborted).toBe(false);
  second.abort();
  expect(render.mock.calls[0][1].aborted).toBe(true);
  cache.dispose();
  job.resolve(new Blob());
  await done;
  expect(render).toHaveBeenCalledTimes(2);
});

it("bounds idle URL retention while preserving leased and superseded images", async () => {
  let next = 0;
  const revoke = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${++next}`,
    revokeObjectURL: revoke,
  });
  const cache = blockImageCache(async () => new Blob());
  const lease = new AbortController();
  expect(await cache.url("figure", 600, lease.signal, "crop-a")).toBe("blob:1");
  await cache.url("figure", 1200, undefined, "crop-a");
  for (let i = 0; i < 20; i++) await cache.url(`extra-${i}`, 600);
  expect(revoke).not.toHaveBeenCalledWith("blob:1");
  expect(next - revoke.mock.calls.length).toBeLessThanOrEqual(17);
  lease.abort();
  expect(revoke).toHaveBeenCalledWith("blob:1");
  cache.dispose();
  expect(new Set(revoke.mock.calls.map(([url]) => url)).size).toBe(next);
});

it("isolates crop revisions and refuses work after disposal", async () => {
  let next = 0;
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${++next}`,
    revokeObjectURL: vi.fn(),
  });
  const render = vi.fn(async () => new Blob());
  const cache = blockImageCache(render);
  expect(await cache.url("same", 600, undefined, "crop-a")).toBe("blob:1");
  expect(await cache.url("same", 600, undefined, "crop-b")).toBe("blob:2");
  cache.dispose();
  await expect(cache.url("same", 600)).rejects.toThrow();
  expect(render).toHaveBeenCalledTimes(2);
});

it("cancels an unfinished old revision without caching a late blob", async () => {
  const old = deferred<Blob>();
  const create = vi.fn(() => "blob:new");
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
  const render = vi.fn((_id: string, _signal: AbortSignal, _width: number) =>
    render.mock.calls.length === 1 ? old.promise : Promise.resolve(new Blob()),
  );
  const cache = blockImageCache(render);
  const previous = cache.url("same", 600, new AbortController().signal, "old");
  const rejected = expect(previous).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(await cache.url("same", 600, undefined, "new")).toBe("blob:new");
  expect(render.mock.calls[0][1].aborted).toBe(true);
  old.resolve(new Blob());
  await rejected;
  await Promise.resolve();
  expect(create).toHaveBeenCalledTimes(1);
  cache.dispose();
});

it("reuses a block render unless a wider one is needed", async () => {
  let next = 0;
  const revoke = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${++next}`,
    revokeObjectURL: revoke,
  });
  const render = vi.fn(async () => new Blob());
  const cache = blockImageCache(render);
  expect(await cache.url("p1-b1", 600)).toBe("blob:1");
  expect(await cache.url("p1-b1", 700)).toBe("blob:1");
  expect(render).toHaveBeenCalledWith("p1-b1", expect.any(AbortSignal), 768);
  expect(await cache.url("p1-b1", 1200)).toBe("blob:2");
  cache.dispose();
  expect(revoke).toHaveBeenCalledWith("blob:1");
  expect(revoke).toHaveBeenCalledWith("blob:2");
});

it("retries a block whose render failed", async () => {
  const render = vi
    .fn()
    .mockRejectedValueOnce(new Error("busy"))
    .mockResolvedValue(new Blob());
  vi.stubGlobal("URL", { createObjectURL: () => "blob:ok" });
  const cache = blockImageCache(render);
  await expect(cache.url("p1-b1", 600)).rejects.toThrow("busy");
  expect(await cache.url("p1-b1", 600)).toBe("blob:ok");
});
