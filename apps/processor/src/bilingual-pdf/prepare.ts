import type {
  NativePDFBounds,
  NativePDFPrepared,
  NativePDFPage,
} from "../../../../packages/reader-core/src/bilingual-pdf";
import { pdfFontAscent } from "../../../../packages/reader-core/src/pdf-text";
import { openPDF, printRaster, readLimited, sha256 } from "./runtime";
import {
  protectFormulas,
  readingSpans,
  unionBounds,
  type SourceSpan,
} from "./formula";
import { locateCaption } from "./caption";

interface Block {
  id: string;
  page: number;
  label: string;
  bounds: NativePDFBounds;
  groupIds?: string[];
  caption?: string;
  sourceAssetId?: string;
  captionMembers?: SourceSpan[];
}
interface Manifest {
  schemaVersion: number;
  inputSHA256: string;
  pages: number;
  blocks: Block[];
}
const translatable = new Set([
  "abstract",
  "aside_text",
  "content",
  "doc_title",
  "figure_title",
  "footnote",
  "paragraph_title",
  "text",
]);
export function overlap(a: NativePDFBounds, b: NativePDFBounds) {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}
export function checkBounds(b: NativePDFBounds, width: number, height: number) {
  if (
    !b ||
    ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
    b.x < 0 ||
    b.y < 0 ||
    b.width <= 0 ||
    b.height <= 0 ||
    b.x + b.width > width + 0.01 ||
    b.y + b.height > height + 0.01
  )
    throw new Error("页面区域几何无效");
}
export async function prepareNativePDF({
  input,
  layout,
  fromPage,
  toPage,
}: {
  input: string;
  layout: string;
  fromPage?: number;
  toPage?: number;
}): Promise<NativePDFPrepared> {
  const [bytes, manifestBytes] = await Promise.all([
    readLimited(input, 512 * 1024 * 1024),
    readLimited(layout),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  const originalSha256 = sha256(bytes);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.inputSHA256 !== originalSha256 ||
    !Array.isArray(manifest.blocks) ||
    manifest.blocks.length > 100_000
  )
    throw new Error("版面清单与原文不匹配或格式无效");
  const ids = new Set<string>();
  for (const block of manifest.blocks) {
    if (
      !block ||
      typeof block.id !== "string" ||
      !/^[\w.-]{1,200}$/.test(block.id) ||
      ids.has(block.id) ||
      !Number.isInteger(block.page) ||
      block.page < 1 ||
      block.page > manifest.pages ||
      typeof block.label !== "string"
    )
      throw new Error("版面区域标识或页码无效");
    ids.add(block.id);
    checkBounds(block.bounds, 1, 1);
  }
  const task = await openPDF(bytes);
  try {
    const pdf = await task.promise;
    const first = fromPage ?? 1,
      last = toPage ?? pdf.numPages;
    if (pdf.isPureXfa || manifest.pages !== pdf.numPages)
      throw new Error("PDF 页数或格式与版面不匹配");
    if (
      ![first, last].every(Number.isInteger) ||
      first < 1 ||
      last < first ||
      last > pdf.numPages ||
      last - first >= 2000
    )
      throw new Error("页码范围无效或超过 2000 页");
    const prepared: NativePDFPrepared = {
      version: 1,
      originalSha256,
      revision: sha256(manifestBytes),
      totalPages: pdf.numPages,
      pages: [],
      noTextPages: [],
      warnings: [],
    };
    const { Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    for (let number = first; number <= last; number++) {
      const page = await pdf.getPage(number),
        viewport = page.getViewport({ scale: 1 });
      const result: NativePDFPage = {
        page: number,
        width: viewport.width,
        height: viewport.height,
        rotation: page.rotate,
        cropBox: [...page.view] as NativePDFPage["cropBox"],
        paragraphs: [],
      };
      if (
        ![result.width, result.height].every(
          (n) => Number.isFinite(n) && n > 0 && n <= 14400,
        )
      )
        throw new Error(`第 ${number} 页尺寸无效或过大`);
      const blocks = manifest.blocks
        .filter((b) => b.page === number)
        .map((b) => ({
          ...b,
          bounds: {
            x: b.bounds.x * result.width,
            y: b.bounds.y * result.height,
            width: b.bounds.width * result.width,
            height: b.bounds.height * result.height,
          },
        }));
      const content = await page.getTextContent();
      const operators = await page.getOperatorList({ annotationMode: 0 });
      const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const fontWidths = new Map<string, Map<string, number>>();
      let currentFont = "";
      for (let i = 0; i < operators.fnArray.length; i++) {
        if (operators.fnArray[i] === OPS.setFont)
          currentFont = operators.argsArray[i][0];
        if (operators.fnArray[i] !== OPS.showText || !currentFont) continue;
        let widths = fontWidths.get(currentFont);
        if (!widths) {
          widths = new Map();
          fontWidths.set(currentFont, widths);
        }
        for (const glyph of operators.argsArray[i][0])
          if (
            glyph &&
            typeof glyph === "object" &&
            typeof glyph.unicode === "string" &&
            Number.isFinite(glyph.width)
          )
            widths.set(glyph.unicode, glyph.width);
      }
      const spans: SourceSpan[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const t = Util.transform(viewport.transform, item.transform);
        const size = Math.hypot(t[2], t[3]);
        // Sideways/vertical writing is protected; do not destroy it to force a horizontal translation.
        if (
          Math.abs(t[1]) > Math.abs(t[0]) * 0.02 ||
          t[0] <= 0 ||
          item.dir === "ttb"
        )
          continue;
        const style = content.styles[item.fontName],
          ascent = pdfFontAscent(style);
        const descent =
          typeof style?.descent === "number" &&
          Number.isFinite(style.descent) &&
          style.descent < 0
            ? -style.descent
            : Math.max(0, 1 - ascent);
        const bounds = {
          x: t[4],
          y: t[5] - size * ascent,
          width: Math.abs(item.width * page.userUnit),
          height: size * (ascent + descent),
        };
        if (bounds.width <= 0 || bounds.height <= 0) continue;
        const fontObject = page.commonObjs.get(item.fontName) as {
          name?: string;
        };
        const family =
          (content.styles[item.fontName]?.fontFamily ?? "") +
          " " +
          (fontObject?.name ?? "");
        const explicit = blocks.some(
          (b) =>
            b.label === "inline_formula" &&
            overlap(bounds, b.bounds) / (bounds.width * bounds.height) > 0.5,
        );
        const mathFont =
          /math|symbol|cmmi|cmsy|cmex|msam|msbm/i.test(family) ||
          (/italic|oblique/i.test(family) && /^[a-zA-Z]$/.test(item.str));
        const matches = [
          ...item.str.matchAll(
            /[A-Za-z0-9α-ωΑ-Ω]+(?:[._^][A-Za-z0-9α-ωΑ-Ω]+)*\s*[=≤≥≠±×÷+*/−]\s*[A-Za-z0-9α-ωΑ-Ω]+(?:[._^][A-Za-z0-9α-ωΑ-Ω]+)*(?:\s*[+*/−-]\s*[A-Za-z0-9α-ωΑ-Ω]+)*|\S*[=∑∫√∞≤≥≠±×÷∂∇∈∉∀∃α-ωΑ-Ω⁰-⁹₀-₉]\S*/gu,
          ),
        ];
        if (explicit || mathFont || !matches.length) {
          spans.push({
            text: item.str,
            bounds,
            fontSize: size,
            math: explicit || mathFont,
          });
        } else {
          // PDF.js may combine body + inline math into one TextItem. Use actual
          // glyph advances from its operator list to split without proportional
          // character guesses that could crop neighboring Latin text.
          const widths = fontWidths.get(item.fontName);
          const advance = (s: string) =>
            [...s].reduce((sum, c) => {
              const width = widths?.get(c);
              if (width === undefined && !/\s/u.test(c))
                throw new Error(`第 ${number} 页公式字形宽度不可确定`);
              return sum + (width ?? widths?.get(" ") ?? 250);
            }, 0);
          const total = advance(item.str);
          const split = (start: number, end: number, math: boolean) => {
            if (end <= start) return;
            const text = item.str.slice(start, end),
              left = (advance(item.str.slice(0, start)) / total) * bounds.width;
            spans.push({
              text,
              fontSize: size,
              math,
              bounds: {
                ...bounds,
                x: bounds.x + left,
                width: (advance(text) / total) * bounds.width,
              },
            });
          };
          let cursor = 0;
          for (const m of matches) {
            split(cursor, m.index, false);
            split(m.index, m.index + m[0].length, true);
            cursor = m.index + m[0].length;
          }
          split(cursor, item.str.length, false);
        }
      }
      for (const region of blocks.filter((b) => b.label === "inline_formula")) {
        const members = spans.filter(
          (s) =>
            overlap(s.bounds, region.bounds) /
              (s.bounds.width * s.bounds.height) >
            0.5,
        );
        const text =
          readingSpans(members)
            .map((s) => s.text)
            .join(" ") || "\uFFFC";
        for (const s of members) spans.splice(spans.indexOf(s), 1);
        spans.push({
          text,
          bounds: { ...region.bounds },
          fontSize: members.length
            ? Math.max(...members.map((s) => s.fontSize))
            : region.bounds.height,
          math: true,
        });
      }
      for (const asset of [...blocks]) {
        if (
          !["image", "chart", "table"].includes(asset.label) ||
          asset.caption === undefined
        )
          continue;
        if (
          typeof asset.caption !== "string" ||
          !asset.caption.trim() ||
          asset.caption.length > 200_000
        )
          throw new Error(`第 ${number} 页图题数据无效`);
        const found = locateCaption(
          asset.caption,
          spans.filter(
            (s) =>
              overlap(s.bounds, asset.bounds) /
                (s.bounds.width * s.bounds.height) >
              0.5,
          ),
          number,
          asset.id,
        );
        if (
          spans.some(
            (s) =>
              !found.members.includes(s) &&
              overlap(s.bounds, found.bounds) > 0.5,
          )
        )
          throw new Error(
            `第 ${number} 页图题 ${asset.id} 与图内文字重叠，无法安全定位`,
          );
        blocks.push({
          id: asset.id + ".caption",
          page: number,
          label: "figure_title",
          bounds: found.bounds,
          sourceAssetId: asset.id,
          caption: asset.caption,
          captionMembers: found.members,
        });
      }
      // Detector boxes may clip a source em/raised glyph. Include source extent
      // before grouping/checking, so adjacent footnotes are one export paragraph
      // rather than destructive overlapping erasures. The reading layout is untouched.
      for (const b of blocks.filter((b) => translatable.has(b.label))) {
        const owned = spans.filter(
          (s) =>
            overlap(s.bounds, b.bounds) / (s.bounds.width * s.bounds.height) >
            0.5,
        );
        for (const s of owned) b.bounds = unionBounds(b.bounds, s.bounds);
      }
      for (let i = 0; i < blocks.length; i++) {
        const a = blocks[i];
        if (a.label !== "footnote") continue;
        for (let j = i + 1; j < blocks.length; j++) {
          const b = blocks[j];
          if (b.label !== "footnote" || overlap(a.bounds, b.bounds) <= 0)
            continue;
          const shared =
            Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) -
            Math.max(a.bounds.x, b.bounds.x);
          if (
            shared / Math.min(a.bounds.width, b.bounds.width) < 0.65 ||
            Math.abs(a.bounds.x - b.bounds.x) > result.width * 0.15
          )
            continue;
          a.groupIds = [...(a.groupIds ?? [a.id]), ...(b.groupIds ?? [b.id])];
          a.bounds = unionBounds(a.bounds, b.bounds);
          blocks.splice(j, 1);
          j = i;
        }
      }
      const candidates = blocks.filter((b) => translatable.has(b.label));
      const assigned = new Set<SourceSpan>();
      for (const block of candidates) {
        const owned =
          block.captionMembers ??
          readingSpans(
            spans.filter(
              (s) =>
                overlap(s.bounds, block.bounds) /
                  (s.bounds.width * s.bounds.height) >
                0.5,
            ),
          );
        if (!owned.length) continue;
        // A detector's margin is not a glyph clipping boundary. Include the
        // original owned text, then prove that its extent is disjoint below.
        for (const s of owned)
          block.bounds = unionBounds(block.bounds, s.bounds);
        block.bounds.x = Math.max(0, block.bounds.x);
        block.bounds.y = Math.max(0, block.bounds.y);
        block.bounds.width = Math.min(
          result.width - block.bounds.x,
          block.bounds.width,
        );
        block.bounds.height = Math.min(
          result.height - block.bounds.y,
          block.bounds.height,
        );
        for (const other of blocks) {
          if (
            other.id === block.id ||
            other.id === block.sourceAssetId ||
            other.label === "inline_formula" ||
            overlap(block.bounds, other.bounds) <= 0.5
          )
            continue;
          const a = block.bounds,
            b = other.bounds;
          const strip = {
            x: Math.max(a.x, b.x),
            y: Math.max(a.y, b.y),
            width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
            height:
              Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
          };
          const margin = Math.max(2, ...owned.map((s) => s.fontSize * 0.6));
          let empty = !spans.some((s) => overlap(s.bounds, strip) > 0.01);
          if (!empty && (strip.width <= margin || strip.height <= margin)) {
            const { canvas, scale } = await printRaster(page);
            try {
              const x = Math.floor(strip.x * scale),
                y = Math.floor(strip.y * scale);
              const pixels = canvas
                .getContext("2d")
                .getImageData(
                  x,
                  y,
                  Math.max(1, Math.ceil((strip.x + strip.width) * scale) - x),
                  Math.max(1, Math.ceil((strip.y + strip.height) * scale) - y),
                ).data;
              empty = pixels.every((v, i) => i % 4 === 3 || v >= 250);
            } finally {
              canvas.width = canvas.height = 1;
            }
          }
          // Detection boxes sometimes share a sub-point blank margin. Remove it
          // only with glyph evidence, never by ignoring a small overlap area.
          if (
            empty &&
            strip.height <= margin &&
            strip.height < a.height * 0.2
          ) {
            if (a.y < b.y) a.height = b.y - a.y;
            else {
              const bottom = a.y + a.height;
              a.y = b.y + b.height;
              a.height = bottom - a.y;
            }
          } else if (
            empty &&
            strip.width <= margin &&
            strip.width < a.width * 0.2
          ) {
            if (a.x < b.x) a.width = b.x - a.x;
            else {
              const right = a.x + a.width;
              a.x = b.x + b.width;
              a.width = right - a.x;
            }
          } else
            throw new Error(
              `第 ${number} 页区域 ${block.id} 与 ${other.id} 重叠，无法安全擦除`,
            );
        }
        if (owned.some((s) => assigned.has(s)))
          throw new Error(`第 ${number} 页段落重复归属`);
        owned.forEach((s) => assigned.add(s));
        for (const s of owned) {
          const b = s.bounds,
            a = block.bounds,
            x = Math.max(a.x, b.x),
            y = Math.max(a.y, b.y);
          s.bounds = {
            x,
            y,
            width: Math.min(a.x + a.width, b.x + b.width) - x,
            height: Math.min(a.y + a.height, b.y + b.height) - y,
          };
          if (s.bounds.width <= 0 || s.bounds.height <= 0)
            throw new Error(`第 ${number} 页段落边缘无法安全裁剪`);
        }
        const sizes = owned
          .filter((s) => !s.math)
          .map((s) => s.fontSize)
          .sort((a, b) => a - b);
        const size = sizes.length
          ? sizes[Math.floor(sizes.length / 2)]
          : owned[0].fontSize;
        // Tiny raised/lowered source glyphs remain original formula pixels.
        for (const s of owned) if (s.fontSize < size * 0.78) s.math = true;
        for (let pass = 0; pass < owned.length; pass++) {
          let changed = false;
          for (let j = 0; j < owned.length; j++) {
            const s = owned[j];
            if (s.math || !/^[\s\d().,:+*/^_=<>±−-]+$/.test(s.text)) continue;
            if (
              [owned[j - 1], owned[j + 1]].some(
                (n) =>
                  n?.math &&
                  Math.abs(n.bounds.y - s.bounds.y) <
                    Math.max(n.fontSize, s.fontSize) * 0.7 &&
                  Math.max(
                    s.bounds.x - n.bounds.x - n.bounds.width,
                    n.bounds.x - s.bounds.x - s.bounds.width,
                  ) <
                    Math.max(n.fontSize, s.fontSize) * 0.7,
              )
            ) {
              s.math = true;
              changed = true;
            }
          }
          if (!changed) break;
        }
        const protectedText = protectFormulas(owned);
        if (block.sourceAssetId) protectedText.originalSource = block.caption!;
        if (!protectedText.source.replace(/\{v\d+\}/g, "").trim()) continue;
        for (const f of protectedText.formulas)
          checkBounds(f.bounds, result.width, result.height);
        const id = `p${number}.${block.id}${block.groupIds ? ".g" + sha256(block.groupIds.join("\0")).slice(0, 12) : ""}`;
        const sourceHash = sha256(
          JSON.stringify([
            "reader-native-pdf-v1",
            id,
            protectedText.source,
            block.bounds,
            protectedText.formulas,
          ]),
        );
        result.paragraphs.push({
          id,
          blockId: block.sourceAssetId ?? block.id,
          page: number,
          ...protectedText,
          sourceHash,
          bounds: block.bounds,
          fontSize: Math.max(9, size),
        });
      }
      if (!result.paragraphs.length) {
        prepared.noTextPages.push(number);
        prepared.warnings.push(
          `第 ${number} 页无可安全翻译的横排文字，需明确保留原文`,
        );
      } else if (
        spans.some(
          (s) =>
            !assigned.has(s) &&
            !blocks.some(
              (b) =>
                !translatable.has(b.label) && overlap(b.bounds, s.bounds) > 0,
            ),
        )
      )
        prepared.warnings.push(`第 ${number} 页未归属版面的文字按原图保留`);
      prepared.pages.push(result);
      page.cleanup();
    }
    return prepared;
  } finally {
    await task.destroy();
  }
}
