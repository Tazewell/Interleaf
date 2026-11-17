// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installScrollbars } from "./scrollbars";

const scrolling = "data-interleaf-scrolling";
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function container() {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

function scroll(element: Element) {
  element.dispatchEvent(new Event("scroll"));
}

it("writes the active attribute only on transitions during a scroll burst", () => {
  const element = container();
  const mutations = new MutationObserver(() => {});
  mutations.observe(element, {
    attributes: true,
    attributeFilter: [scrolling],
  });
  dispose = installScrollbars(document);

  scroll(element);
  for (let index = 0; index < 20; index++) {
    vi.advanceTimersByTime(10);
    scroll(element);
  }

  expect(element.hasAttribute(scrolling)).toBe(true);
  expect(mutations.takeRecords()).toHaveLength(1);
  vi.advanceTimersByTime(1000);
  expect(element.hasAttribute(scrolling)).toBe(false);
  expect(mutations.takeRecords()).toHaveLength(1);
  scroll(element);
  expect(element.hasAttribute(scrolling)).toBe(true);
  expect(mutations.takeRecords()).toHaveLength(1);
  mutations.disconnect();
});

it("keeps one wakeup through a scroll burst instead of scheduling per event", () => {
  const element = container();
  dispose = installScrollbars(document);
  const schedule = vi.spyOn(globalThis, "setTimeout");
  const cancel = vi.spyOn(globalThis, "clearTimeout");
  scroll(element);
  for (let index = 0; index < 20; index++) {
    vi.advanceTimersByTime(10);
    scroll(element);
  }
  expect(schedule).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
});

it("skips the PDF host whose native scrollbar is hidden, while keeping nested scrollbars active", () => {
  const host = container();
  host.className = "interleaf-engine pdf-container";
  const nested = document.createElement("div");
  host.append(nested);
  dispose = installScrollbars(document);

  scroll(host);
  vi.advanceTimersByTime(200);
  scroll(host);
  expect(host.hasAttribute(scrolling)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);

  scroll(nested);
  expect(nested.hasAttribute(scrolling)).toBe(true);
  expect(host.hasAttribute(scrolling)).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
});

it("hides exactly one second after the last event even across a pending wakeup", () => {
  const element = container();
  dispose = installScrollbars(document);
  scroll(element);
  vi.advanceTimersByTime(900);
  scroll(element);
  vi.advanceTimersByTime(999);
  expect(element.hasAttribute(scrolling)).toBe(true);
  vi.advanceTimersByTime(1);
  expect(element.hasAttribute(scrolling)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("stays active throughout sustained scrolling and cancels an extended wakeup on disposal", () => {
  const element = container();
  dispose = installScrollbars(document);
  scroll(element);
  for (let index = 0; index < 6; index++) {
    vi.advanceTimersByTime(700);
    scroll(element);
    expect(element.hasAttribute(scrolling)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  }
  dispose();
  expect(element.hasAttribute(scrolling)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(1000);
  expect(element.hasAttribute(scrolling)).toBe(false);
});

it("tracks nested containers independently", () => {
  const outer = container();
  const inner = document.createElement("div");
  outer.append(inner);
  dispose = installScrollbars(document);
  scroll(outer);
  vi.advanceTimersByTime(400);
  scroll(inner);
  vi.advanceTimersByTime(600);
  expect(outer.hasAttribute(scrolling)).toBe(false);
  expect(inner.hasAttribute(scrolling)).toBe(true);
  vi.advanceTimersByTime(400);
  expect(inner.hasAttribute(scrolling)).toBe(false);
});

it("cleans active containers, timers, stylesheet and capture listener on disposal", () => {
  const first = container();
  const second = container();
  const previousStyles = document.head.querySelectorAll("style").length;
  dispose = installScrollbars(document);
  expect(document.head.querySelectorAll("style")).toHaveLength(
    previousStyles + 1,
  );
  scroll(first);
  scroll(second);
  dispose();
  expect(first.hasAttribute(scrolling)).toBe(false);
  expect(second.hasAttribute(scrolling)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(document.head.querySelectorAll("style")).toHaveLength(previousStyles);
  scroll(first);
  expect(first.hasAttribute(scrolling)).toBe(false);
});

it("handles document scrolling and elements from another window", () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const foreignDocument = frame.contentDocument!;
  const root = foreignDocument.documentElement;
  Object.defineProperty(foreignDocument, "scrollingElement", { value: root });
  dispose = installScrollbars(foreignDocument);
  foreignDocument.dispatchEvent(new Event("scroll"));
  expect(root.hasAttribute(scrolling)).toBe(true);
  vi.advanceTimersByTime(1000);
  expect(root.hasAttribute(scrolling)).toBe(false);
  const foreignElement = foreignDocument.createElement("div");
  foreignDocument.body.append(foreignElement);
  foreignElement.dispatchEvent(new Event("scroll"));
  expect(foreignElement.hasAttribute(scrolling)).toBe(true);
  dispose();
  expect(foreignElement.hasAttribute(scrolling)).toBe(false);
});
