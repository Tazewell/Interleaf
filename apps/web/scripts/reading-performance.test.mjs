import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import vm from "node:vm";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createServer, get } from "node:http";
import { summarizeReadingRun } from "./reading-performance/metrics.mjs";
import { createReadingPerformanceServer } from "./reading-performance.mjs";

const cleanup = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
it("reports scheduling intervals without pretending they are presented FPS", () => {
  const report = summarizeReadingRun({
    label: "baseline",
    condition: "parallel-sync",
    durationMs: 1000,
    intervals: [16, 17, 16, 50, NaN, -1, 0],
    budgetMs: 16.67,
    visibilityChanges: 0,
    longTasks: [60, 80],
    scrolls: { source: 5, translation: 4 },
    mutations: { added: 8, removed: 2, attributes: 9 },
  });
  expect(report.valid).toBe(true);
  expect(report.frameCallbacks.samples).toBe(4);
  expect(report.frameCallbacks.p95Ms).toBe(50);
  expect(report.frameCallbacks.over1_5xBudget).toBe(1);
  expect(report.longTasks).toEqual({ count: 2, totalMs: 140, maxMs: 80 });
  expect(report).not.toHaveProperty("fps");
  expect(report).not.toHaveProperty("droppedFrames");
});
it("rejects hidden/background runs and omits page text and authentication", () => {
  const report = summarizeReadingRun({
    label: "after",
    durationMs: 1000,
    intervals: [16, 16],
    visibilityChanges: 1,
    url: "http://localhost/#token=private",
    title: "private paper",
    text: "private text",
  });
  expect(report.valid).toBe(false);
  expect(JSON.stringify(report)).not.toContain("private");
});
it("records a stalled frame crossing the active window without later idle frames", async () => {
  const code = (
    await readFile(
      new URL("./reading-performance/overlay.js", import.meta.url),
      "utf8",
    )
  ).replace(/^import[^\n]+\n/, "");
  const run = (withScroll) => {
    const events = new Map();
    const listeners = {};
    const start = { addEventListener: (_, fn) => (listeners.start = fn) };
    const stop = { addEventListener: (_, fn) => (listeners.stop = fn) };
    const select = { value: "source" };
    const output = {};
    const details = {};
    const panel = {
      style: {},
      setAttribute() {},
      querySelectorAll: () => [start, stop],
      querySelector: (selector) =>
        selector === "select"
          ? select
          : selector === "textarea"
            ? output
            : details,
    };
    let now = 0;
    let nextFrame;
    class Element {
      classList = { contains: (value) => value === "pdf-container" };
    }
    vm.runInNewContext(code, {
      summarizeReadingRun,
      Element,
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
      performance: { now: () => now },
      requestAnimationFrame: (callback) => {
        nextFrame = callback;
        return 1;
      },
      cancelAnimationFrame() {},
      MutationObserver: class {
        observe() {}
        takeRecords() {
          return [];
        }
        disconnect() {}
      },
      PerformanceObserver: class {
        static supportedEntryTypes = [];
      },
      document: {
        hidden: false,
        querySelector: () => null,
        createElement: () => panel,
        body: { append() {} },
        getElementById: () => ({ querySelectorAll: () => [] }),
        addEventListener: (name, callback) => events.set(name, callback),
        removeEventListener: (name) => events.delete(name),
      },
      window: { addEventListener() {}, removeEventListener() {} },
    });
    const frame = (timestamp) => {
      now = timestamp;
      nextFrame(timestamp);
    };
    listeners.start();
    frame(0);
    if (withScroll) {
      now = 1;
      events.get("scroll")({ target: new Element() });
    }
    frame(16);
    frame(516);
    frame(532);
    frame(548);
    listeners.stop();
    return JSON.parse(output.value);
  };
  expect(run(true).frameCallbacks).toMatchObject({
    samples: 2,
    maxMs: 500,
    over1_5xBudget: 1,
  });
  expect(run(false).frameCallbacks.samples).toBe(0);
});
it("serves only the selected build, injects the probe, and preserves API authentication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interleaf-reading-performance-"));
  cleanup.push(() => {
    const target = resolve(dir);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("interleaf-reading-performance-")
    )
      throw new Error("Unexpected temporary test directory");
    return rm(target, { recursive: true, force: true });
  });
  await writeFile(
    join(dir, "index.html"),
    "<html><body><div id='root'></div></body></html>",
  );
  let forwarded;
  const backend = createServer((req, res) => {
    forwarded = {
      authorization: req.headers.authorization,
      host: req.headers.host,
      origin: req.headers.origin,
    };
    res.writeHead(
      req.headers.authorization === "Bearer test-session" ? 200 : 401,
      { "Content-Type": "application/json" },
    );
    res.end("[]");
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => backend.close(resolve)));
  const server = await createReadingPerformanceServer({
    web: dir,
    backend: `http://127.0.0.1:${backend.address().port}`,
    port: 0,
    label: "baseline",
  });
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  expect(await (await fetch(origin)).text()).toContain(
    "/__reading-performance/overlay.js",
  );
  expect(
    (await fetch(origin + "/__reading-performance/metrics.mjs")).status,
  ).toBe(200);
  expect((await fetch(origin + "/api/documents")).status).toBe(401);
  expect(
    (
      await fetch(origin + "/api/documents", {
        headers: { Authorization: "Bearer test-session", Origin: origin },
      })
    ).status,
  ).toBe(200);
  expect(forwarded).toEqual({
    authorization: "Bearer test-session",
    host: new URL(origin).host,
    origin,
  });
  expect((await fetch(origin + "/%2e%2e%2fpackage.json")).status).toBe(403);
  expect(
    (await fetch(origin, { headers: { Origin: "https://example.com" } }))
      .status,
  ).toBe(403);
  expect((await fetch(origin, { method: "POST" })).status).toBe(405);
});

it("closes interrupted upstream streams so the reader can reconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interleaf-reading-performance-"));
  cleanup.push(() => {
    const target = resolve(dir);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("interleaf-reading-performance-")
    )
      throw new Error("Unexpected temporary test directory");
    return rm(target, { recursive: true, force: true });
  });
  let upstreamResponse;
  const backend = createServer((_req, res) => {
    upstreamResponse = res;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: partial\n\n");
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => backend.close(resolve)));
  const server = await createReadingPerformanceServer({
    web: dir,
    backend: `http://127.0.0.1:${backend.address().port}`,
    port: 0,
  });
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  let client;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Interrupted upstream left downstream hanging")),
        1000,
      );
      client = get(
        `http://127.0.0.1:${server.address().port}/api/interrupted`,
        (res) => {
          res.once("data", () => upstreamResponse.destroy());
          res.once("error", (error) => {
            clearTimeout(timeout);
            error.code === "ECONNRESET" ? resolve() : reject(error);
          });
          res.once("end", () => {
            clearTimeout(timeout);
            reject(new Error("Truncated stream must not appear complete"));
          });
        },
      );
      client.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    client?.destroy();
    upstreamResponse?.destroy();
  }
});
