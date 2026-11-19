import type {
  Annotation,
  NativePDFReadingManifest,
  NativePDFReadingLayout,
  NativePDFReadingPage,
  NativePDFReadingParagraph,
  PDFLocation,
  TranslationBlock,
  TranslationLocation,
} from "@interleaf/core";
export interface NativePDFReadingDescriptor {
  metadata: NativePDFReadingManifest;
  fileURL: string;
  translations: TranslationBlock[];
  /** The paired original viewer already owns the source PDF and its navigation. */
  alongsideOriginal?: boolean;
}
export function nativeReadingLayout(
  metadata: Pick<NativePDFReadingManifest, "layout">,
): NativePDFReadingLayout {
  if (metadata.layout === undefined) return "side-by-side";
  if (
    metadata.layout === "side-by-side" ||
    metadata.layout === "translation-only"
  )
    return metadata.layout;
  throw new Error("不支持的原版式阅读布局");
}
export type ReadingRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export function sourceToDisplay(
  page: NativePDFReadingPage,
  rect: ReadingRect,
  side: "source" | "translation" = "source",
): ReadingRect {
  return {
    ...rect,
    x:
      (rect.x * page.width +
        (side === "translation" ? page.translationOffsetX : 0)) /
      page.outputWidth,
    width: (rect.width * page.width) / page.outputWidth,
  };
}
export function displayToSource(
  page: NativePDFReadingPage,
  rect: ReadingRect,
  layout: NativePDFReadingLayout = "side-by-side",
): ReadingRect | undefined {
  if (layout === "translation-only") return;
  const x = rect.x * page.outputWidth,
    width = rect.width * page.outputWidth;
  if (
    x < -1e-7 ||
    x + width > page.width + 1e-7 ||
    rect.y < 0 ||
    rect.y + rect.height > 1 + 1e-7
  )
    return;
  return { ...rect, x: x / page.width, width: width / page.width };
}
function inlineVariableDelimiters(parts: readonly string[]) {
  const delimiters = new Set<number>();
  let offset = 0;
  for (const part of parts) {
    const matches = [...part.matchAll(/(?<![$\\])\$([A-Za-z])\$(?!\$)/g)];
    // The PDF strips these delimiters only when every dollar is accounted for.
    if ((part.match(/\$/g)?.length ?? 0) !== matches.length * 2) return;
    for (const match of matches) {
      delimiters.add(offset + match.index);
      delimiters.add(offset + match.index + 2);
    }
    offset += part.length;
  }
  return delimiters;
}

