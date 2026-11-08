const finite = (values) =>
  (values ?? []).filter((value) => Number.isFinite(value) && value > 0);
const round = (value) => Math.round(value * 100) / 100;
export function summarizeReadingRun(input) {
  const intervals = finite(input.intervals).sort((a, b) => a - b);
  const tasks = finite(input.longTasks);
  const percentile = (fraction) =>
    intervals.length
      ? round(
          intervals[Math.max(0, Math.ceil(intervals.length * fraction) - 1)],
        )
      : null;
  const count = (value) =>
    Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  const budgetMs =
    Number.isFinite(input.budgetMs) && input.budgetMs > 0
      ? input.budgetMs
      : 1000 / 60;
  return {
    schema: 1,
    label: String(input.label ?? "unlabelled").slice(0, 64),
    condition: String(input.condition ?? "unspecified").slice(0, 64),
    valid:
      input.durationMs > 0 &&
      intervals.length > 0 &&
      !input.visibilityChanges &&
      count(input.scrolls?.source) + count(input.scrolls?.translation) > 0,
    durationMs: round(Math.max(0, input.durationMs || 0)),
    visibilityChanges: count(input.visibilityChanges),
    viewport: input.viewport
      ? {
          width: count(input.viewport.width),
          height: count(input.viewport.height),
          dpr: input.viewport.dpr,
        }
      : undefined,
    frameCallbacks: {
      sampling:
        "Intervals starting in the scroll window (200ms tail), including the final interval crossing its end",
      samples: intervals.length,
      budgetMs: round(budgetMs),
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: intervals.length ? round(intervals.at(-1)) : null,
      over1_5xBudget: intervals.filter((interval) => interval > budgetMs * 1.5)
        .length,
    },
    longTasks: {
      count: tasks.length,
      totalMs: round(tasks.reduce((sum, value) => sum + value, 0)),
      maxMs: tasks.length ? round(Math.max(...tasks)) : 0,
    },
    scrolls: {
      source: count(input.scrolls?.source),
      translation: count(input.scrolls?.translation),
      other: count(input.scrolls?.other),
    },
    mutations: {
      added: count(input.mutations?.added),
      removed: count(input.mutations?.removed),
      attributes: count(input.mutations?.attributes),
    },
    layoutShiftSum: round(input.layoutShiftSum || 0),
    domElements: count(input.domElements),
    note: "Frame callbacks measure main-thread scheduling, not presented FPS or actual dropped frames. Compare matching foreground runs only.",
  };
}
