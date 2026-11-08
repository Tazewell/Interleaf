// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { PDFBlock } from "@interleaf/core";
import { PDFFigureLinks } from "./pdf-figure-links";
const image: PDFBlock = {
  id: "figure-3",
  page: 2,
  label: "image",
  text: "",
  caption: "Figure 3. Result",
  bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 },
};
afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});
it("links references split across PDF spans without changing text or transforms", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="textLayer"><span style="transform: scaleX(0.8)">See Figure</span><span>[3] and Figure 3.</span><span>Figure 9</span></div>';
  document.body.append(host);
  const before = host.textContent;
  const focus = vi.fn();
  let blocks: PDFBlock[] = [];
  const links = new PDFFigureLinks(host, () => blocks, focus);
  links.repaint();
  expect(host.querySelector("a")).toBeNull();
  blocks = [image];
  links.repaint();
  links.repaint();
  expect(host.textContent).toBe(before);
  expect(host.querySelector("span")!.style.transform).toBe("scaleX(0.8)");
  expect(host.querySelectorAll("a")).toHaveLength(3);
  host.querySelector("a")!.click();
  expect(focus).toHaveBeenCalledExactlyOnceWith(image);
  const range = document.createRange();
  range.selectNodeContents(host.querySelector("span")!);
  window.getSelection()!.addRange(range);
  host.querySelector("a")!.click();
  expect(focus).toHaveBeenCalledTimes(1);
  window.getSelection()!.removeAllRanges();
  links.destroy();
  host
    .querySelector("a")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(focus).toHaveBeenCalledTimes(1);
});
it("routes native annotations covering figure text through figure focus", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page"><div class="textLayer"><span>Figure 3</span></div><div class="annotationLayer"><a class="internalLink" href="#native"> </a></div></div>';
  document.body.append(host);
  const focus = vi.fn();
  const links = new PDFFigureLinks(host, () => [image], focus);
  links.repaint();
  const anchor = host.querySelector<HTMLAnchorElement>(
    "[data-figure-reference]",
  )!;
  anchor.getClientRects = () =>
    [new DOMRect(10, 20, 40, 15)] as unknown as DOMRectList;
  const native = host.querySelector(".annotationLayer a")!;
  native.getClientRects = () =>
    [new DOMRect(5, 15, 50, 25)] as unknown as DOMRectList;
  const sameHostListener = vi.fn();
  host.addEventListener("click", sameHostListener, true);
  const navigate = vi.fn();
  native.addEventListener("click", navigate);
  native.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 25,
    }),
  );
  expect(focus).toHaveBeenCalledWith(image);
  // Padding click outside the glyph box and keyboard-generated click (0, 0).
  native.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 6,
      clientY: 16,
    }),
  );
  (native as HTMLAnchorElement).click();
  expect(focus).toHaveBeenCalledTimes(3);
  expect(navigate).not.toHaveBeenCalled();
  expect(sameHostListener).not.toHaveBeenCalled();
  links.destroy();
});

it("preserves unrelated internal links and external links", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page"><div class="textLayer"><span>Figure 3</span></div><div class="annotationLayer"><a class="internalLink" href="#citation">[3]</a><a href="https://example.com">Figure 3</a></div></div>';
  document.body.append(host);
  const focus = vi.fn();
  const links = new PDFFigureLinks(host, () => [image], focus);
  links.repaint();
  host.querySelector<HTMLElement>("[data-figure-reference]")!.getClientRects =
    () => [new DOMRect(10, 20, 40, 15)] as unknown as DOMRectList;
  const anchors =
    host.querySelectorAll<HTMLAnchorElement>(".annotationLayer a");
  anchors[0].getClientRects = () =>
    [new DOMRect(100, 20, 40, 15)] as unknown as DOMRectList;
  anchors[1].getClientRects = () =>
    [new DOMRect(10, 20, 40, 15)] as unknown as DOMRectList;
  const native = vi.fn((event: Event) => {
    expect(event.defaultPrevented).toBe(false);
    event.preventDefault();
  });
  for (const anchor of anchors) {
    anchor.addEventListener("click", native);
    anchor.click();
  }
  expect(native).toHaveBeenCalledTimes(2);
  expect(focus).not.toHaveBeenCalled();
  links.destroy();
});