function normalized(text: string, skipped?: Set<number>) {
  let value = "";
  const starts: number[] = [],
    ends: number[] = [];
  for (let offset = 0; offset < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(offset)!);
    if (!skipped?.has(offset) && !/[\s\u00ad]/u.test(char))
      for (let i = 0; i < char.length; i++) {
        value += char[i];
        starts.push(offset + i);
        ends.push(offset + i + 1);
      }
    offset += char.length;
  }
  return { value, starts, ends };
}
/** Match rendered PDF text and keep offsets in the concatenated raw UTF-16 target. */
export function uniqueTextOffsets(
  target: string | readonly string[],
  quote: string,
) {
  const parts = typeof target === "string" ? [target] : target,
    t = normalized(parts.join(""), inlineVariableDelimiters(parts)),
    q = normalized(quote).value;
  if (!q) return;
  const index = t.value.indexOf(q);
  if (index < 0 || t.value.indexOf(q, index + 1) >= 0) return;
  return { start: t.starts[index], end: t.ends[index + q.length - 1] };
}
export function matchingTranslation(
  p: NativePDFReadingParagraph,
  translations: TranslationBlock[],
) {
  if (!p.translated || !p.target) return;
  return translations.find(
    (t) =>
      t.status === "complete" &&
      t.blockId === p.blockId &&
      t.sourceHash === p.sourceHash &&
      t.sentences.length > 0 &&
      t.sentences.map((s) => s.target).join(" ") === p.target,
  );
}
export function paragraphSourceBounds(
  page: NativePDFReadingPage,
  p: NativePDFReadingParagraph,
): ReadingRect {
  return {
    x: p.bounds.x / page.width,
    y: p.bounds.y / page.height,
    width: p.bounds.width / page.width,
    height: p.bounds.height / page.height,
  };
}
export function nativeSelectionLocation(
  page: NativePDFReadingPage,
  translations: TranslationBlock[],
  text: string,
  rects: ReadingRect[],
  layout: NativePDFReadingLayout = "side-by-side",
): PDFLocation {
  const basic: PDFLocation = { type: "pdf", page: page.page, quote: text };
  if (!rects.length) return basic;
  const source = rects.map((r) => displayToSource(page, r, layout));
  if (source.every((r) => !!r))
    return { ...basic, rects: source as ReadingRect[] };
  const paragraphs = page.paragraphs.filter((p) => {
    const b = sourceToDisplay(
      page,
      paragraphSourceBounds(page, p),
      "translation",
    );
    return rects.every(
      (r) =>
        r.x >= b.x - 1 / page.outputWidth &&
        r.x + r.width <= b.x + b.width + 1 / page.outputWidth &&
        r.y >= b.y - 2 / page.height &&
        r.y + r.height <= b.y + b.height + 2 / page.height,
    );
  });
  if (paragraphs.length !== 1) return basic;
  const paragraph = paragraphs[0],
    t = matchingTranslation(paragraph, translations);
  if (!t) return basic;
  const sentenceTargets = t.sentences.map((s) => s.target);
  const targetText = sentenceTargets.join("");
  const offsets = uniqueTextOffsets(sentenceTargets, text);
  if (!offsets) return basic;
  let offset = 0;
  const sentenceIndexes = t.sentences.flatMap((s, i) => {
    const start = offset;
    offset += s.target.length;
    return start < offsets.end && offset > offsets.start ? [i] : [];
  });
  return {
    ...basic,
    x: paragraph.bounds.x / page.width,
    y: paragraph.bounds.y / page.height,
    translation: {
      blockId: t.blockId,
      sourceHash: t.sourceHash,
      sentenceIndexes,
      ...offsets,
      targetText,
      sourceText: sentenceIndexes.map((i) => t.sentences[i].source).join(" "),
    },
  };
}
/** Honest paragraph fallback for old HTML anchors. Never project these onto the source half. */
export function translationParagraph(
  page: NativePDFReadingPage,
  translations: TranslationBlock[],
  anchor: TranslationLocation,
) {
  const p = page.paragraphs.find(
    (p) => p.blockId === anchor.blockId && p.sourceHash === anchor.sourceHash,
  );
  const t = p && matchingTranslation(p, translations);
  if (!p || !t) return;
  const target = t.sentences.map((s) => s.target).join("");
  if (
    anchor.targetText !== target ||
    anchor.start < 0 ||
    anchor.end <= anchor.start ||
    anchor.end > target.length
  )
    return;
  return p;
}
export function projectNativeAnnotations(
  annotations: Annotation[],
  descriptor: NativePDFReadingDescriptor,
): Annotation[] {
  const layout = nativeReadingLayout(descriptor.metadata);
  return annotations.flatMap((a) => {
    if (a.location.type !== "pdf") return [];
    const location = a.location;
    if (location.translation) {
      const anchor = location.translation;
      const anchors = anchor.ranges?.length ? anchor.ranges : [anchor];
      return descriptor.metadata.pages.flatMap((page) => {
        const rects = anchors.flatMap((item) => {
          const p = translationParagraph(page, descriptor.translations, item);
          return p
            ? [
                sourceToDisplay(
                  page,
                  paragraphSourceBounds(page, p),
                  "translation",
                ),
              ]
            : [];
        });
        return rects.length
          ? [{ ...a, location: { ...location, page: page.page, rects } }]
          : [];
      });
    }
    if (layout === "translation-only") return [];
    const page = descriptor.metadata.pages.find(
      (p) => p.page === location.page,
    );
    if (!page) return [];
    return [
      {
        ...a,
        location: {
          ...location,
          rects: location.rects?.map((r) => sourceToDisplay(page, r)),
        },
      },
    ];
  });
}
