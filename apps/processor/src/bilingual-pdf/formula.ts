import type {
  NativePDFBounds,
  NativePDFFormula,
} from "../../../../packages/reader-core/src/bilingual-pdf";

export interface SourceSpan {
  text: string;
  bounds: NativePDFBounds;
  fontSize: number;
  math: boolean;
  formulaRegionId?: string;
}
export function unionBounds(
  a: NativePDFBounds,
  b: NativePDFBounds,
): NativePDFBounds {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
export function readingSpans(spans: SourceSpan[]) {
  const lines: { bounds: NativePDFBounds; spans: SourceSpan[] }[] = [];
  for (const span of [...spans].sort(
    (a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x,
  )) {
    const line = lines.find(
      (l) =>
        Math.min(
          l.bounds.y + l.bounds.height,
          span.bounds.y + span.bounds.height,
        ) -
          Math.max(l.bounds.y, span.bounds.y) >
        Math.min(l.bounds.height, span.bounds.height) * 0.25,
    );
    if (line) {
      line.spans.push(span);
      line.bounds = unionBounds(line.bounds, span.bounds);
    } else lines.push({ bounds: span.bounds, spans: [span] });
  }
  return lines
    .sort((a, b) => a.bounds.y - b.bounds.y)
    .flatMap((l) => l.spans.sort((a, b) => a.bounds.x - b.bounds.x));
}
export function validateFormulaTokens(
  text: string,
  formulas: NativePDFFormula[],
) {
  // Shared with the Go completed-target validator: only indexed v/V markers
  // reserve a namespace; JSON, named placeholders and unmatched braces are text.
  const found = text.match(/\{[vV][0-9][^{}]*\}?/g) ?? [];
  const expected = formulas.map((f) => f.token);
  if (
    new Set(expected).size !== expected.length ||
    expected.some((t, i) => t !== `{v${i}}`) ||
    found.length !== expected.length ||
    found.some((t) => !expected.includes(t)) ||
    expected.some((t) => found.filter((v) => v === t).length !== 1)
  )
    throw new Error("公式占位符缺失、重复或不受支持");
}
export function protectFormulas(spans: SourceSpan[]) {
  let source = "",
    originalSource = "",
    unprotectedSource = "";
  const formulas: NativePDFFormula[] = [];
  let previous: SourceSpan | undefined;
  let active: NativePDFFormula | undefined;
  for (const span of spans) {
    const gap =
      previous &&
      (Math.abs(span.bounds.y - previous.bounds.y) > span.fontSize * 0.7 ||
        span.bounds.x - previous.bounds.x - previous.bounds.width >
          span.fontSize * 0.18)
        ? " "
        : "";
    originalSource += gap + span.text;
    if (span.math) {
      unprotectedSource += "\0";
      const sameGroup =
        active &&
        previous?.math &&
        span.bounds.x - active.bounds.x - active.bounds.width <
          Math.max(previous.fontSize, span.fontSize) * 0.7 &&
        span.bounds.x >= active.bounds.x &&
        Math.abs(span.bounds.y - active.bounds.y) <
          Math.max(active.bounds.height, span.bounds.height) * 1.2;
      if (sameGroup) active!.bounds = unionBounds(active!.bounds, span.bounds);
      else {
        const token = `{v${formulas.length}}`;
        active = { token, bounds: { ...span.bounds } };
        formulas.push(active);
        source += gap + token;
      }
    } else {
      source += gap + span.text;
      unprotectedSource += gap + span.text;
      active = undefined;
    }
    previous = span;
  }
  if (/\{[vV][0-9]/.test(unprotectedSource))
    throw new Error("原文包含与公式协议冲突的保留占位符");
  return { source, originalSource, formulas };
}