it("keeps link, text and selection identities across unchanged renders and block streams", async () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="1"><div class="textLayer"><span>See Figure 3.</span></div></div>';
  document.body.append(host);
  let blocks = [image];
  const focus = vi.fn();
  const links = new PDFFigureLinks(host, () => blocks, focus);
  links.repaint();
  const anchor = host.querySelector("a")!;
  const text = anchor.firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 6);
  window.getSelection()!.addRange(range);
  // Let the observer deliver records from the first wrapping pass too.
  await Promise.resolve();
  links.repaint(1);
  blocks = [{ ...image, caption: "Figure 3. Updated result" }];
  links.repaint();
  expect(host.querySelector("a")).toBe(anchor);
  expect(anchor.firstChild).toBe(text);
  expect(range.startContainer).toBe(text);
  expect(window.getSelection()!.toString()).toBe("Figure");
  window.getSelection()!.removeAllRanges();
  anchor.click();
  expect(focus).toHaveBeenCalledExactlyOnceWith(blocks[0]);
  links.destroy();
});

it("changes only pages whose figure targets appear, disappear or become ambiguous", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="1"><div class="textLayer"><span>Figure 3</span></div></div><div class="page" data-page-number="2"><div class="textLayer"><span>Figure 4</span></div></div>';
  document.body.append(host);
  let blocks = [image];
  const links = new PDFFigureLinks(host, () => blocks, vi.fn());
  links.repaint();
  const first = host.querySelector("a")!;
  const fourth = { ...image, id: "figure-4", caption: "Figure 4. Result" };
  blocks = [image, fourth];
  links.repaint();
  expect(host.querySelector('.page[data-page-number="1"] a')).toBe(first);
  const second = host.querySelector('.page[data-page-number="2"] a')!;
  expect(second).not.toBeNull();
  blocks = [image, { ...image, id: "duplicate-3" }, fourth];
  links.repaint();
  expect(host.querySelector('.page[data-page-number="1"] a')).toBeNull();
  expect(host.querySelector('.page[data-page-number="2"] a')).toBe(second);
  blocks = [fourth];
  links.repaint();
  expect(host.querySelector('.page[data-page-number="2"] a')).toBe(second);
  blocks = [image, fourth];
  links.repaint();
  expect(host.querySelector('.page[data-page-number="1"] a')).not.toBeNull();
  expect(host.querySelector('.page[data-page-number="2"] a')).toBe(second);
  links.destroy();
});

it("relinks identical-text replacements and real text edits on the affected page", async () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="1"><div class="textLayer"><span>Figure 3</span></div></div><div class="page" data-page-number="2"><div class="textLayer"><span>Figure 3</span></div></div>';
  document.body.append(host);
  const links = new PDFFigureLinks(host, () => [image], vi.fn());
  links.repaint();
  const layers = host.querySelectorAll<HTMLElement>(".textLayer");
  const stable = layers[1].querySelector("a")!;
  layers[0].innerHTML = "<span>Figure 3</span>";
  // Repaint before the mutation callback, as in PDF.js's render event.
  links.repaint(1);
  expect(layers[0].querySelector("a")).not.toBeNull();
  expect(layers[1].querySelector("a")).toBe(stable);

  layers[0].querySelector("a")!.firstChild!.textContent = "Figure 9";
  await Promise.resolve();
  links.repaint(1);
  expect(layers[0].querySelector("a")).toBeNull();
  expect(layers[0].textContent).toBe("Figure 9");
  const replacement = document.createElement("div");
  replacement.className = "textLayer";
  replacement.innerHTML = "<span>Figure 3</span>";
  layers[0].replaceWith(replacement);
  links.repaint(1);
  expect(replacement.querySelector("a")).not.toBeNull();
  expect(layers[1].querySelector("a")).toBe(stable);
  links.destroy();
});

