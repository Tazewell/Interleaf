import { describe, expect, it } from "vitest";
import {
  projectNativeAnnotations,
  sourceToDisplay,
  displayToSource,
  nativeSelectionLocation,
  uniqueTextOffsets,
  nativeReadingLayout,
} from "./pdf-native-reading";
import type { NativePDFReadingPage, TranslationBlock } from "@interleaf/core";
const page: NativePDFReadingPage = {
  page: 2,
  width: 600,
  height: 800,
  outputWidth: 1212,
  translationOffsetX: 612,
  paragraphs: [
    {
      id: "p",
      blockId: "b",
      sourceHash: "h",
      bounds: { x: 60, y: 80, width: 480, height: 160 },
      translated: true,
      target: "甲乙 丙丁",
    },
  ],
};
const translations: TranslationBlock[] = [
  {
    blockId: "b",
    sourceHash: "h",
    status: "complete",
    sentences: [
      { source: "one", target: "甲乙" },
      { source: "two", target: "丙丁" },
    ],
  },
];
const singlePage = { ...page, outputWidth: 600, translationOffsetX: 0 };
it("recognizes single-page translated ink before source geometry and keeps unknown ink unanchored", () => {
  const rect = { x: 0.1, y: 0.1, width: 0.8, height: 0.2 };
  const location = nativeSelectionLocation(
    singlePage,
    translations,
    "乙 丙",
    [rect],
    "translation-only",
  );
  expect(location.translation).toMatchObject({
    blockId: "b",
    start: 1,
    end: 3,
  });
  expect(location.rects).toBeUndefined();
  expect(displayToSource(singlePage, rect, "translation-only")).toBeUndefined();
  expect(
    nativeSelectionLocation(
      singlePage,
      translations,
      "retained original",
      [rect],
      "translation-only",
    ),
  ).toEqual({ type: "pdf", page: 2, quote: "retained original" });
  expect(
    nativeSelectionLocation(
      {
        ...singlePage,
        paragraphs: singlePage.paragraphs.map((p) => ({
          ...p,
          translated: false,
        })),
      },
      translations,
      "甲乙",
      [rect],
      "translation-only",
    ).translation,
  ).toBeUndefined();
});
it("defaults missing layout to dual and rejects unknown layouts without inferring geometry", () => {
  expect(nativeReadingLayout({})).toBe("side-by-side");
  expect(nativeReadingLayout({ layout: "translation-only" })).toBe(
    "translation-only",
  );
  expect(() => nativeReadingLayout({ layout: "unknown" } as never)).toThrow();
});
describe("native reading coordinate and anchor boundary", () => {
  it("round trips normalized source rectangles and rejects gutter/right ink as source", () => {
    const rect = { x: 0.1, y: 0.2, width: 0.4, height: 0.1 };
    const displayed = sourceToDisplay(page, rect);
    expect(displayToSource(page, displayed)).toEqual(rect);
    expect(
      displayToSource(page, sourceToDisplay(page, rect, "translation")),
    ).toBeUndefined();
    expect(
      displayToSource(page, {
        x: 600 / 1212,
        y: 0,
        width: 12 / 1212,
        height: 0.1,
      }),
    ).toBeUndefined();
  });
  it("maps right selections to existing no-separator UTF16 offsets", () => {
    const rect = sourceToDisplay(
      page,
      { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
      "translation",
    );
    const location = nativeSelectionLocation(page, translations, "乙 丙", [
      rect,
    ]);
    expect(location.translation).toMatchObject({
      blockId: "b",
      sourceHash: "h",
      start: 1,
      end: 3,
      sentenceIndexes: [0, 1],
      targetText: "甲乙丙丁",
    });
    expect(location.rects).toBeUndefined();
    expect(location.x).toBe(0.1);
  });
  it("keeps cross-side, stale and retained text truthful without precise anchors", () => {
    const left = sourceToDisplay(page, {
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.2,
    });
    const right = sourceToDisplay(
      page,
      { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
      "translation",
    );
    for (const [p, t, r] of [
      [page, translations, [left, right]],
      [page, [{ ...translations[0], sourceHash: "stale" }], [right]],
      [
        {
          ...page,
          paragraphs: page.paragraphs.map((p) => ({ ...p, translated: false })),
        },
        translations,
        [right],
      ],
    ] as const) {
      const location = nativeSelectionLocation(p, [...t], "乙 丙", [...r]);
      expect(location).toEqual({ type: "pdf", page: 2, quote: "乙 丙" });
    }
  });
  it("normalizes whitespace/soft hyphens with UTF16 offsets, rejects repeated matches", () => {
    expect(uniqueTextOffsets("😀a\u00adb c", "a b")).toEqual({
      start: 2,
      end: 5,
    });
    expect(uniqueTextOffsets("甲乙甲乙", "甲乙")).toBeUndefined();
  });
  it("anchors plain inline-variable ink to the raw saved target", () => {
    const target = "😀时间$t$后";
    expect(uniqueTextOffsets(target, "间 t 后")).toEqual({ start: 3, end: 8 });
    expect(uniqueTextOffsets(target, "t")).toEqual({ start: 5, end: 6 });
    expect(uniqueTextOffsets("甲$t$与 t", "t")).toBeUndefined();
    expect(uniqueTextOffsets("甲$x^2$乙", "甲x^2乙")).toBeUndefined();
    expect(uniqueTextOffsets("甲$$t$$乙", "甲t乙")).toBeUndefined();
    expect(uniqueTextOffsets(String.raw`甲\$t$乙`, "甲t乙")).toBeUndefined();
    expect(uniqueTextOffsets("甲$t$乙$x^2$丙", "甲t乙")).toBeUndefined();
    expect(uniqueTextOffsets(target, "间$t$后")).toBeUndefined();
  });
  it("keeps the positions of adjacent inline variables in separate sentences", () => {
    expect(uniqueTextOffsets(["甲$t$", "$h$乙"], "t h")).toEqual({
      start: 2,
      end: 6,
    });
  });
});
it("rejects non-complete blocks even when their stale sentence payload still matches", () => {
  const right = sourceToDisplay(
    page,
    { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
    "translation",
  );
  expect(
    nativeSelectionLocation(
      page,
      [{ ...translations[0], status: "running" }],
      "甲乙",
      [right],
    ).translation,
  ).toBeUndefined();
});

it.each(["side-by-side", "translation-only"] as const)(
  "projects multi-page HTML annotations onto the correct displayed paragraphs in %s",
  (layout) => {
    const geometry = layout === "translation-only" ? singlePage : page;
    const anchor = {
      blockId: "b",
      sourceHash: "h",
      sentenceIndexes: [0],
      start: 0,
      end: 2,
      targetText: "甲乙丙丁",
    };
    const projected = projectNativeAnnotations(
      [
        {
          id: "a",
          documentId: "d",
          kind: "highlight",
          color: "#facc15",
          quote: "甲乙",
          note: "",
          createdAt: "",
          location: {
            type: "pdf",
            page: 2,
            translation: {
              ...anchor,
              ranges: [
                { ...anchor, quote: "甲乙" },
                { ...anchor, blockId: "c", quote: "甲乙" },
              ],
            },
          },
        },
      ],
      {
        fileURL: "/",
        translations: [...translations, { ...translations[0], blockId: "c" }],
        metadata: {
          layout,
          version: 1,
          documentId: "d",
          cacheKey: "k",
          originalSha256: "s",
          layoutRevision: "l",
          translationRevision: "t",
          rendererVersion: "r",
          pdfSha256: "s",
          pdfBytes: 1,
          translatedParagraphs: 2,
          originalParagraphs: 0,
          warnings: [],
          pages: [
            geometry,
            {
              ...geometry,
              page: 3,
              paragraphs: page.paragraphs.map((p) => ({ ...p, blockId: "c" })),
            },
          ],
        },
      },
    );
    expect(
      projected.map((a) => a.location.type === "pdf" && a.location.page),
    ).toEqual([2, 3]);
    expect(
      projected.every(
        (a) =>
          a.location.type === "pdf" &&
          a.location.rects!.every((r) =>
            layout === "translation-only" ? r.x === 0.1 : r.x > 0.5,
          ),
      ),
    ).toBe(true);
  },
);
