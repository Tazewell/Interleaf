// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativePDFReadingJob } from "@interleaf/core";

const api = vi.hoisted(() => ({
  findNativePDFReading: vi.fn(),
  createNativePDFReading: vi.fn(),
  nativePDFReading: vi.fn(),
  cancelNativePDFReading: vi.fn(),
}));
vi.mock("@interleaf/api", () => ({ api }));

import {
  observeOriginalTranslationReady,
  showOriginalTranslationInReader,
  useBabelDOCReading,
} from "./useBabelDOCReading";

let host: HTMLDivElement, root: Root;
let reading: ReturnType<typeof useBabelDOCReading>;
function Reader({ id }: { id: string }) {
  reading = useBabelDOCReading(id);
  return null;
}
const job = (status: NativePDFReadingJob["status"]): NativePDFReadingJob => ({
  id: "job",
  status,
  stage: status === "ready" ? "ready" : "prepare",
  cacheKey: "key",
  done: 0,
  total: 1,
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.resetAllMocks();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("looks up existing work and starts only on explicit action", async () => {
  api.findNativePDFReading.mockResolvedValue(null);
  api.createNativePDFReading.mockResolvedValue(job("ready"));
  await act(async () => root.render(<Reader id="explicit" />));
  expect(api.findNativePDFReading).toHaveBeenCalledOnce();
  expect(reading.job).toBeUndefined();
  expect(api.createNativePDFReading).not.toHaveBeenCalled();
  await act(async () => reading.start());
  expect(api.createNativePDFReading).toHaveBeenCalledWith(
    "explicit",
    expect.any(AbortSignal),
    "translation-only",
    "babeldoc",
  );
  expect(reading.job?.status).toBe("ready");
});

it("completes after leaving the reader and announces only once", async () => {
  api.findNativePDFReading
    .mockResolvedValueOnce(job("running"))
    .mockResolvedValue(job("ready"));
  api.nativePDFReading.mockResolvedValue(job("ready"));
  const listener = vi.fn();
  const stop = observeOriginalTranslationReady(listener);
  await act(async () => root.render(<Reader id="background" />));
  expect(reading.busy).toBe(true);
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(750));
  expect(listener).toHaveBeenCalledExactlyOnceWith("background", "job");
  await act(async () => root.render(<Reader id="background" />));
  expect(reading.job?.status).toBe("ready");
  expect(api.createNativePDFReading).not.toHaveBeenCalled();
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
});

it("ignores an in-flight poll when a task is explicitly canceled", async () => {
  api.findNativePDFReading.mockResolvedValue(job("running"));
  let settle!: (job: NativePDFReadingJob) => void;
  api.nativePDFReading.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  api.cancelNativePDFReading.mockResolvedValue(undefined);
  await act(async () => root.render(<Reader id="cancel" />));
  await act(async () => vi.advanceTimersByTimeAsync(750));
  await act(async () => reading.cancel());
  await act(async () => settle(job("ready")));
  expect(api.cancelNativePDFReading).toHaveBeenCalledWith("cancel", "job");
  expect(reading.job).toBeUndefined();
  expect(reading.busy).toBe(false);
});

it("resumes a dropped progress request and avoids a toast while the original is selected", async () => {
  api.findNativePDFReading.mockResolvedValue(job("running"));
  api.nativePDFReading
    .mockRejectedValueOnce(new TypeError("connection lost"))
    .mockResolvedValueOnce(job("ready"));
  const listener = vi.fn();
  const stopListening = observeOriginalTranslationReady(listener);
  const stopShowing = showOriginalTranslationInReader("visible");
  try {
    await act(async () => root.render(<Reader id="visible" />));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(reading.busy).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(reading.job?.status).toBe("ready");
    expect(api.createNativePDFReading).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  } finally {
    stopShowing();
    stopListening();
  }
});
