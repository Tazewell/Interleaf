import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// Exercise the real main-process close/flush handlers; only OS boundaries are fake.
let app: EventEmitter & {
  quit: () => void;
  relaunch: ReturnType<typeof vi.fn>;
};
let window: EventEmitter & {
  close: () => void;
  webContents: EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    mainFrame: { url: string };
  };
};
let ipc: EventEmitter;
let handlers: Map<string, (...args: any[]) => any>;
let migrate: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let showMessageBox: ReturnType<typeof vi.fn>;
let showOpenDialog: ReturnType<typeof vi.fn>;
let showErrorBox: ReturnType<typeof vi.fn>;
let execute: ReturnType<typeof vi.fn>;
let diagnosticRecords: ReturnType<typeof vi.fn>;
let recordUpdateDecision: ReturnType<typeof vi.fn>;
let serverChild: any;
let exitCount = 0;
const event = () => ({
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame,
});
const move = () => handlers.get("interleaf:move-library")!(event());

beforeEach(async (context) => {
  const startupFailure = context.task.name.includes("startup failure");
  const showDuringNavigation = context.task.name.includes("during navigation");
  const initiallyVisible =
    !showDuringNavigation && !context.task.name.includes("after DOM is ready");
  vi.resetModules();
  exitCount = 0;
  handlers = new Map();
  ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, fn: (...args: any[]) => any) =>
      handlers.set(name, fn),
  });
  app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPath: () => "/userdata",
    whenReady: async () => {},
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    relaunch: vi.fn(),
    quit: () => {
      let prevented = false;
      app.emit("before-quit", {
        preventDefault() {
          prevented = true;
        },
      });
      if (!prevented) exitCount++;
    },
  });
  showOpenDialog = vi
    .fn()
    .mockResolvedValue({ canceled: false, filePaths: ["/destination"] });
  showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
  showErrorBox = vi.fn();
  execute = vi.fn();
  diagnosticRecords = vi.fn();
  recordUpdateDecision = vi.fn();
  vi.doMock("electron", () => ({
    app,
    ipcMain: ipc,
    dialog: { showOpenDialog, showMessageBox, showErrorBox },
    session: {
      defaultSession: {
        setProxy: async () => {},
        setPermissionRequestHandler() {},
      },
    },
    nativeTheme: {},
    shell: {},
    BrowserWindow: class extends EventEmitter {
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "http://127.0.0.1:1234/" },
        send: vi.fn(),
        setWindowOpenHandler() {},
      });
      constructor() {
        super();
        window = this;
      }
      isDestroyed() {
        return this.destroyed;
      }
      isVisible() {
        return initiallyVisible;
      }
      async loadURL() {
        if (startupFailure) throw new Error("load failed");
        if (showDuringNavigation) this.emit("show");
        this.webContents.emit("dom-ready");
      }
      close() {
        let prevented = false;
        this.emit("close", {
          preventDefault() {
            prevented = true;
          },
        });
        if (!prevented) {
          this.destroyed = true;
          app.emit("window-all-closed");
        }
      }
    },
  }));
  vi.doMock("node:child_process", () => ({
    execFile: execute,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      serverChild = child;
      queueMicrotask(() =>
        child.stdout.write('{"url":"http://127.0.0.1:1234"}\n'),
      );
      return child;
    },
  }));
  vi.doMock("node:fs/promises", () => ({
    readFile: vi.fn(),
    realpath: async (path: string) => path,
    lstat: async () => {
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
  }));
  stop = vi.fn().mockImplementation(async () => {
    serverChild.emit("close", 0, null);
  });
  if (startupFailure) {
    const actual =
      await vi.importActual<typeof import("./library-location")>(
        "./library-location",
      );
    stop.mockImplementation(actual.stopLibraryServer);
  }
  migrate = vi.fn(
    async (
      _userData,
      _source,
      _target,
      _binary,
      shutdown: () => Promise<void>,
    ) => {
      await shutdown();
    },
  );
  vi.doMock("./library-location", () => ({
    libraryDirectory: async () => "/old/library",
    migrateLibrary: migrate,
    stopLibraryServer: stop,
  }));
  vi.doMock("./proxy-settings", () => ({
    ProxySettingsService: {
      open: async () => ({
        activeEnvironment: {},
        activeSettings: {},
        stop() {},
      }),
    },
    electronProxyConfiguration: () => ({}),
  }));
  vi.doMock("./update-service", () => ({
    startUpdateService: async () => ({
      stop() {},
      respondToOffer: recordUpdateDecision,
    }),
  }));
  vi.doMock("./diagnostic-service", () => ({
    startDiagnosticService: () => ({
      directory: "/logs",
      logs: { secrets: [], sessionId: "test", record: diagnosticRecords },
      record: vi.fn(),
      setSettings() {},
      failure: vi.fn().mockResolvedValue(undefined),
    }),
  }));
  vi.doMock("./clipboard", () => ({ writeClipboardText: vi.fn() }));
  vi.doMock("./endnote-discovery", () => ({ discoverEndNote: vi.fn() }));
  vi.doMock("./command-line", () => ({
    commandLineStatus: vi.fn(),
    setCommandLine: vi.fn(),
  }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
  vi.stubGlobal(
    "process",
    Object.assign(Object.create(process), {
      resourcesPath: "/resources",
      on: vi.fn(),
    }),
  );
  await import("./index");
  if (startupFailure)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  else
    await vi.waitFor(() =>
      expect(handlers.has("interleaf:check-updates")).toBe(true),
    );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("accepts an update decision only from the app main frame with a valid payload", () => {
  const respond = handlers.get("interleaf:respond-update-offer")!;
  expect(() => respond({ ...event(), senderFrame: {} }, 1, true)).toThrow(
    "Invalid sender",
  );
  expect(() => respond(event(), 1, "true")).toThrow("无效的更新选择");
  expect(() => respond(event(), 1.5, true)).toThrow("无效的更新选择");
  expect(recordUpdateDecision).not.toHaveBeenCalled();
  respond(event(), 1, true);
  expect(recordUpdateDecision).toHaveBeenCalledExactlyOnceWith(1, true);
});

it.each(["at construction", "during navigation", "after DOM is ready"])(
  "records startup once when the window becomes visible %s",
  (when) => {
    const getStartup = () =>
      diagnosticRecords.mock.calls.filter(
        ([source, value]) =>
          source === "desktop" && value.event === "startup.desktop",
      );
    if (when === "after DOM is ready") expect(getStartup()).toEqual([]);
    window.emit("show");
    window.webContents.emit("dom-ready");
    const startup = getStartup();
    expect(startup).toEqual([
      [
        "desktop",
        {
          event: "startup.desktop",
          level: "info",
          appReadyMs: expect.any(Number),
          proxySettingsDurationMs: expect.any(Number),
          electronProxyDurationMs: expect.any(Number),
          serverReadyMs: expect.any(Number),
          serverSettingsDurationMs: expect.any(Number),
          windowCreatedMs: expect.any(Number),
          windowShownMs: expect.any(Number),
          navigationStartedMs: expect.any(Number),
          domReadyMs: expect.any(Number),
          durationMs: expect.any(Number),
        },
      ],
    ]);
    const timing = startup[0][1];
    expect(timing.appReadyMs).toBeLessThanOrEqual(timing.serverReadyMs);
    expect(timing.serverReadyMs).toBeLessThanOrEqual(timing.windowCreatedMs);
    expect(timing.windowCreatedMs).toBeLessThanOrEqual(timing.windowShownMs);
    if (when === "at construction")
      expect(timing.windowShownMs).toBe(timing.windowCreatedMs);
    else
      expect(timing.windowShownMs).toBeGreaterThanOrEqual(
        when === "after DOM is ready"
          ? timing.domReadyMs
          : timing.navigationStartedMs,
      );
    expect(timing.navigationStartedMs).toBeLessThanOrEqual(timing.domReadyMs);
    expect(timing.durationMs).toBe(
      Math.max(timing.domReadyMs, timing.windowShownMs),
    );
  },
);

it("waits for flushed reading data, then copies once despite repeated quit events", async () => {
  let complete!: () => void;
  migrate.mockImplementation(async (_u, _s, _d, _b, shutdown) => {
    await shutdown();
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
  });
  const result = move();
  await vi.waitFor(() =>
    expect(window.webContents.send).toHaveBeenCalledWith("interleaf:flush"),
  );
  expect(migrate).not.toHaveBeenCalled();
  ipc.emit("interleaf:flushed", event(), null);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  app.quit();
  ipc.emit("interleaf:flushed", event(), null);
  expect(migrate).toHaveBeenCalledOnce();
  expect(app.relaunch).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  complete();
  expect(await result).toBe(true);
  expect(migrate).toHaveBeenCalledWith(
    "/userdata",
    "/old/library",
    join("/destination", "Interleaf Library"),
    expect.any(String),
    expect.any(Function),
  );
  await vi.waitFor(() => expect(app.relaunch).toHaveBeenCalledOnce());
});

it("cancels migration after a save failure and allows returning to reading", async () => {
  const result = move();
  await vi.waitFor(() =>
    expect(window.webContents.send).toHaveBeenCalledWith("interleaf:flush"),
  );
  ipc.emit("interleaf:flushed", event(), "save failed");
  expect(await result).toBe(false);
  expect(migrate).not.toHaveBeenCalled();
  expect(app.relaunch).not.toHaveBeenCalled();
  expect(showMessageBox).toHaveBeenCalledWith(
    window,
    expect.objectContaining({ message: "阅读数据尚未保存" }),
  );
  showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await move()).toBe(false);
  expect(showOpenDialog).toHaveBeenCalledTimes(2);
});

it("keeps the old library and refuses relaunch after shutdown fails", async () => {
  stop.mockRejectedValueOnce(new Error("shutdown failed"));
  const result = move();
  await vi.waitFor(() =>
    expect(window.webContents.send).toHaveBeenCalledWith("interleaf:flush"),
  );
  ipc.emit("interleaf:flushed", event(), null);
  expect(await result).toBe(false);
  expect(showMessageBox).toHaveBeenCalledWith(
    window,
    expect.objectContaining({
      message: "书库迁移失败",
      detail: expect.stringContaining("原书库已保留"),
    }),
  );
  expect(handlers.get("interleaf:library-location")!(event())).toBe(
    "/old/library",
  );
  expect(app.relaunch).not.toHaveBeenCalled();
});

it.each(["normal", "destroyed", "renderer-crash"])(
  "joins server close once on %s quit despite reentry",
  async (kind) => {
    const actual =
      await vi.importActual<typeof import("./library-location")>(
        "./library-location",
      );
    stop.mockImplementation(actual.stopLibraryServer);
    if (kind === "destroyed") (window as any).destroyed = true;
    if (kind === "renderer-crash")
      window.webContents.emit(
        "render-process-gone",
        {},
        { reason: "crashed", exitCode: 1 },
      );
    else app.quit();
    if (kind === "normal") ipc.emit("interleaf:flushed", event(), null);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    app.quit();
    app.quit();
    expect(stop).toHaveBeenCalledOnce();
    expect(serverChild.stdin.writableEnded).toBe(true);
    expect(serverChild.kill).not.toHaveBeenCalled();
    expect(exitCount).toBe(0);
    serverChild.exitCode = 0;
    serverChild.emit("exit", 0);
    await Promise.resolve();
    expect(exitCount).toBe(0);
    serverChild.emit("close", 0, null);
    await vi.waitFor(() => expect(exitCount).toBe(1));
  },
);

it("joins the started child after startup failure without killing it", async () => {
  expect(diagnosticRecords).toHaveBeenCalledWith(
    "desktop",
    expect.objectContaining({
      event: "startup.desktop",
      level: "error",
      navigationStartedMs: expect.any(Number),
    }),
  );
  expect(serverChild.stdin.writableEnded).toBe(true);
  expect(serverChild.kill).not.toHaveBeenCalled();
  expect(exitCount).toBe(0);
  app.quit();
  expect(stop).toHaveBeenCalledOnce();
  serverChild.emit("close", 0, null);
  await vi.waitFor(() => expect(exitCount).toBe(1));
});

it.each(["plain", "restart"])("recovers %s quit after timeout and late close without relaunch", async (kind) => {
  const actual = await vi.importActual<typeof import("./library-location")>("./library-location");
  stop.mockImplementation(actual.stopLibraryServer);
  vi.useFakeTimers();
  if (kind === "restart") handlers.get("interleaf:restart")!(event());
  else app.quit();
  ipc.emit("interleaf:flushed", event(), null);
  await vi.advanceTimersByTimeAsync(0);
  app.quit();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(showErrorBox).toHaveBeenCalledOnce();
  expect(exitCount).toBe(0);
  expect(app.relaunch).not.toHaveBeenCalled();
  expect(serverChild.kill).not.toHaveBeenCalled();
  expect(serverChild.stdin.writableEnded).toBe(true);
  serverChild.exitCode = 0;
  serverChild.emit("exit", 0);
  app.quit();
  await vi.advanceTimersByTimeAsync(0);
  expect(exitCount).toBe(0); // exit is not close; stdio/work still owns the barrier.
  serverChild.emit("close", 0, null);
  app.quit();
  await vi.advanceTimersByTimeAsync(0);
  expect(exitCount).toBe(1);
  expect(stop).toHaveBeenCalledOnce();
  expect(app.relaunch).not.toHaveBeenCalled();
});

it.each(["plain", "restart"])("finishes %s quit after an already exited nonzero child closes", async (kind) => {
  const actual = await vi.importActual<typeof import("./library-location")>("./library-location");
  stop.mockImplementation(actual.stopLibraryServer);
  vi.useFakeTimers();
  serverChild.exitCode = 1;
  if (kind === "restart") handlers.get("interleaf:restart")!(event());
  else app.quit();
  ipc.emit("interleaf:flushed", event(), null);
  await vi.advanceTimersByTimeAsync(0);
  expect(exitCount).toBe(0);
  serverChild.emit("close", 1, null);
  app.quit();
  await vi.advanceTimersByTimeAsync(0);
  expect(exitCount).toBe(1);
  expect(showErrorBox).toHaveBeenCalledOnce();
  expect(app.relaunch).not.toHaveBeenCalled();
  expect(serverChild.kill).not.toHaveBeenCalled();
});

it("finishes startup failure after nonzero close", async () => {
  serverChild.exitCode = 1;
  serverChild.emit("close", 1, null);
  await vi.waitFor(() => expect(showErrorBox).toHaveBeenCalledOnce());
  app.quit();
  await vi.waitFor(() => expect(exitCount).toBeGreaterThan(0));
  expect(app.relaunch).not.toHaveBeenCalled();
  expect(serverChild.kill).not.toHaveBeenCalled();
});

it.each(["timeout", "nonzero"])("rejects migration after %s cleanup failure but allows desktop completion", async (kind) => {
  const actual = await vi.importActual<typeof import("./library-location")>("./library-location");
  stop.mockImplementation(actual.stopLibraryServer);
  migrate.mockImplementation(actual.migrateLibrary);
  vi.useFakeTimers();
  const result = move();
  await vi.advanceTimersByTimeAsync(0);
  ipc.emit("interleaf:flushed", event(), null);
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).not.toHaveBeenCalled();
  if (kind === "timeout") await vi.advanceTimersByTimeAsync(30_000);
  else {
    serverChild.exitCode = 1;
    serverChild.emit("close", 1, null);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(await result).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  expect(app.relaunch).not.toHaveBeenCalled();
  expect(handlers.get("interleaf:library-location")!(event())).toBe("/old/library");
  if (kind === "timeout") {
    expect(exitCount).toBe(0);
    serverChild.exitCode = 0;
    serverChild.emit("close", 0, null);
    app.quit();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(exitCount).toBe(1);
  expect(app.relaunch).not.toHaveBeenCalled();
  expect(serverChild.kill).not.toHaveBeenCalled();
});

it("does not close the reader when the native confirmation is cancelled", async () => {
  showMessageBox.mockResolvedValueOnce({ response: 1 });
  expect(await move()).toBe(false);
  expect(window.webContents.send).not.toHaveBeenCalledWith("interleaf:flush");
  expect(migrate).not.toHaveBeenCalled();
});

it.each(["/destination?question", "/parent?question/destination"])(
  "rejects an unsafe library path before confirming or closing: %s",
  async (selected) => {
    showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [selected],
    });
    // A missing path guard must fail the test without waiting for a flush.
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    await expect(move()).rejects.toThrow("书库路径不能包含 ?");
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalledWith("interleaf:flush");
    expect(stop).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(handlers.get("interleaf:library-location")!(event())).toBe(
      "/old/library",
    );

    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await move()).toBe(false);
    expect(showOpenDialog).toHaveBeenCalledTimes(2);
  },
);
