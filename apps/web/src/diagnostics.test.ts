// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  exportDiagnostics,
  installDiagnostics,
  recordLibraryReady,
} from "./diagnostics";
import { DiagnosticExport } from "./DiagnosticExport";
import { AppCrash, ErrorBoundary } from "./ErrorBoundary";
import { createRoot } from "react-dom/client";
import { act, createElement } from "react";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.interleafDesktop;
});
it("exports through the desktop bridge even when all network requests fail", async () => {
  const exportBundle = vi.fn().mockResolvedValue(true),
    record = vi.fn();
  Object.defineProperty(window, "interleafDesktop", {
    configurable: true,
    value: { exportDiagnostics: exportBundle, recordDiagnostic: record },
  });
  const fetch = vi.fn().mockRejectedValue(new Error("sidecar down"));
  vi.stubGlobal("fetch", fetch);
  const remove = installDiagnostics("private-token");
  try {
    expect(await exportDiagnostics()).toBe(true);
    expect(exportBundle).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    const error = new Error("PRIVATE DOCUMENT");
    window.dispatchEvent(new ErrorEvent("error", { error }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-token");
    expect(JSON.stringify(record.mock.calls)).not.toContain("PRIVATE DOCUMENT");
    expect(JSON.stringify(record.mock.calls)).toContain("window.error");
  } finally {
    remove();
  }
});

it("reports the buffered first contentful paint timestamp once", () => {
  const record = vi.fn();
  Object.defineProperty(window, "interleafDesktop", {
    configurable: true,
    value: { recordDiagnostic: record },
  });
  type PaintEntry = Pick<PerformanceEntry, "name" | "startTime">;
  let deliver: ((entries: PaintEntry[]) => void) | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      static supportedEntryTypes = ["paint"];
      observe = observe;
      disconnect = disconnect;
      constructor(
        callback: (list: { getEntries: () => PaintEntry[] }) => void,
      ) {
        deliver = (entries) => callback({ getEntries: () => entries });
      }
    },
  );
  vi.spyOn(window.performance, "now").mockReturnValue(500);

  const remove = installDiagnostics("private-token");
  try {
    expect(observe).toHaveBeenCalledWith({ type: "paint", buffered: true });
    deliver?.([
      { name: "first-paint", startTime: 100 },
      { name: "first-contentful-paint", startTime: 123.25 },
    ]);
    deliver?.([{ name: "first-contentful-paint", startTime: 200 }]);
    expect(record.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ event: "renderer.start" }),
      {
        level: "info",
        event: "renderer.first_contentful_paint",
        durationMs: 123.25,
      },
    ]);
    expect(disconnect).toHaveBeenCalled();
  } finally {
    remove();
  }
});

it("keeps diagnostics active if observing paint throws", () => {
  const record = vi.fn();
  Object.defineProperty(window, "interleafDesktop", {
    configurable: true,
    value: { recordDiagnostic: record },
  });
  const observe = vi.fn(() => {
    throw new TypeError("paint observation is unavailable");
  });
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      static supportedEntryTypes = ["paint"];
      observe = observe;
      disconnect() {}
    },
  );

  const remove = installDiagnostics("private-token");
  try {
    expect(observe).toHaveBeenCalledOnce();
    window.dispatchEvent(new ErrorEvent("error", { error: new Error() }));
    expect(record.mock.calls.map(([event]) => event.event)).toEqual([
      "renderer.start",
      "window.error",
    ]);
  } finally {
    remove();
  }
});

it("records library readiness once from the navigation clock when visible", () => {
  const record = vi.fn();
  Object.defineProperty(window, "interleafDesktop", {
    configurable: true,
    value: { recordDiagnostic: record },
  });
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const now = vi.spyOn(window.performance, "now").mockReturnValue(250);

  recordLibraryReady();
  expect(record).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  now.mockReturnValue(347.75);
  recordLibraryReady();
  now.mockReturnValue(500);
  recordLibraryReady();

  expect(record.mock.calls).toEqual([
    [{ level: "info", event: "renderer.library_ready", durationMs: 347.75 }],
  ]);
});

it("keeps the export action inside the React crash fallback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const exportBundle = vi.fn().mockResolvedValue(true),
    record = vi.fn();
  Object.defineProperty(window, "interleafDesktop", {
    configurable: true,
    value: { exportDiagnostics: exportBundle, recordDiagnostic: record },
  });
  const rootElement = document.createElement("div");
  const root = createRoot(rootElement);
  function Broken() {
    throw new Error("PRIVATE QUESTION");
    return createElement(DiagnosticExport);
  }
  try {
    await act(async () =>
      root.render(
        createElement(
          ErrorBoundary,
          { fallback: createElement(AppCrash) },
          createElement(Broken),
        ),
      ),
    );
    expect(rootElement.textContent).toContain("界面出现错误");
    const exportButton = Array.from(
      rootElement.querySelectorAll("button"),
    ).find((b) => b.textContent?.includes("导出全部日志"))!;
    await act(async () => exportButton.click());
    expect(exportBundle).toHaveBeenCalledOnce();
    expect(JSON.stringify(record.mock.calls)).toContain("react.render_failed");
    expect(JSON.stringify(record.mock.calls)).not.toContain("PRIVATE QUESTION");
  } finally {
    await act(async () => root.unmount());
  }
});
