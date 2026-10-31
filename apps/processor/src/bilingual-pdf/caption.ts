import type { NativePDFBounds } from "../../../../packages/interleaf-core/src/bilingual-pdf";
import { readingSpans, unionBounds, type SourceSpan } from "./formula";

/** Match glyph content uniquely; asset file paths and model-provided rectangles
 * never determine where a caption is erased. Whitespace alone may differ. */
export function locateCaption(
  caption: string,
  spans: SourceSpan[],
  page: number,
  id: string,
) {
  const normalized = (s: string) => s.replace(/\s+/gu, "");
  const expected = normalized(caption),
    ordered = readingSpans(spans);
  const pieces = ordered.map((s) => normalized(s.text)),
    joined = pieces.join("");
  const start = joined.indexOf(expected),
    end = start + expected.length;
  if (!expected || start < 0 || joined.indexOf(expected, start + 1) >= 0)
    throw new Error(`第 ${page} 页图题 ${id} 无法唯一定位`);
  let offset = 0;
  const members: SourceSpan[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const next = offset + pieces[i].length;
    if (next > start && offset < end) {
      if (offset < start || next > end)
        throw new Error(`第 ${page} 页图题 ${id} 跨字形项边缘，无法安全定位`);
      members.push(ordered[i]);
    }
    offset = next;
  }
  const bounds = members.map((s) => s.bounds).reduce(unionBounds);
  return { members, bounds: bounds as NativePDFBounds };
}
