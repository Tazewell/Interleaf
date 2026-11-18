// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { linkNativePDFPanes } from "./native-pane-scroll";

let resize: () => void;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function pane(heights: number[]) {
  const host = document.createElement("div");
  const viewer = document.createElement("div");
  viewer.className = "pdfViewer";
  host.append(viewer);
  Object.defineProperties(host, {
    clientHeight: { value: 200 },
    scrollHeight: { get: () => heights.reduce((sum, h) => sum + h + 20, 100) },
  });
  heights.forEach((_, index) => {
    const page = document.createElement("div");
    page.dataset.pageNumber = String(index + 1);
    page.getBoundingClientRect = () => {
      const top = heights.slice(0, index).reduce((sum, h) => sum + h + 20, 20);
      return new DOMRect(0, top - host.scrollTop, 300, heights[index]);
    };
    viewer.append(page);
  });
  return host;
}
function scroll(host: HTMLElement, top: number) {
  host.scrollTop = top;
  host.dispatchEvent(new Event("scroll"));
}

it("matches the same point on mixed-size pages in either direction without following its own writes", () => {
  const source = pane([400, 800, 600]),
    translated = pane([200, 400, 300]);
  const pair = linkNativePDFPanes(source, translated);
  // The viewport center reaches 25% of page two. The fixed 20px page gaps do not scale.
  scroll(source, 540);
  expect(translated.scrollTop).toBe(240);
  translated.dispatchEvent(new Event("scroll"));
  expect(source.scrollTop).toBe(540);
  translated.dispatchEvent(new Event("wheel"));
  scroll(translated, 440);
  expect(source.scrollTop).toBe(940);
  pair.destroy();
  scroll(translated, 160);
  expect(source.scrollTop).toBe(940);
});
it("keeps the reading point through a column resize and reaches both document ends", () => {
  const left = [400, 800, 600],
    right = [200, 400, 300];
  const source = pane(left),
    translated = pane(right);
  const pair = linkNativePDFPanes(source, translated);
  scroll(source, 540);
  left.splice(0, 3, 200, 400, 300);
  right.splice(0, 3, 400, 800, 600);
  resize();
  expect(source.scrollTop).toBe(240);
  expect(translated.scrollTop).toBe(540);
  scroll(source, 0);
  expect(translated.scrollTop).toBe(0);
  scroll(source, source.scrollHeight - source.clientHeight);
  expect(translated.scrollTop).toBe(
    translated.scrollHeight - translated.clientHeight,
  );
  pair.destroy();
});

it("restores the shared reading point and each horizontal pan after the DOM panes move", () => {
  const source = pane([400, 800, 600]),
    translated = pane([200, 400, 300]);
  const pair = linkNativePDFPanes(source, translated);
  translated.dispatchEvent(new Event("wheel"));
  scroll(translated, 240);
  source.scrollLeft = 40;
  translated.scrollLeft = 18;
  const restore = pair.captureForSwap();
  // Chromium can reset a scroller while React inserts its panel on the other side.
  source.scrollLeft =
    source.scrollTop =
    translated.scrollLeft =
    translated.scrollTop =
      0;
  restore();
  expect([source.scrollTop, translated.scrollTop]).toEqual([540, 240]);
  expect([source.scrollLeft, translated.scrollLeft]).toEqual([40, 18]);
  expect(pair.active).toBe("translation");
  pair.destroy();
});

it("preserves both paused reading positions through a swap and resumes from the last input pane", () => {
  const source = pane([400, 800, 600]),
    translated = pane([200, 400, 300]);
  const pair = linkNativePDFPanes(source, translated);
  pair.setEnabled(false);
  scroll(source, 540);
  translated.dispatchEvent(new FocusEvent("focusin"));
  scroll(translated, 440);
  expect(source.scrollTop).toBe(540);

  const restore = pair.captureForSwap();
  source.scrollTop = translated.scrollTop = 0;
  restore();
  expect([source.scrollTop, translated.scrollTop]).toEqual([540, 440]);

  pair.setEnabled(true);
  expect([source.scrollTop, translated.scrollTop]).toEqual([940, 440]);
  pair.destroy();
});
