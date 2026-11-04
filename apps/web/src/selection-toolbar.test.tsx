// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectionToolbar } from "./SelectionToolbar";

let root: Root, host: HTMLDivElement;
const close = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  close.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const pane = createRef<HTMLDivElement>();
  pane.current = host;
  await act(async () =>
    root.render(
      <SelectionToolbar
        anchor={{ x: 100, top: 80, bottom: 100 }}
        pane={pane}
        onClose={close}
        content={
          <div data-selection-translation="">A translated paragraph</div>
        }
      >
        <button>高亮</button>
      </SelectionToolbar>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelector("[data-selection-preserve]")?.remove();
  vi.unstubAllGlobals();
});
it("keeps card text outside the action toolbar and allows selecting it", async () => {
  const card = host.querySelector("[data-selection-translation]")!;
  expect(card).not.toBeNull();
  expect(host.querySelector('[role="toolbar"]')!.contains(card)).toBe(false);
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
  });
  card.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});
it("keeps card and portaled menu interactions open, dismissing outside presses", async () => {
  const card = host.querySelector("[data-selection-translation]")!;
  expect(card).not.toBeNull();
  const menu = document.createElement("div");
  menu.dataset.selectionPreserve = "";
  document.body.append(menu);
  await act(async () => {
    card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    menu.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  });
  expect(close).not.toHaveBeenCalled();
  await act(async () =>
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    ),
  );
  expect(close).toHaveBeenCalledOnce();
});
it("dismisses on Escape and viewport scroll, keeping card scrolling open", async () => {
  const card = host.querySelector("[data-selection-translation]")!;
  expect(card).not.toBeNull();
  await act(async () =>
    card.dispatchEvent(new Event("scroll", { bubbles: true })),
  );
  expect(close).not.toHaveBeenCalled();
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(close).toHaveBeenCalledOnce();
  close.mockClear();
  await act(async () => window.dispatchEvent(new Event("scroll")));
  expect(close).toHaveBeenCalledOnce();
});
