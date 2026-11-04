// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tabs, TabsTrigger } from "@interleaf/ui/components/tabs";
import { SlidingTabsList } from "./SlidingTabsList";

let host: HTMLDivElement, root: Root, selected: string[], value: string;
let bounds: ReturnType<typeof vi.spyOn>;
const labels = ["original", "parallel", "translation"];
const draw = (next = value, disabled = false, activateOnFocus = false) => {
  value = next;
  root.render(
    <Tabs
      value={value}
      onValueChange={(next) => {
        selected.push(String(next));
        draw(String(next), disabled, activateOnFocus);
      }}
    >
      <SlidingTabsList aria-label="模式" activateOnFocus={activateOnFocus}>
        {labels.map((label) => (
          <TabsTrigger
            key={label}
            value={label}
            disabled={disabled && label === "translation"}
          >
            {label}
          </TabsTrigger>
        ))}
      </SlidingTabsList>
    </Tabs>,
  );
};
const tab = (index: number) =>
  host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index];
const list = () => host.querySelector<HTMLElement>('[role="tablist"]')!;
async function pointer(
  type: string,
  x: number,
  target = list(),
  releaseClick?: HTMLElement,
) {
  await act(async () => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: 15,
      button: 0,
      cancelable: true,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      isPrimary: { value: true },
    });
    target.dispatchEvent(event);
    releaseClick?.click();
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const index =
        this.getAttribute("role") === "tab"
          ? [...this.parentElement!.querySelectorAll('[role="tab"]')].indexOf(
              this,
            )
          : -1;
      return {
        x: index < 0 ? 0 : index * 70 + 10,
        left: index < 0 ? 0 : index * 70 + 10,
        right: index < 0 ? 220 : index * 70 + 70,
        y: 0,
        top: 0,
        bottom: 30,
        width: index < 0 ? 220 : 60,
        height: 30,
        toJSON() {},
      };
    });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  selected = [];
  value = "original";
  await act(async () => draw());
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  bounds.mockRestore();
  vi.unstubAllGlobals();
});

it("previews a drag without changing mode and commits only on release", async () => {
  await pointer("pointerdown", 40);
  await pointer("pointermove", 180);
  expect(selected).toEqual([]);
  expect(tab(0).getAttribute("aria-selected")).toBe("true");
  await pointer("pointerup", 180);
  expect(selected).toEqual(["translation"]);
  expect(tab(2).getAttribute("aria-selected")).toBe("true");
});
it("keeps the selected mode when a drag is cancelled", async () => {
  await pointer("pointerdown", 40);
  await pointer("pointermove", 180);
  await pointer("pointercancel", 180);
  expect(selected).toEqual([]);
  expect(tab(0).getAttribute("aria-selected")).toBe("true");
});
it("does not activate a disabled destination", async () => {
  await act(async () => draw("original", true));
  await pointer("pointerdown", 40);
  await pointer("pointermove", 180);
  await pointer("pointerup", 180);
  expect(selected).toEqual([]);
  expect(tab(0).getAttribute("aria-selected")).toBe("true");
});
it("does not overwrite a selection that changed while dragging", async () => {
  await pointer("pointerdown", 40);
  await pointer("pointermove", 180);
  await act(async () => draw("parallel"));
  await pointer("pointerup", 180);
  expect(selected).toEqual([]);
  expect(tab(1).getAttribute("aria-selected")).toBe("true");
});
it.each(["resize", "blur"])(
  "cancels a drag on %s and suppresses its release click",
  async (event) => {
    await pointer("pointerdown", 40);
    await pointer("pointermove", 180);
    await act(async () => window.dispatchEvent(new Event(event)));
    await pointer("pointerup", 180, list(), tab(2));
    expect(selected).toEqual([]);
  },
);
it("ignores another pointer and cancels on lost capture", async () => {
  await pointer("pointerdown", 40);
  await pointer("pointermove", 180);
  await act(async () => {
    const event = new MouseEvent("pointerup", {
      bubbles: true,
      clientX: 180,
      clientY: 15,
    });
    Object.defineProperty(event, "pointerId", { value: 2 });
    list().dispatchEvent(event);
  });
  expect(selected).toEqual([]);
  await act(async () => list().dispatchEvent(new Event("lostpointercapture")));
  await pointer("pointerup", 180);
  expect(selected).toEqual([]);
});
it("retains ordinary clicks and keyboard navigation", async () => {
  await act(async () => tab(1).click());
  expect(selected).toEqual(["parallel"]);
  await act(async () => {
    tab(1).focus();
    tab(1).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  expect(document.activeElement).toBe(tab(2));
  // Base UI uses manual activation by default; Enter generates a click in a browser.
  await act(async () => tab(2).click());
  expect(tab(2).getAttribute("aria-selected")).toBe("true");
});
it.each([false, true])(
  "hands focus to a clicked tab only after release (activateOnFocus=%s)",
  async (automatic) => {
    await act(async () => {
      draw("original", false, automatic);
    });
    await act(async () => tab(0).focus());
    await pointer("pointerdown", 110, tab(1));
    expect(document.activeElement).toBe(tab(0));
    expect(selected).toEqual([]);
    await pointer("pointerup", 110, tab(1));
    expect(document.activeElement).toBe(tab(1));
    await act(async () => tab(1).click());
    expect(selected).toEqual(["parallel"]);
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(tab(2));
  },
);
it("activates a drag destination once when focus also activates tabs", async () => {
  await act(async () => draw("original", false, true));
  await pointer("pointerdown", 40, tab(0));
  await pointer("pointermove", 180, tab(0));
  await pointer("pointerup", 180, tab(0), tab(0));
  expect(selected).toEqual(["translation"]);
  expect(document.activeElement).toBe(tab(2));
});
