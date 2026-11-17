// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { defaultTheme, type NativePDFReadingManifest } from "@interleaf/core";
import { InterleafView } from "../InterleafView";
import { paper } from "../papers/fixtures";
const state = vi.hoisted(() => ({
  instances: [] as any[],
  defer: false,
  release: undefined as (() => void) | undefined,
}));
vi.mock("./pdf", () => ({
  PDFReaderAdapter: class {
    constructor(
      public host: HTMLElement,
      public events: any,
      public descriptor: any,
    ) {
      state.instances.push(this);
    }
    preferTheme = vi.fn();
    setTheme = vi.fn(async () => {});
    highlight = vi.fn(async () => {});
    setBlocks = vi.fn();
    getTOC = vi.fn(async () => []);
    destroy = vi.fn(async () => {});
    open = vi.fn(async (doc: any) => {
      if (state.defer)
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      this.events.location(doc.progress, 0.5);
    });
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
let host: HTMLDivElement, root: Root;
const ready = vi.fn(),
  location = vi.fn();
async function render(
  key: string,
  readingAnchor?: import("@interleaf/core").ReaderEvents["readingAnchor"],
) {
  await act(async () =>
    root.render(
      <InterleafView
        document={paper({ progress: { type: "pdf", page: 7, y: 0.3 } })}
        theme={defaultTheme}
        annotations={[]}
        onReady={ready}
        events={{ location, selection: vi.fn(), readingAnchor }}
        nativeReading={{
          fileURL: `/${key}`,
          translations: [],
          metadata: { cacheKey: key } as NativePDFReadingManifest,
        }}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  state.instances = [];
  state.defer = false;
  state.release = undefined;
  ready.mockClear();
  location.mockClear();
});
afterEach(async () => {
  state.release?.();
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("reopens only for a changed native cache key and forwards original saved location", async () => {
  await render("first");
  expect(state.instances[0].descriptor.fileURL).toBe("/first");
  expect(location).toHaveBeenLastCalledWith(
    { type: "pdf", page: 7, y: 0.3 },
    0.5,
  );
  await render("first");
  expect(state.instances).toHaveLength(1);
  await render("second");
  expect(state.instances).toHaveLength(2);
  expect(state.instances[0].destroy).toHaveBeenCalledOnce();
  expect(ready).toHaveBeenCalledTimes(2);
});
it("destroys an obsolete pending cache adapter immediately and ignores its ready/location events", async () => {
  state.defer = true;
  await render("first");
  const release = state.release!;
  state.defer = false;
  await render("second");
  expect(state.instances[0].destroy).toHaveBeenCalledOnce();
  expect(ready).toHaveBeenCalledOnce();
  location.mockClear();
  await act(async () => release());
  expect(location).not.toHaveBeenCalled();
  expect(ready).toHaveBeenCalledOnce();
});

it("exposes only the current readingAnchor consumer across renders and disposal", async () => {
  await render("same");
  const bridge = state.instances[0].events;
  expect(bridge.readingAnchor).toBeUndefined();
  const first = vi.fn();
  await render("same", first);
  const stale = bridge.readingAnchor;
  stale({ blockId: "b", fraction: 0.5 });
  expect(first).toHaveBeenCalledOnce();
  const second = vi.fn();
  await render("same", second);
  stale({ blockId: "b", fraction: 0.6 });
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  await render("same");
  expect(bridge.readingAnchor).toBeUndefined();
  await render("replacement", second);
  expect(bridge.readingAnchor).toBeUndefined();
  stale({ blockId: "b", fraction: 0.7 });
  expect(second).toHaveBeenCalledOnce();
});