it("reindexes a reused text layer after PDF.js edits its detached subtree", async () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="1"><div class="textLayer"><span>Figure 3</span></div></div>';
  document.body.append(host);
  const links = new PDFFigureLinks(host, () => [image], vi.fn());
  links.repaint();
  const page = host.querySelector(".page")!;
  const layer = host.querySelector(".textLayer")!;
  layer.remove();
  await Promise.resolve();
  layer.innerHTML = "<span>Figure 3</span>";
  page.append(layer);
  links.repaint(1);
  expect(layer.querySelector("a[data-figure-reference]")).not.toBeNull();
  links.destroy();
});

it.each([false, true])(
  "preserves figure links and selection through empty PDF.js sentinels (observer delivered: %s)",
  async (delivered) => {
    const host = document.createElement("div");
    host.innerHTML =
      '<div class="page" data-page-number="1"><div class="textLayer"><span>Figure 3</span><div class="endOfContent"></div></div></div>' +
      '<div class="page" data-page-number="2"><div class="textLayer"><span>Figure 3</span><div class="endOfContent"></div></div></div>';
    document.body.append(host);
    const links = new PDFFigureLinks(host, () => [image], vi.fn());
    links.repaint();
    const layers = [...host.querySelectorAll<HTMLElement>(".textLayer")];
    const anchors = layers.map((layer) => layer.querySelector("a")!);
    const texts = anchors.map((anchor) => anchor.firstChild!);
    const range = document.createRange();
    range.setStart(texts[0], 0);
    range.setEnd(texts[1], 8);
    window.getSelection()!.addRange(range);
    try {
      const assertStable = async () => {
        if (delivered) await Promise.resolve();
        links.repaint();
        for (let index = 0; index < anchors.length; index++) {
          expect(anchors[index].firstChild).toBe(texts[index]);
          expect(layers[index].querySelector("a")).toBe(anchors[index]);
        }
        expect(range.startContainer).toBe(texts[0]);
        expect(range.endContainer).toBe(texts[1]);
        expect(window.getSelection()!.toString()).toBe("Figure 3Figure 3");
      };
      // TextLayerBuilder's global pointerup resets every layer this way,
      // including layers whose sentinel is already the last child.
      for (const layer of layers)
        layer.append(layer.querySelector(".endOfContent")!);
      await assertStable();
      for (const layer of layers) {
        const sentinel = layer.querySelector(".endOfContent")!;
        layer.querySelector("span")!.append(sentinel);
      }
      await assertStable();
      const sentinels = layers.map((layer) =>
        layer.querySelector(".endOfContent")!,
      );
      sentinels.forEach((sentinel) => sentinel.remove());
      await assertStable();
      layers.forEach((layer, index) => layer.append(sentinels[index]));
      await assertStable();
    } finally {
      links.destroy();
    }
  },
);

it("still invalidates text edits delivered alongside PDF.js sentinel movement", () => {
  const host = document.createElement("div");
  host.innerHTML =
    '<div class="page" data-page-number="1"><div class="textLayer"><span>Figure 3</span><div class="endOfContent"></div></div></div>';
  document.body.append(host);
  const links = new PDFFigureLinks(host, () => [image], vi.fn());
  links.repaint();
  const layer = host.querySelector(".textLayer")!;
  layer.append(layer.querySelector(".endOfContent")!);
  layer.querySelector("a")!.firstChild!.textContent = "Figure 9";
  links.repaint();
  expect(layer.querySelector("a[data-figure-reference]")).toBeNull();
  const sentinel = layer.querySelector(".endOfContent")!;
  sentinel.textContent = "Figure 3";
  sentinel.remove();
  layer.append(sentinel);
  links.repaint();
  expect(sentinel.querySelector("a[data-figure-reference]")).not.toBeNull();
  links.destroy();
});
