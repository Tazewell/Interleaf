// @vitest-environment jsdom
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Annotation,
  type Document,
  type PDFBlock,
  type ReaderEvents,
  type TranslationBlock,
} from "@interleaf/core";
import { ReadingLinkNavigation } from "../reading-links";
import { PDFReadingView } from "./PDFReadingView";

const fixture = vi.hoisted(() => {
  class Engine {
    annotationLayer?: import("../engines/pdf-annotations").PDFAnnotationLayer;
    open = async () => {
      this.host.innerHTML = '<div class="page" data-page-number="1"></div>';
      const { PDFAnnotationLayer } = await import("../engines/pdf-annotations");
      this.annotationLayer = new PDFAnnotationLayer(this.host, () => {});
    };
    setTheme = async () => {};
    highlight = async (annotations: Annotation[]) => {
      this.annotationLayer?.setAnnotations(annotations);
    };
    setBlocks = () => {};
    getTOC = async () => [];
    getLocation = () => ({ type: "pdf", page: 1 });
    clearSelection = () => {};
    hoverBlock = () => {};
    focusSentences = async () => {};
    cancelBlockFocus = () => {};
    followBlock = async () => {};
    focusBlock = async () => {};
    resolveCitation = async () => ({ type: "pdf", page: 1 });
    goTo = async () => {};
    destroy = async () => {};
    constructor(private host: HTMLElement) {}
  }
  return {
    Engine,
    markdownRenders: [] as string[],
    translations: [] as TranslationBlock[],
    push: undefined as
      | ((event: { event: "translation"; data: TranslationBlock }) => void)
      | undefined,
  };
});
vi.mock("../engines/pdf", () => ({ PDFReaderAdapter: fixture.Engine }));
vi.mock("@interleaf/api", () => ({
  api: {
    assistance: vi.fn(async () => undefined),
    translationStream: vi.fn(async (_id, signal, push) => {
      fixture.push = push;
      push({ event: "snapshot", data: fixture.translations });
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }),
  },
  blockImageURL: () => "",
}));
vi.mock("../chat/MessageMarkdown", () => ({
  MessageMarkdown: ({
    content,
    citationBlockId,
  }: {
    content: string;
    citationBlockId?: string;
  }) => {
    fixture.markdownRenders.push(content);
    const navigate = useContext(ReadingLinkNavigation);
    return (
      <p>
        {content}
        <a
          href="#reference"
          onClick={(event) => {
            event.preventDefault();
            navigate?.(citationBlockId!, "1");
          }}
        >
          参考文献
        </a>
      </p>
    );
  },
}));

let root: Root, host: HTMLDivElement;
const doc = { id: "pdf-performance", type: "pdf" } as Document;
const blocks: PDFBlock[] = [
  {
    id: "paragraph",
    page: 1,
    label: "text",
    text: "Original paragraph.",
    bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 },
  },
];
const sourceAnnotation = {
  id: "source-mark",
  documentId: doc.id,
  kind: "highlight",
  location: { type: "pdf", page: 1, rects: [blocks[0].bounds] },
  quote: "Original paragraph.",
} as Annotation;
const annotations = [sourceAnnotation];
const onReady = () => {};
async function render(
  events: ReaderEvents = { location: vi.fn(), selection: vi.fn() },
  marks = annotations,
) {
  await act(async () =>
    root.render(
      <PDFReadingView
        document={doc}
        theme={defaultTheme}
        annotations={marks}
        blocks={blocks}
        events={events}
        onReady={onReady}
      />,
    ),
  );
}
async function showTranslation() {
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "译文")!
      .click();
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  fixture.markdownRenders = [];
  fixture.translations = [
    {
      blockId: "paragraph",
      sourceHash: "hash",
      status: "complete",
      sentences: [{ source: "Original paragraph.", target: "译文段落。" }],
    },
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
  await act(async () => vi.dynamicImportSettled());
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("preserves source annotation DOM across location-only parent renders", async () => {
  const marker = host.querySelector(".interleaf-annotation");
  expect(marker).not.toBeNull();
  // Workspace creates fresh event handlers when its reading position changes.
  await render({ location: vi.fn(), selection: vi.fn() });
  expect(host.querySelector(".interleaf-annotation")).toBe(marker);
  await render(undefined, [{ ...sourceAnnotation, color: "#123456" }]);
  expect(host.querySelector(".interleaf-annotation")).not.toBe(marker);
  expect(
    host
      .querySelector<HTMLElement>(".interleaf-annotation")!
      .style.getPropertyValue("--annotation-color"),
  ).toBe("#123456");
});

it("keeps translated text renders out of position updates while preserving live content and citation handlers", async () => {
  await showTranslation();
  expect(host.textContent).toContain("译文段落。");
  fixture.markdownRenders = [];
  const internalLink = vi.fn();
  await render({ location: vi.fn(), selection: vi.fn(), internalLink });
  expect(fixture.markdownRenders).toEqual([]);
  await act(async () =>
    host.querySelector<HTMLAnchorElement>(".translation-document a")!.click(),
  );
  expect(internalLink).toHaveBeenCalledWith({ type: "pdf", page: 1 });
  await act(async () =>
    fixture.push!({
      event: "translation",
      data: {
        ...fixture.translations[0],
        sentences: [
          { source: "Original paragraph.", target: "更新后的译文。" },
        ],
      },
    }),
  );
  expect(host.textContent).toContain("更新后的译文。");
  expect(fixture.markdownRenders).toContain("更新后的译文。");
});
