// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  NativePDFReadingEngine,
  NativePDFReadingJob,
  NativePDFReadingLayout,
} from "@interleaf/core";
const apiMock = vi.hoisted(() => ({
  createNativePDFReading: vi.fn(),
  nativePDFReading: vi.fn(),
  cancelNativePDFReading: vi.fn(async () => {}),
  translate: vi.fn(),
}));
vi.mock("@interleaf/api", () => ({ api: apiMock }));
import { useNativePDFReading } from "./useNativePDFReading";

let root: Root, host: HTMLDivElement;
let current: ReturnType<typeof useNativePDFReading>;
function Probe({
  id = "doc",
  revision = "r1",
  layout = "side-by-side",
  engine,
}: {
  id?: string;
  revision?: string;
  layout?: NativePDFReadingLayout;
  engine?: NativePDFReadingEngine;
}) {
  current = useNativePDFReading(id, revision, layout, engine);
  return <span>{current.job?.cacheKey ?? current.error}</span>;
}
const job = (key: string, status: NativePDFReadingJob["status"] = "ready") =>
  ({
    id: `job-${key}`,
    cacheKey: key,
    status,
    stage: status === "ready" ? "ready" : "prepare",
    done: 0,
    total: 1,
  }) as NativePDFReadingJob;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
it("isolates layout requests and ignores a late result from the previous layout", async () => {
  let finishDual!: (value: NativePDFReadingJob) => void;
  apiMock.createNativePDFReading.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishDual = resolve;
      }),
  );
  apiMock.createNativePDFReading.mockResolvedValueOnce(job("single"));
  await act(async () => root.render(<Probe />));
  const previous = apiMock.createNativePDFReading.mock
    .calls[0][1] as AbortSignal;
  await act(async () => root.render(<Probe layout="translation-only" />));
  await act(async () => finishDual(job("dual")));
  expect(previous.aborted).toBe(true);
  expect(current.job?.cacheKey).toBe("single");
  expect(apiMock.createNativePDFReading).toHaveBeenLastCalledWith(
    "doc",
    expect.any(AbortSignal),
    "translation-only",
  );
  expect(apiMock.cancelNativePDFReading).not.toHaveBeenCalled();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("opens a ready cache without polling or translating", async () => {
  apiMock.createNativePDFReading.mockResolvedValueOnce(job("cached"));
  await act(async () => root.render(<Probe />));
  expect(current.job?.cacheKey).toBe("cached");
  expect(current.busy).toBe(false);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(apiMock.nativePDFReading).not.toHaveBeenCalled();
  expect(apiMock.translate).not.toHaveBeenCalled();
});
it("polls accepted work and detaches without cancelling it on unmount", async () => {
  apiMock.createNativePDFReading.mockResolvedValueOnce(job("new", "preparing"));
  apiMock.nativePDFReading.mockResolvedValueOnce(job("new"));
  await act(async () => root.render(<Probe />));
  expect(current.busy).toBe(true);
  await act(async () => vi.advanceTimersByTime(800));
  expect(apiMock.nativePDFReading).toHaveBeenCalledWith(
    "doc",
    "job-new",
    expect.any(AbortSignal),
  );
  expect(current.job?.status).toBe("ready");
  const signal = apiMock.createNativePDFReading.mock.calls[0][1] as AbortSignal;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  expect(apiMock.cancelNativePDFReading).not.toHaveBeenCalled();
});
it("ignores an old document response after switching papers", async () => {
  let resolveOld!: (value: NativePDFReadingJob) => void;
  apiMock.createNativePDFReading.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  apiMock.createNativePDFReading.mockResolvedValueOnce(job("second"));
  await act(async () => root.render(<Probe id="first" />));
  await act(async () => root.render(<Probe id="second" />));
  await act(async () => resolveOld(job("first")));
  expect(current.job?.cacheKey).toBe("second");
  expect(
    (apiMock.createNativePDFReading.mock.calls[0][1] as AbortSignal).aborted,
  ).toBe(true);
});
it("cancels only on the explicit action and ignores a late poll", async () => {
  let resolvePoll!: (value: NativePDFReadingJob) => void;
  apiMock.createNativePDFReading.mockResolvedValueOnce(job("new", "preparing"));
  apiMock.nativePDFReading.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
  );
  await act(async () => root.render(<Probe />));
  await act(async () => vi.advanceTimersByTime(800));
  await act(async () => current.cancel());
  expect(apiMock.cancelNativePDFReading).toHaveBeenCalledWith("doc", "job-new");
  await act(async () => resolvePoll(job("new")));
  expect(current.job).toBeUndefined();
  expect(current.error).toBe("已取消生成");
});
it("retries a failed request and refreshes when visible translations change", async () => {
  apiMock.createNativePDFReading.mockRejectedValueOnce(new Error("缓存已更新"));
  apiMock.createNativePDFReading.mockResolvedValueOnce(job("retry"));
  apiMock.createNativePDFReading.mockResolvedValueOnce(job("translated"));
  await act(async () => root.render(<Probe />));
  expect(current.error).toBe("缓存已更新");
  await act(async () => current.retry());
  expect(current.job?.cacheKey).toBe("retry");
  await act(async () => root.render(<Probe revision="r2" />));
  expect(current.job?.cacheKey).toBe("translated");
});

it("only sends BabelDOC retry intent for the explicit retry action", async () => {
  const rejected = job("untranslated", "failed");
  apiMock.createNativePDFReading
    .mockResolvedValueOnce(rejected)
    .mockResolvedValueOnce(rejected)
    .mockResolvedValueOnce(rejected)
    .mockResolvedValueOnce(job("other"));
  await act(async () =>
    root.render(<Probe engine="babeldoc" layout="translation-only" />),
  );
  await act(async () => current.retry());
  await act(async () =>
    root.render(
      <Probe revision="r2" engine="babeldoc" layout="translation-only" />,
    ),
  );
  await act(async () => {
    current.retry();
    root.render(
      <Probe
        id="other"
        revision="r2"
        engine="babeldoc"
        layout="translation-only"
      />,
    );
  });
  expect(apiMock.createNativePDFReading.mock.calls).toEqual([
    ["doc", expect.any(AbortSignal), "translation-only", "babeldoc"],
    ["doc", expect.any(AbortSignal), "translation-only", "babeldoc", true],
    ["doc", expect.any(AbortSignal), "translation-only", "babeldoc"],
    ["other", expect.any(AbortSignal), "translation-only", "babeldoc"],
  ]);
});
