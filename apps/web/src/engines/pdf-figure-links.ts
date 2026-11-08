import type { PDFBlock } from "@interleaf/core";
import { figureReferences, figureTarget } from "./figure-references";

/** Keep PDF.js spans and their transforms intact; only wrap text inside them. */
export class PDFFigureLinks {
  private versions = new WeakMap<HTMLElement, number>();
  private layers = new WeakMap<
    HTMLElement,
    {
      version: number;
      labels: string[];
      targets: string;
    }
  >();
  private observer: MutationObserver;
  constructor(
    private host: HTMLElement,
    private blocks: () => PDFBlock[],
    private focus: (block: PDFBlock) => void,
  ) {
    host.addEventListener("click", this.click, true);
    this.observer = new MutationObserver(this.changed);
    this.observer.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
  private changed = (records: MutationRecord[]) => {
    const layers = new Set<HTMLElement>();
    for (const record of records) {
      // PDF.js moves this empty selection sentinel on global pointerup and
      // selectionchange, including in unchanged pages. It carries no text.
      if (
        record.type === "childList" &&
        [...record.addedNodes, ...record.removedNodes].every(
          (node) =>
            node instanceof Element &&
            node.matches(".endOfContent") &&
            !node.hasChildNodes(),
        )
      )
        continue;
      const element =
        record.target instanceof Element
          ? record.target
          : record.target.parentElement;
      const layer = element?.closest<HTMLElement>(".textLayer");
      if (layer) layers.add(layer);
      // A retained PDF.js layer can be rebuilt while detached, where our
      // subtree observer cannot see it. Reattaching it starts a new version.
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(".textLayer")) layers.add(node as HTMLElement);
        for (const added of node.querySelectorAll<HTMLElement>(".textLayer"))
          layers.add(added);
      }
    }
    for (const layer of layers)
      this.versions.set(layer, (this.versions.get(layer) || 0) + 1);
  };
  private click = (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (this.host.ownerDocument.getSelection()?.toString()) return;
    const element = event.target instanceof Element ? event.target : null;
    let anchor = element?.closest<HTMLAnchorElement>(
      "a[data-figure-reference]",
    );
    // PDF annotations sit above the text layer. Match the whole native link
    // rectangle, so padding clicks and keyboard activation also replace PDF.js.
    const native = element?.closest<HTMLAnchorElement>(
      ".annotationLayer a.internalLink, .annotationLayer [data-internal-link] a",
    );
    if (!anchor && native) {
      const nativeRects = Array.from(native.getClientRects());
      const candidates = Array.from(
        native
          .closest(".page")
          ?.querySelectorAll<HTMLAnchorElement>("a[data-figure-reference]") ??
          [],
      ).filter((link) =>
        Array.from(link.getClientRects()).some((r) =>
          nativeRects.some(
            (n) =>
              Math.min(r.right, n.right) > Math.max(r.left, n.left) &&
              Math.min(r.bottom, n.bottom) > Math.max(r.top, n.top),
          ),
        ),
      );
      // A large annotation can span multiple references; don't guess its target.
      if (
        new Set(candidates.map((link) => link.dataset.figureReference)).size ===
        1
      )
        anchor = candidates[0];
    }
    if (!anchor) return;
    const block = figureTarget(this.blocks(), anchor.dataset.figureReference!);
    if (!block) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.focus(block);
  };
  repaint(pageNumber?: number) {
    // PDF.js dispatches its render event synchronously, before mutation
    // observers run. Consume those changes before trusting a cached layer.
    this.changed(this.observer.takeRecords());
    const blocks = this.blocks();
    const availability = new Map<string, boolean>();
    const available = (label: string) => {
      if (!availability.has(label))
        availability.set(label, !!figureTarget(blocks, label));
      return availability.get(label)!;
    };
    const targets = (labels: string[]) =>
      JSON.stringify(labels.filter(available));
    const selector =
      pageNumber === undefined
        ? ".textLayer"
        : `.page[data-page-number="${pageNumber}"] .textLayer`;
    for (const layer of this.host.querySelectorAll<HTMLElement>(selector)) {
      const version = this.versions.get(layer) || 0;
      const cached = this.layers.get(layer);
      if (
        cached?.version === version &&
        cached.targets === targets(cached.labels)
      )
        continue;
      for (const link of layer.querySelectorAll("a[data-figure-reference]")) {
        const parent = link.parentNode!;
        link.replaceWith(...link.childNodes);
        parent.normalize();
      }
      const nodes: { node: Text; start: number; end: number }[] = [];
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let text = "";
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (node.parentElement?.closest("a")) continue;
        nodes.push({
          node,
          start: text.length,
          end: text.length + node.length,
        });
        text += node.data + " ";
      }
      const references = figureReferences(text);
      const labels = [
        ...new Set(references.map((reference) => reference.label)),
      ];
      // Reverse order keeps the offsets of earlier references stable.
      for (const reference of references.reverse()) {
        if (!available(reference.label)) continue;
        const end = reference.index + reference.text.length;
        for (const entry of nodes) {
          const startOffset = Math.max(0, reference.index - entry.start);
          const endOffset = Math.min(entry.end, end) - entry.start;
          if (startOffset >= endOffset) continue;
          const range = document.createRange();
          range.setStart(entry.node, startOffset);
          range.setEnd(entry.node, endOffset);
          const link = document.createElement("a");
          link.href = `#interleaf-figure-${reference.label}`;
          link.dataset.figureReference = reference.label;
          link.setAttribute("aria-label", `跳转到 ${reference.text}`);
          // The canvas supplies visible glyphs. Preserve the invisible text
          // layer, but retain the browser's keyboard focus outline.
          link.style.color = "inherit";
          link.style.textDecoration = "none";
          link.style.cursor = "pointer";
          range.surroundContents(link);
        }
      }
      this.layers.set(layer, { version, labels, targets: targets(labels) });
    }
    // Wrapping is our own structural change. It must not invalidate the cache
    // on the next block stream update or CSS-only text layer zoom.
    this.observer.takeRecords();
  }
  destroy() {
    this.host.removeEventListener("click", this.click, true);
    this.observer.disconnect();
  }
}
