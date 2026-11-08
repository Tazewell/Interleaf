import { summarizeReadingRun } from "./metrics.mjs";

const label =
  document.querySelector("script[data-reading-performance]")?.dataset
    .readingPerformance || "unlabelled";
const panel = document.createElement("aside");
panel.setAttribute("aria-label", "阅读性能采集");
Object.assign(panel.style, {
  position: "fixed",
  zIndex: "2147483647",
  bottom: "8px",
  left: "8px",
  padding: "8px",
  maxWidth: "460px",
  border: "1px solid #789",
  borderRadius: "8px",
  background: "#fffffff5",
  color: "#17201a",
  font: "12px/1.4 monospace",
});
panel.innerHTML = `<strong>本地性能采集 · ${label}</strong> <select aria-label="采集条件"><option value="source">原文</option><option value="parallel-nosync">对照·不同步</option><option value="parallel-sync">对照·同步</option></select> <button type="button">开始记录</button> <button type="button" disabled>停止记录</button><details><summary>采集结果</summary><textarea aria-label="性能采集结果" readonly rows="12" style="width:420px;max-width:80vw;font:11px monospace"></textarea></details>`;
document.body.append(panel);
const [start, stop] = panel.querySelectorAll("button");
const condition = panel.querySelector("select");
const output = panel.querySelector("textarea");
let recording;
start.addEventListener("click", () => {
  if (recording) return;
  const root = document.getElementById("root");
  const sample = {
    label,
    condition: condition.value,
    intervals: [],
    longTasks: [],
    visibilityChanges: document.hidden ? 1 : 0,
    scrolls: { source: 0, translation: 0, other: 0 },
    mutations: { added: 0, removed: 0, attributes: 0 },
    layoutShiftSum: 0,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
  };
  const started = performance.now();
  let last;
  let activeUntil = 0;
  let frame;
  const tick = (now) => {
    // Include the interval that starts in the window even if a stall makes its
    // ending callback arrive after the window. Later idle frames stay excluded.
    if (
      last !== undefined &&
      !document.hidden &&
      activeUntil > 0 &&
      last <= activeUntil
    )
      sample.intervals.push(now - last);
    last = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  const consume = (entries) => {
    for (const entry of entries) {
      if (entry.entryType === "longtask") sample.longTasks.push(entry.duration);
      if (entry.entryType === "layout-shift")
        sample.layoutShiftSum += entry.value || 0;
    }
  };
  const performanceObservers = [];
  for (const type of ["longtask", "layout-shift"]) {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) continue;
    const observer = new PerformanceObserver((list) =>
      consume(list.getEntries()),
    );
    observer.observe({ type });
    performanceObservers.push(observer);
  }
  const mutate = (entries) => {
    for (const entry of entries) {
      sample.mutations.added += entry.addedNodes.length;
      sample.mutations.removed += entry.removedNodes.length;
      if (entry.type === "attributes") sample.mutations.attributes++;
    }
  };
  const mutations = new MutationObserver(mutate);
  if (root)
    mutations.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  const scroll = (event) => {
    activeUntil = performance.now() + 200;
    const target = event.target;
    const key =
      target instanceof Element && target.classList.contains("pdf-container")
        ? "source"
        : target instanceof Element &&
            target.classList.contains("translation-document")
          ? "translation"
          : "other";
    sample.scrolls[key]++;
  };
  const visibility = () => sample.visibilityChanges++;
  const resize = () => sample.visibilityChanges++;
  document.addEventListener("scroll", scroll, true);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("resize", resize);
  recording = () => {
    cancelAnimationFrame(frame);
    performanceObservers.forEach((observer) => {
      consume(observer.takeRecords());
      observer.disconnect();
    });
    mutate(mutations.takeRecords());
    mutations.disconnect();
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("resize", resize);
    return summarizeReadingRun({
      ...sample,
      durationMs: performance.now() - started,
      domElements: root?.querySelectorAll("*").length || 0,
    });
  };
  start.disabled = true;
  stop.disabled = false;
  condition.disabled = true;
  output.value =
    "记录中；请在阅读区域连续滚动，窗口切换或尺寸改变会使本轮无效。";
});
stop.addEventListener("click", () => {
  if (!recording) return;
  const report = recording();
  recording = undefined;
  output.value = JSON.stringify(report, null, 2);
  panel.querySelector("details").open = true;
  start.disabled = false;
  stop.disabled = true;
  condition.disabled = false;
});
window.addEventListener(
  "pagehide",
  () => {
    recording?.();
    recording = undefined;
  },
  { once: true },
);
