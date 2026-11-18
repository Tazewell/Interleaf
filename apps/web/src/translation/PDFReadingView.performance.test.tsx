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
  type Processing,
  type TranslationBlock,
} from "@interleaf/core";
import { ReadingLinkNavigation } from "../reading-links";
import { PDFReadingView } from "./PDFReadingView";
import { choosePDFFormat, clickPDFContent } from "./pdf-reading-test-helpers";
import katex from "katex";
import { api } from "@interleaf/api";

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
    focusBlock = async () => {
      if (fixture.holdFocus)
        await new Promise<void>((resolve) => {
          fixture.finishFocus = resolve;
        });
    };
    resolveCitation = async () => ({ type: "pdf", page: 1 });
    goTo = async () => {};
    destroy = async () => {};
    constructor(
      private host: HTMLElement,
      events: ReaderEvents,
    ) {
      fixture.events = events;
    }
  }
  return {
    Engine,
    events: undefined as ReaderEvents | undefined,
    holdFocus: false,
    finishFocus: undefined as (() => void) | undefined,
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
    translate: vi.fn(async () => ({ queued: true })),
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
  {
    id: "formula",
    page: 1,
    label: "display_formula",
    text: "x=1",
    bounds: { x: 0.1, y: 0.5, width: 0.4, height: 0.1 },
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
  processing?: Processing,
  documentId = doc.id,
) {
  await act(async () =>
    root.render(
      <PDFReadingView
        document={documentId === doc.id ? doc : { ...doc, id: documentId }}
        theme={defaultTheme}
        annotations={marks}
        blocks={blocks}
        processing={processing}
        events={events}
        onReady={onReady}
      />,
    ),
  );
}
async function showTranslation() {
  await choosePDFFormat(host, "流式");
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "译文")!
      .click();
  });
  await act(async () => vi.dynamicImportSettled());
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
  fixture.holdFocus = false;
  fixture.translations = [
    {
      blockId: "formula",
      sourceHash: "formula",
      status: "complete",
      sentences: [],
      formulaMarkdown: "$$x=1$$",
    },
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

it("keeps markers through real content updates and refreshes formula, annotations, processing and retry", async () => {
  await showTranslation();
  const paragraph = host.querySelector<HTMLElement>(
    '[data-translation-block="paragraph"]',
  )!;
  await act(async () =>
    paragraph.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
  );
  const mark = {
    ...sourceAnnotation,
    location: {
      type: "pdf",
      page: 1,
      translation: {
        blockId: "paragraph",
        sourceHash: "hash",
        sentenceIndexes: [0],
        start: 0,
        end: 3,
      },
    },
  } as Annotation;
  await render(undefined, [mark]);
  expect(paragraph.classList.contains("translation-annotated")).toBe(true);
  expect(paragraph.querySelector(".translation-note-indicator")).not.toBeNull();
  expect(paragraph.dataset.hovered).toBe("true");
  const validate = vi.spyOn(katex, "renderToString");
  try {
    await act(async () =>
      fixture.push!({
        event: "translation",
        data: {
          ...fixture.translations[0],
          formulaMarkdown: "$$x=2$$",
        },
      }),
    );
    expect(validate).toHaveBeenCalledWith("x=2", expect.anything());
    expect(host.querySelector(".translation-formula")?.textContent).toContain(
      "$$x=2$$",
    );
  } finally {
    validate.mockRestore();
  }
  await act(async () =>
    fixture.push!({
      event: "translation",
      data: {
        ...fixture.translations[1],
        sourceHash: "updated",
        status: "pending",
        sentences: [],
      },
    }),
  );
  expect(paragraph.querySelector(".translation-note-indicator")).toBeNull();
  await render(undefined, [mark], { enabled: false } as Processing);
  expect(paragraph.textContent).toContain("翻译已暂停");
  await render(undefined, [], undefined, "new-document");
  await act(async () =>
    fixture.push!({
      event: "translation",
      data: {
        ...fixture.translations[1],
        status: "failed",
        error: "失败",
        sentences: [],
      },
    }),
  );
  const next = host.querySelector<HTMLElement>(
    '[data-translation-block="paragraph"]',
  )!;
  expect(next.hasAttribute("data-hovered")).toBe(false);
  await act(async () =>
    next.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(api.translate).toHaveBeenLastCalledWith("new-document", "paragraph");
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
        ...fixture.translations[1],
        sentences: [
          { source: "Original paragraph.", target: "更新后的译文。" },
        ],
      },
    }),
  );
  expect(host.textContent).toContain("更新后的译文。");
  expect(fixture.markdownRenders).toContain("更新后的译文。");
});

it("updates hover and focus markers without rebuilding content or validating formulas", async () => {
  await choosePDFFormat(host, "流式");
  await clickPDFContent(host, "对照");
  await act(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await vi.dynamicImportSettled();
  });
  const paragraph = host.querySelector<HTMLElement>(
    '[data-translation-block="paragraph"]',
  )!;
  const formula = host.querySelector<HTMLElement>(
    '[data-translation-block="formula"]',
  )!;
  expect(host.querySelector(".translation-formula")).not.toBeNull();
  fixture.markdownRenders = [];
  const validate = vi.spyOn(katex, "renderToString");
  const deriveAnnotations = vi.spyOn(annotations, "flatMap");
  try {
    await act(async () => fixture.events!.blockHover!(blocks[0]));
    expect(paragraph.dataset.hovered).toBe("true");
    await act(async () =>
      formula.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
    );
    expect(paragraph.hasAttribute("data-hovered")).toBe(false);
    expect(formula.dataset.hovered).toBe("true");
    await act(async () => fixture.events!.blockHover!(null));
    expect(formula.dataset.hovered).toBe("true");
    await act(async () =>
      host
        .querySelector(".translation-document")!
        .dispatchEvent(new Event("scroll")),
    );
    expect(formula.hasAttribute("data-hovered")).toBe(false);
    fixture.holdFocus = true;
    await act(async () =>
      paragraph.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(paragraph.dataset.focused).toBe("true");
    expect(paragraph.getAttribute("aria-current")).toBe("true");
    await act(async () =>
      host
        .querySelector(".translation-source")!
        .dispatchEvent(new WheelEvent("wheel", { bubbles: true })),
    );
    expect(paragraph.hasAttribute("data-focused")).toBe(false);
    expect(paragraph.hasAttribute("aria-current")).toBe(false);
    await act(async () => fixture.finishFocus?.());
    expect(fixture.markdownRenders).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
    expect(deriveAnnotations).not.toHaveBeenCalled();
  } finally {
    validate.mockRestore();
    deriveAnnotations.mockRestore();
  }
});
