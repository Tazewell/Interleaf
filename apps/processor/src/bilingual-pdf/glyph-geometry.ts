import type { PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { NativePDFBounds } from "../../../../packages/reader-core/src/bilingual-pdf";

type Matrix = number[];
interface State {
  ctm: Matrix;
  tm: Matrix;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  font: string;
  size: number;
  char: number;
  word: number;
  scale: number;
  rise: number;
  leading: number;
  mode: number;
  proven: boolean;
}
interface Glyph {
  text: string;
  font: string;
  x: number;
  y: number;
  endX: number;
  endY: number;
  proven: boolean;
}
export interface ItemGlyph {
  start: number;
  end: number;
  x: number;
  endX: number;
}
const identity = () => [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const point = (m: Matrix, x: number, y: number) => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});

/** Replay only positioning state. Unsupported writing modes cannot be used to
 * split a TextItem. Every returned character position comes from its own showText
 * occurrence, never a Unicode width map or a ratio of the final item width. */
export function createGlyphLocator(
  page: PDFPageProxy,
  operators: Awaited<ReturnType<PDFPageProxy["getOperatorList"]>>,
  viewport: Matrix,
  ops: Record<string, number>,
) {
  let s: State = {
    ctm: identity(),
    tm: identity(),
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    font: "",
    size: 0,
    char: 0,
    word: 0,
    scale: 1,
    rise: 0,
    leading: 0,
    mode: 0,
    proven: true,
  };
  const stack: State[] = [],
    glyphs: Glyph[] = [];
  const save = () => stack.push({ ...s, ctm: [...s.ctm], tm: [...s.tm] });
  const restore = () => {
    const old = stack.pop();
    if (old) s = old;
    else s.proven = false;
  };
  const move = (x: number, y: number) => {
    s.x = s.lineX += x;
    s.y = s.lineY += y;
  };
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i],
      a = operators.argsArray[i] ?? [];
    if (op === ops.save) save();
    else if (op === ops.restore) restore();
    else if (op === ops.transform) s.ctm = multiply(s.ctm, a);
    else if (op === ops.paintFormXObjectBegin) {
      save();
      if (a[0]) s.ctm = multiply(s.ctm, a[0]);
    } else if (op === ops.paintFormXObjectEnd) restore();
    else if (op === ops.beginGroup) {
      save();
      if (a[0]?.matrix) s.ctm = multiply(s.ctm, a[0].matrix);
      else s.proven = false;
    } else if (op === ops.endGroup) restore();
    else if (op === ops.beginText) {
      s.tm = identity();
      s.x = s.y = s.lineX = s.lineY = 0;
    } else if (op === ops.setFont) {
      s.font = a[0];
      s.size = a[1];
    } else if (op === ops.setCharSpacing) s.char = a[0];
    else if (op === ops.setWordSpacing) s.word = a[0];
    else if (op === ops.setHScale) s.scale = a[0] / 100;
    else if (op === ops.setTextRise) s.rise = a[0];
    else if (op === ops.setLeading) s.leading = -a[0];
    else if (op === ops.setTextRenderingMode) s.mode = a[0];
    else if (op === ops.setTextMatrix) {
      s.tm = Array.from(
        typeof a[0] === "object" && a[0]?.length === 6 ? a[0] : a,
      );
      s.x = s.y = s.lineX = s.lineY = 0;
    } else if (op === ops.moveText) move(a[0], a[1]);
    else if (op === ops.setLeadingMoveText) {
      s.leading = a[1];
      move(a[0], a[1]);
    } else if (op === ops.nextLine) move(0, s.leading);
    else if (op === ops.setGState) {
      for (const [key, value] of a[0] ?? []) {
        if (key === "Font") {
          s.font = value[0];
          s.size = value[1];
        }
        if (key === "TR") s.mode = value;
      }
    } else if (op === ops.showText) {
      const font = page.commonObjs.get(s.font) as {
        fontMatrix?: number[];
        vertical?: boolean;
        isType3Font?: boolean;
        remeasure?: boolean;
      };
      const matrix = multiply(viewport, multiply(s.ctm, s.tm));
      const proven =
        s.proven &&
        s.size > 0 &&
        s.scale > 0 &&
        s.mode === 0 &&
        !font.vertical &&
        !font.isType3Font &&
        Math.abs(matrix[1]) < 0.0001 &&
        matrix[0] > 0;
      const unit = s.size * (font.fontMatrix?.[0] ?? 0.001);
      for (const glyph of a[0] ?? []) {
        if (typeof glyph === "number") {
          s.x -= ((glyph * s.size) / 1000) * s.scale;
          continue;
        }
        if (
          !glyph ||
          typeof glyph.unicode !== "string" ||
          !Number.isFinite(glyph.width)
        ) {
          s.proven = false;
          continue;
        }
        const start = point(matrix, s.x, s.y + s.rise),
          end = point(matrix, s.x + glyph.width * unit * s.scale, s.y + s.rise);
        glyphs.push({
          text: glyph.unicode,
          font: s.font,
          x: start.x,
          y: start.y,
          endX: end.x,
          endY: end.y,
          proven,
        });
        s.x +=
          (glyph.width * unit + s.char + (glyph.isSpace ? s.word : 0)) *
          s.scale;
      }
    } else if (
      [
        ops.showSpacedText,
        ops.nextLineShowText,
        ops.nextLineSetSpacingShowText,
      ].includes(op)
    )
      s.proven = false;
  }
  const compact = (text: string) => text.replace(/\s+/gu, "");
  return (
    item: TextItem,
    bounds: NativePDFBounds,
    baseline: number,
  ): ItemGlyph[] => {
    const wanted = compact(item.str),
      candidates: ItemGlyph[][] = [];
    for (let start = 0; start < glyphs.length; start++) {
      const first = glyphs[start];
      if (
        !compact(first.text) ||
        first.font !== item.fontName ||
        Math.abs(first.y - baseline) > 0.02 ||
        first.x < bounds.x - 0.02 ||
        first.x > bounds.x + bounds.width + 0.02
      )
        continue;
      let text = "";
      const found: Glyph[] = [];
      for (
        let end = start;
        end < glyphs.length && text.length <= wanted.length;
        end++
      ) {
        const g = glyphs[end];
        if (
          g.font !== item.fontName ||
          Math.abs(g.y - baseline) > 0.02 ||
          g.x < bounds.x - 0.02 ||
          g.endX > bounds.x + bounds.width + 0.1 ||
          !g.proven
        )
          break;
        found.push(g);
        text += compact(g.text);
        if (!wanted.startsWith(text)) break;
        if (text === wanted) {
          const indices: number[] = [];
          for (let n = 0; n < item.str.length;) {
            const c = String.fromCodePoint(item.str.codePointAt(n)!);
            if (!/\s/u.test(c))
              for (let k = 0; k < c.length; k++) indices.push(n + k);
            n += c.length;
          }
          let offset = 0;
          const result: ItemGlyph[] = [];
          for (const member of found) {
            const clean = compact(member.text);
            if (!clean) continue;
            const charStart = indices[offset],
              charEnd = indices[offset + clean.length - 1] + 1;
            result.push({
              start: charStart,
              end: charEnd,
              x: member.x,
              endX: member.endX,
            });
            offset += clean.length;
          }
          candidates.push(result);
          break;
        }
      }
    }
    if (candidates.length !== 1)
      throw new Error(`第 ${page.pageNumber} 页公式逐字形定位无法唯一证明`);
    return candidates[0];
  };
}
