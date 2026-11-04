// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type ReaderEvents,
  type ReaderTheme,
} from "@interleaf/core";
import { InterleafView } from "./InterleafView";
import { paper } from "./papers/fixtures";

const fixture = vi.hoisted(() => {
  class Engine {
    selectionVisible = false;
    open = vi.fn(async () => {
      if (state.deferOpen)
        await new Promise<void>((resolve) => {
          state.releaseOpen = resolve;
        });
    });
    clearSelection = vi.fn(() => {
      this.selectionVisible = false;
    });
    setTheme = vi.fn(async (_theme: ReaderTheme) => {
      this.clearSelection();
    });
    preferTheme = vi.fn();
    highlight = vi.fn(async () => {});
    setBlocks = vi.fn();
    getTOC = vi.fn(async () => []);
    destroy = vi.fn(async () => {});
    constructor() {
      state.instances.push(this);
    }
  }
  const state = {
    Engine,
    instances: [] as Engine[],
    deferOpen: false,
    releaseOpen: undefined as (() => void) | undefined,
  };
  return state;
});
vi.mock("./engines/pdf", () => ({ PDFReaderAdapter: fixture.Engine }));
vi.mock("./engines/epub-web", () => ({ EPUBReaderAdapter: fixture.Engine }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

let root: Root, host: HTMLDivElement;
const ready = vi.fn();
const events = {
  selection: vi.fn(),
  location: vi.fn(),
} as unknown as ReaderEvents;
const annotations: [] = [];
const blocks: [] = [];
let format: "pdf" | "epub";
async function render(theme: ReaderTheme) {
  await act(async () =>
    root.render(
      <InterleafView
        document={paper({ id: "view-theme", type: format })}
        theme={theme}
        annotations={annotations}
        blocks={blocks}
        events={events}
        onReady={ready}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.instances.length = 0;
  fixture.deferOpen = false;
  fixture.releaseOpen = undefined;
  ready.mockClear();
  format = "pdf";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  fixture.releaseOpen?.();
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it.each(["pdf", "epub"] as const)(
  "preserves %s native selection when only automatic selection translation changes",
  async (type) => {
    format = type;
    await render({ ...defaultTheme, autoTranslateSelection: false });
    const engine = fixture.instances[0];
    expect(ready).toHaveBeenCalledOnce();
    expect(engine.setTheme).toHaveBeenCalledTimes(1);
    engine.selectionVisible = true;
    await render({ ...defaultTheme, autoTranslateSelection: true });
    expect(engine.selectionVisible).toBe(true);
    expect(engine.setTheme).toHaveBeenCalledTimes(1);
    await render({ ...defaultTheme, autoTranslateSelection: false });
    expect(engine.selectionVisible).toBe(true);
    expect(engine.setTheme).toHaveBeenCalledTimes(1);
  },
);

it("still applies actual appearance, zoom and typography changes", async () => {
  await render(defaultTheme);
  const engine = fixture.instances[0];
  const dark = {
    ...defaultTheme,
    mode: "dark" as const,
    autoTranslateSelection: true,
  };
  await render(dark);
  const zoomed = { ...dark, zoom: 1.5 };
  await render(zoomed);
  const larger = {
    ...zoomed,
    fontSize: 1.4,
    fontFamily: "sans-serif",
    lineHeight: 2,
  };
  await render(larger);
  expect(engine.setTheme.mock.calls.map(([theme]) => theme)).toEqual([
    defaultTheme,
    dark,
    zoomed,
    larger,
  ]);
  expect(fixture.instances).toHaveLength(1);
  expect(ready).toHaveBeenCalledOnce();
});

it("opens with the latest theme and disposes the adapter after a delayed setup", async () => {
  fixture.deferOpen = true;
  await render(defaultTheme);
  const latest = { ...defaultTheme, zoom: 1.5, autoTranslateSelection: true };
  await render(latest);
  const engine = fixture.instances[0];
  expect(engine.setTheme).not.toHaveBeenCalled();
  await act(async () => fixture.releaseOpen!());
  expect(engine.setTheme).toHaveBeenCalledExactlyOnceWith(latest);
  expect(ready).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  expect(engine.destroy).toHaveBeenCalledOnce();
});
