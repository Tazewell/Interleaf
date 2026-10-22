import type { PDFFont } from "pdf-lib";
import type {
  NativePDFBounds,
  NativePDFFormula,
} from "../../../../packages/reader-core/src/bilingual-pdf";
import { validateFormulaTokens } from "./formula";
import { textInkMetrics } from "./runtime";

interface ParagraphBox {
  id: string;
  page: number;
  bounds: NativePDFBounds;
  fontSize: number;
  formulas: NativePDFFormula[];
}
export interface PositionedRun {
  kind: "text" | "formula";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  ascent: number;
}
/** Greedy measured wrap: Latin words stay intact unless wider than the column. */
export function fitParagraph(p: ParagraphBox, target: string, font: PDFFont) {
  validateFormulaTokens(target, p.formulas);
  if (!target.trim() || target.length > 200_000)
    throw new Error(`第 ${p.page} 页段落 ${p.id} 译文为空或过长`);
  const supported = new Set(font.getCharacterSet());
  for (const c of target.replace(/\{v\d+\}/g, ""))
    if (!/\s/u.test(c) && !supported.has(c.codePointAt(0)!))
      throw new Error(
        `第 ${p.page} 页段落 ${p.id} 字体缺字 U+${c.codePointAt(0)!.toString(16)}`,
      );
  const tokens =
    target.match(
      /\{v\d+\}|\r\n|\n|[\t ]+|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^]/gu,
    ) ?? [];
  const initial = Math.max(9, Math.min(36, p.fontSize));
  for (
    let size = initial;
    size >= 9;
    size = size > 9 ? Math.max(9, size - 0.5) : 8.5
  ) {
    for (const leading of [1.4, 1.3, 1.2, 1.1, 1]) {
      const line = () => ({
        runs: [] as PositionedRun[],
        width: 0,
        height: size,
        ascent: 0,
        descent: 0,
      });
      const lines = [line()];
      let failed = false;
      const append = (
        text: string,
        kind: "text" | "formula",
        width: number,
        height: number,
      ) => {
        let line = lines.at(-1)!;
        if (line.width + width > p.bounds.width + 0.001 && line.runs.length) {
          line = { runs: [], width: 0, height: size, ascent: 0, descent: 0 };
          lines.push(line);
        }
        if (width > p.bounds.width + 0.001) {
          failed = true;
          return;
        }
        const ink =
          kind === "text"
            ? textInkMetrics(font, text, size)
            : { ascent: height, descent: 0 };
        line.runs.push({
          kind,
          text,
          x: p.bounds.x + line.width,
          y: 0,
          width,
          height: ink.ascent + ink.descent,
          ascent: ink.ascent,
        });
        line.width += width;
        line.ascent = Math.max(line.ascent, ink.ascent);
        line.descent = Math.max(line.descent, ink.descent);
        line.height = Math.max(line.height, line.ascent + line.descent);
      };
      for (let token of tokens) {
        if (/^\r?\n$/.test(token)) {
          lines.push(line());
          continue;
        }
        const formula = p.formulas.find((f) => f.token === token);
        if (formula) {
          append(token, "formula", formula.bounds.width, formula.bounds.height);
          continue;
        }
        token = token.replace(/\t/g, "    ");
        const width = font.widthOfTextAtSize(token, size);
        if (width > p.bounds.width && token.length > 1)
          for (const c of token)
            append(c, "text", font.widthOfTextAtSize(c, size), size);
        else append(token, "text", width, size);
      }
      let y = p.bounds.y;
      for (const line of lines) {
        for (const run of line.runs) run.y = y + line.ascent - run.ascent;
        y += line.height * leading;
      }
      const last = lines.at(-1)!;
      const height =
        y - p.bounds.y - last.height * leading + last.ascent + last.descent;
      if (!failed && height <= p.bounds.height + 0.001)
        return {
          fontSize: size,
          lineHeight: leading,
          runs: lines.flatMap((l) => l.runs),
        };
    }
  }
  throw new Error(`第 ${p.page} 页段落 ${p.id} 排版溢出（最小字号 9 pt）`);
}
