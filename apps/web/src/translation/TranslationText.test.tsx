// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFBlock, Processing, TranslationBlock } from "@interleaf/core";
import { TranslationText } from "./TranslationText";
let host: HTMLDivElement, root: Root;
const base: PDFBlock = {
  id: "p1-b1",
  page: 1,
  label: "table",
  text: "INTERNAL CELLS 66.7 58.6",
  image: "assets/p1-b1.png",
  bounds: { x: 0, y: 0, width: 1, height: 1 },
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  await import("../chat/MessageMarkdown");
  await import("./FormulaFragment");
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function render(
  block: PDFBlock,
  translation?: TranslationBlock,
  formulaNumber?: string,
  processing?: Processing,
) {
  await act(async () =>
    root.render(
      <TranslationText
        block={block}
        formulaNumber={formulaNumber}
        translation={translation}
        documentId="doc"
        retry={() => {}}
        processing={processing}
      />,
    ),
  );
  for (
    let i = 0;
    i < 80 &&
    host.querySelector(".translation-formula") == null &&
    translation?.formulaMarkdown;
    i++
  ) {
    if (
      host.querySelector("img") &&
      translation.formulaMarkdown.includes("\\unknown")
    )
      break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
}
it.each(["failed", "waiting", "queued", "paused"])(
  "does not claim a %s translation job is actively translating",
  async (status) => {
    const processing = {
      documentId: "doc",
      enabled: status !== "paused",
      status,
      phase: "translating",
      detail: "请确认连接",
    } as Processing;
    await render(
      { ...base, label: "text", image: undefined },
      {
        blockId: base.id,
        sourceHash: "hash",
        status: "pending",
        sentences: [],
      },
      undefined,
      processing,
    );
    expect(host.textContent).not.toContain("正在翻译");
    expect(host.textContent).toContain(
      status === "failed"
        ? "翻译已停止"
        : status === "waiting"
          ? "等待配置"
          : status === "queued"
            ? "等待翻译"
            : "翻译已暂停",
    );
  },
);
it("keeps successful text visible when the overall job has failed", async () => {
  await render(
    { ...base, label: "text", image: undefined },
    {
      blockId: base.id,
      sourceHash: "hash",
      status: "complete",
      sentences: [{ source: "Source", target: "已保存的译文" }],
    },
    undefined,
    { status: "failed", enabled: true } as Processing,
  );
  expect(host.textContent).toContain("已保存的译文");
  expect(host.textContent).not.toContain("翻译已停止");
});
it("labels an unconverted idle formula as its preserved original", async () => {
  await render(
    { ...base, label: "display_formula" },
    { blockId: base.id, sourceHash: "hash", status: "idle", sentences: [] },
  );
  expect(host.querySelector("img")).not.toBeNull();
  expect(host.textContent).toContain("保留原图");
  expect(host.textContent).not.toContain("公式转换中");
});
it.each(["table", "chart", "image"])(
  "keeps %s body out of the translation view",
  async (label) => {
    await render({ ...base, label });
    expect(host.querySelector("img")).not.toBeNull();
    expect(host.textContent).not.toContain("INTERNAL");
    expect(host.textContent).not.toContain("正在翻译");
  },
);
it("renders only the translated caption alongside the table image", async () => {
  const caption = "Table 5. Results.";
  await render(
    { ...base, caption },
    {
      blockId: base.id,
      sourceHash: "test",
      status: "complete",
      sentences: [{ source: caption, target: "表 5. 结果。" }],
    },
  );
  expect(host.querySelector("img")).not.toBeNull();
  expect(host.textContent).toContain("表 5. 结果。");
  expect(host.textContent).not.toContain("INTERNAL");
});
it("inserts the formula-only Markdown at the formula block", async () => {
  await render(
    { ...base, label: "display_formula" },
    {
      blockId: base.id,
      sourceHash: "formula",
      status: "complete",
      sentences: [],
      formulaMarkdown: "$$\nS(i,j)=\\frac{1}{2}\\log p_R(j\\mid i)\n$$\n",
    },
  );
  for (let i = 0; i < 80 && !host.querySelector(".katex-display"); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  expect(host.querySelector(".katex-display")).not.toBeNull();
  expect(host.querySelector(".katex-error")).toBeNull();
  expect(host.querySelector("details img")).not.toBeNull();
  expect(host.querySelector("details")?.open).toBe(false);
});
it("retains the original formula image for invalid LaTeX", async () => {
  await render(
    { ...base, label: "display_formula" },
    {
      blockId: base.id,
      sourceHash: "formula",
      status: "complete",
      sentences: [],
      formulaMarkdown: "$$\n\\unknowncommand{x}\n$$\n",
    },
  );
  expect(host.querySelector("img")).not.toBeNull();
  expect(host.querySelector(".katex-error")).toBeNull();
  expect(host.querySelector(".translation-formula")).toBeNull();
});

it.each(["$$\n x=1\n$$", "$$\n\\unknowncommand{x}\n$$", ""])(
  "keeps the equation number in the formula row: %s",
  async (formulaMarkdown) => {
    await render(
      { ...base, label: "display_formula" },
      formulaMarkdown
        ? {
            blockId: base.id,
            sourceHash: "formula",
            status: "complete",
            sentences: [],
            formulaMarkdown,
          }
        : undefined,
      "(6)",
    );
    const row = host.querySelector(".translation-formula-row");
    expect(row?.querySelector(".translation-formula-number")?.textContent).toBe(
      "(6)",
    );
    expect(row?.querySelector(".translation-formula-content")).not.toBeNull();
    expect(host.querySelectorAll(".translation-formula-number")).toHaveLength(
      1,
    );
    expect(
      host.querySelector("details .translation-formula-number"),
    ).toBeNull();
  },
);

it("replaces the formula image placeholder when an asynchronous result arrives", async () => {
  const block = { ...base, label: "display_formula" };
  await render(
    block,
    {
      blockId: block.id,
      sourceHash: "formula",
      status: "running",
      sentences: [],
    },
    "(6)",
  );
  expect(host.querySelector(".translation-formula-row img")).not.toBeNull();
  expect(host.textContent).toContain("公式转换中");
  await render(
    block,
    {
      blockId: block.id,
      sourceHash: "formula",
      status: "complete",
      sentences: [],
      formulaMarkdown: "$$x=1$$",
    },
    "(6)",
  );
  expect(host.querySelector(".translation-formula-row .katex")).not.toBeNull();
  expect(host.querySelector(".translation-formula-row img")).toBeNull();
  expect(host.textContent).not.toContain("公式转换中");
  expect(host.querySelector(".translation-formula-number")?.textContent).toBe(
    "(6)",
  );
});
it("retains the placeholder and exposes an independent retry after failure", async () => {
  const retry = vi.fn();
  await act(async () =>
    root.render(
      <TranslationText
        block={{ ...base, label: "display_formula" }}
        translation={{
          blockId: base.id,
          sourceHash: "formula",
          status: "failed",
          sentences: [],
          error: "图片识别失败",
        }}
        documentId="doc"
        retry={retry}
      />,
    ),
  );
  expect(host.querySelector("img")).not.toBeNull();
  expect(host.textContent).toContain("图片识别失败");
  await act(async () => host.querySelector("button")?.click());
  expect(retry).toHaveBeenCalledOnce();
});
it("replaces a loaded layout crop with a display-sized render", async () => {
  vi.stubGlobal("devicePixelRatio", 2);
  const renderImage = vi.fn(async () => "blob:sharp");
  await act(async () =>
    root.render(
      <TranslationText
        block={base}
        documentId="doc"
        retry={() => {}}
        renderImage={renderImage}
      />,
    ),
  );
  const image = host.querySelector("img")!;
  expect(image.getAttribute("src")).toContain("assets/p1-b1.png");
  Object.defineProperty(image, "naturalWidth", { value: 480 });
  Object.defineProperty(image, "clientWidth", { value: 300 });
  await act(async () => {
    image.dispatchEvent(new Event("load"));
  });
  expect(renderImage).toHaveBeenCalledWith(
    "p1-b1",
    600,
    expect.any(AbortSignal),
    expect.any(String),
  );
  expect(image.getAttribute("src")).toBe("blob:sharp");
  // Keeps the crop's layout width so small figures are not enlarged.
  expect(image.getAttribute("width")).toBe("480");
  await act(async () => {
    image.dispatchEvent(new Event("load"));
  });
  expect(renderImage).toHaveBeenCalledTimes(1);
});

it.each(["table", "display_formula"])(
  "reserves exact %s crop pixels before lazy decode and through sharp replacement",
  async (label) => {
    const renderImage = vi.fn(async () => "blob:sharp");
    await act(async () =>
      root.render(
        <TranslationText
          block={{ ...base, label, imageSize: { width: 180, height: 46 } }}
          documentId="doc"
          retry={() => {}}
          renderImage={renderImage}
        />,
      ),
    );
    const image = host.querySelector("img")!;
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.width).toBe(180);
    expect(image.height).toBe(46);
    expect(image.style.aspectRatio).toBe("180 / 46");
    expect(image.style.objectFit).toBe("contain");
    expect(renderImage).not.toHaveBeenCalled();
    Object.defineProperty(image, "naturalWidth", { value: 180 });
    Object.defineProperty(image, "naturalHeight", { value: 46 });
    await act(async () => image.dispatchEvent(new Event("load")));
    expect(image.src).toContain("blob:sharp");
    expect(image.width).toBe(180);
    expect(image.height).toBe(46);
    expect(image.style.aspectRatio).toBe("180 / 46");
  },
);

it("captures legacy intrinsic dimensions without guessing from normalized bounds", async () => {
  await render(base);
  const image = host.querySelector("img")!;
  expect(image.getAttribute("width")).toBeNull();
  expect(image.style.aspectRatio).toBe("");
  Object.defineProperty(image, "naturalWidth", { value: 366 });
  Object.defineProperty(image, "naturalHeight", { value: 166 });
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(image.width).toBe(366);
  expect(image.height).toBe(166);
  expect(image.style.aspectRatio).toBe("366 / 166");
});

it("cancels a sharp lease on document switch and ignores its late result", async () => {
  let complete!: (url: string) => void;
  const renderImage = vi.fn(
    (_id: string, _width: number, _signal?: AbortSignal, _source?: string) =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  const draw = (documentId: string) =>
    act(async () =>
      root.render(
        <TranslationText
          block={base}
          documentId={documentId}
          retry={() => {}}
          renderImage={renderImage}
        />,
      ),
    );
  await draw("first");
  const old = host.querySelector("img")!;
  Object.defineProperty(old, "naturalWidth", { value: 180 });
  await act(async () => old.dispatchEvent(new Event("load")));
  const signal = renderImage.mock.calls[0][2] as AbortSignal;
  await draw("second");
  expect(signal.aborted).toBe(true);
  await act(async () => complete("blob:stale"));
  expect(host.querySelector("img")?.getAttribute("src")).not.toBe("blob:stale");
  expect(host.querySelector("img")).not.toBe(old);
});

it("releases sharp rendering outside the viewport margin and reacquires on return", async () => {
  let intersect!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        callback: IntersectionObserverCallback,
        options: IntersectionObserverInit,
      ) {
        intersect = callback;
        expect(options.rootMargin).toBe("1000px");
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const renderImage = vi.fn(
    async (
      _id: string,
      _width: number,
      _signal?: AbortSignal,
      _source?: string,
    ) => "blob:sharp",
  );
  await act(async () =>
    root.render(
      <TranslationText
        block={base}
        documentId="doc"
        retry={() => {}}
        renderImage={renderImage}
      />,
    ),
  );
  const image = host.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { value: 180 });
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(renderImage).not.toHaveBeenCalled();
  await act(async () =>
    intersect(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(image.src).toContain("blob:sharp");
  const signal = renderImage.mock.calls[0][2]!;
  await act(async () =>
    intersect(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(signal.aborted).toBe(true);
  expect(image.getAttribute("src")).not.toBe("blob:sharp");
  await act(async () =>
    intersect(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(renderImage).toHaveBeenCalledTimes(2);
});

it.each(["reader", "popover", "standalone"] as const)(
  "uses the actual %s scroll root for near-viewport crops",
  async (placement) => {
    let options!: IntersectionObserverInit;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          _callback: IntersectionObserverCallback,
          init: IntersectionObserverInit,
        ) {
          options = init;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const image = (
      <TranslationText block={base} documentId="doc" retry={() => {}} />
    );
    await act(async () =>
      root.render(
        <>
          <div
            className="translation-document"
            data-other-pane=""
            style={{ overflow: "auto" }}
          />
          {placement === "standalone" ? (
            <section>{image}</section>
          ) : (
            <div
              className="translation-document"
              data-reader-pane=""
              style={{ overflow: "auto" }}
            >
              {placement === "popover" ? (
                <div
                  className="translation-popover"
                  style={{ overflow: "auto" }}
                >
                  <section>{image}</section>
                </div>
              ) : (
                <section>{image}</section>
              )}
            </div>
          )}
        </>,
      ),
    );
    const expectedRoot =
      placement === "reader"
        ? host.querySelector("[data-reader-pane]")
        : placement === "popover"
          ? host.querySelector(".translation-popover")
          : null;
    expect(options.root).toBe(expectedRoot);
    expect(options.rootMargin).toBe("1000px");
    expect(observe).toHaveBeenCalledExactlyOnceWith(host.querySelector("img"));
    expect(options.root).not.toBe(host.querySelector("[data-other-pane]"));
    await act(async () => root.render(null));
    expect(disconnect).toHaveBeenCalledOnce();
  },
);

it("switches back to the original crop before releasing a replaced renderer's live URL", async () => {
  let image!: HTMLImageElement;
  let releasedSource: string | null | undefined;
  const first = vi.fn(
    async (_id: string, _width: number, signal?: AbortSignal) => {
      signal?.addEventListener("abort", () => {
        releasedSource = image.getAttribute("src");
      });
      return "blob:first";
    },
  );
  const second = vi.fn(async () => "blob:second");
  const draw = (
    renderImage: (
      id: string,
      width: number,
      signal?: AbortSignal,
    ) => Promise<string>,
  ) =>
    act(async () =>
      root.render(
        <TranslationText
          block={base}
          documentId="doc"
          retry={() => {}}
          renderImage={renderImage}
        />,
      ),
    );
  await draw(first);
  image = host.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { value: 180 });
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(image.getAttribute("src")).toBe("blob:first");
  await draw(second);
  expect(releasedSource).not.toBe("blob:first");
  expect(image.getAttribute("src")).toBe("blob:second");
});

it.each([
  { width: -1, height: 20 },
  { width: Infinity, height: 2 },
  { width: 2.5, height: 2 },
])("ignores invalid crop metadata %j", async (imageSize) => {
  await render({ ...base, imageSize });
  const image = host.querySelector("img")!;
  expect(image.getAttribute("width")).toBeNull();
  expect(image.getAttribute("height")).toBeNull();
});

it("preserves the supplied crop ratios for mixed page sizes with identical normalized bounds", async () => {
  await act(async () =>
    root.render(
      <>
        {[
          { width: 366, height: 166 },
          { width: 246, height: 86 },
        ].map((imageSize, i) => (
          <TranslationText
            key={i}
            block={{ ...base, id: `p${i + 1}-b1`, page: i + 1, imageSize }}
            documentId="doc"
            retry={() => {}}
          />
        ))}
      </>,
    ),
  );
  const images = host.querySelectorAll("img");
  expect(images[0].style.aspectRatio).toBe("366 / 166");
  expect(images[1].style.aspectRatio).toBe("246 / 86");
});

it("replaces an old sharp image after a full layout reparse", async () => {
  const renderImage = vi.fn(async () => "blob:old-sharp");
  const draw = async (image: string) =>
    act(async () =>
      root.render(
        <TranslationText
          block={{ ...base, image }}
          documentId="doc"
          retry={() => {}}
          renderImage={renderImage}
        />,
      ),
    );
  await draw("assets/p1-b1.png");
  const old = host.querySelector("img")!;
  Object.defineProperty(old, "naturalWidth", { value: 480 });
  await act(async () => old.dispatchEvent(new Event("load")));
  expect(old.getAttribute("src")).toBe("blob:old-sharp");
  await draw("assets/0123456789abcdef0123456789abcdef_p1-b1.png");
  const image = host.querySelector("img")!;
  expect(image).not.toBe(old);
  expect(image.getAttribute("src")).toContain(
    "?v=assets%2F0123456789abcdef0123456789abcdef_p1-b1.png",
  );
});
