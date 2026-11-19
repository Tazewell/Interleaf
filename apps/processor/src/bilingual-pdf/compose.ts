import { createCanvas } from "@napi-rs/canvas";
import {
  PDFDocument,
  PDFName,
  degrees,
  type PDFPage,
  type PDFEmbeddedPage,
} from "pdf-lib";
import { resolve } from "node:path";
import type {
  NativePDFPrepared,
  BilingualPDFOptions,
  NativePDFPage,
} from "../../../../packages/interleaf-core/src/bilingual-pdf";
import {
  atomicWrite,
  loadFont,
  openPDF,
  printRaster,
  readLimited,
  sha256,
} from "./runtime";
import { checkBounds, overlap } from "./prepare";
import { fitParagraph } from "./layout";
import { validateFormulaTokens } from "./formula";
import type { NativePDFReadingReport } from "../../../../packages/interleaf-core/src/native-pdf-reading";

export interface NativePDFProgress {
  stage: "layout" | "composing";
  done: number;
  total: number;
}
interface RenderOptions {
  input: string;
  prepared: NativePDFPrepared;
  targets: Record<string, string>;
  output: string;
  layout: BilingualPDFOptions["layout"] | "translation-only";
  keepOriginalPages?: number[];
  /** Reuse supplied reading targets, retaining original ink when they cannot fit. */
  reading?: boolean;
}
function drawOriginal(
  destination: PDFPage,
  embedded: PDFEmbeddedPage,
  p: NativePDFPage,
  unit: number,
  x = 0,
) {
  const rawWidth = (p.cropBox[2] - p.cropBox[0]) * unit,
    rawHeight = (p.cropBox[3] - p.cropBox[1]) * unit;
  const origins: Record<number, [number, number]> = {
    0: [0, 0],
    90: [0, rawWidth],
    180: [rawWidth, rawHeight],
    270: [rawHeight, 0],
  };
  const origin = origins[p.rotation];
  if (!origin) throw new Error(`第 ${p.page} 页旋转角度无效`);
  destination.drawPage(embedded, {
    x: x + origin[0],
    y: origin[1],
    xScale: unit,
    yScale: unit,
    rotate: degrees(-p.rotation),
  });
}
function validatePrepared(p: NativePDFPrepared, reading = false) {
  if (
    !p ||
    p.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(p.originalSha256) ||
    !/^[a-f0-9]{64}$/.test(p.revision) ||
    !Number.isInteger(p.totalPages) ||
    p.totalPages < 1 ||
    !Array.isArray(p.pages) ||
    !p.pages.length ||
    p.pages.length > 2000 ||
    !Array.isArray(p.noTextPages)
  )
    throw new Error("准备数据无效");
  const ids = new Set<string>(),
    pages = new Set<number>();
  for (const page of p.pages) {
    if (
      !Number.isInteger(page.page) ||
      page.page < 1 ||
      page.page > p.totalPages ||
      pages.has(page.page) ||
      ![page.width, page.height].every(
        (n) => Number.isFinite(n) && n > 0 && n <= 14400,
      ) ||
      ![0, 90, 180, 270].includes(page.rotation) ||
      !Array.isArray(page.cropBox) ||
      page.cropBox.length !== 4 ||
      !page.cropBox.every(Number.isFinite) ||
      !Array.isArray(page.paragraphs) ||
      page.paragraphs.length > 10000
    )
      throw new Error("准备页面几何无效");
    pages.add(page.page);
    for (const paragraph of page.paragraphs) {
      if (
        typeof paragraph.id !== "string" ||
        ids.has(paragraph.id) ||
        paragraph.page !== page.page ||
        typeof paragraph.source !== "string" ||
        typeof paragraph.originalSource !== "string" ||
        !Number.isFinite(paragraph.fontSize) ||
        paragraph.fontSize < 9 ||
        !Array.isArray(paragraph.formulas) ||
        paragraph.formulas.length > 10000
      )
        throw new Error("准备段落无效");
      if (paragraph.preserveOriginalReason !== undefined) {
        if (!reading)
          throw new Error("阅读准备段落需保留原文，不能用于严格导出");
        if (
          typeof paragraph.preserveOriginalReason !== "string" ||
          !paragraph.preserveOriginalReason.trim() ||
          paragraph.preserveOriginalReason.length > 1000 ||
          paragraph.formulas.length
        )
          throw new Error("准备段落保留原文信息无效");
      }
      ids.add(paragraph.id);
      checkBounds(paragraph.bounds, page.width, page.height);
      const expectedHash = sha256(
        JSON.stringify([
          paragraph.preserveOriginalReason === undefined
            ? "interleaf-native-pdf-v1"
            : "interleaf-native-pdf-reading-retained-v1",
          paragraph.id,
          paragraph.source,
          paragraph.bounds,
          paragraph.formulas,
          ...(paragraph.preserveOriginalReason === undefined
            ? []
            : [paragraph.preserveOriginalReason]),
        ]),
      );
      if (paragraph.sourceHash !== expectedHash)
        throw new Error("准备段落身份校验失败");
      validateFormulaTokens(paragraph.source, paragraph.formulas);
      for (const f of paragraph.formulas) {
        checkBounds(f.bounds, page.width, page.height);
        if (
          overlap(f.bounds, paragraph.bounds) <
          f.bounds.width * f.bounds.height * 0.98
        )
          throw new Error("公式超出段落，无法安全擦除");
      }
    }
    for (let i = 0; i < page.paragraphs.length; i++)
      for (let j = i + 1; j < page.paragraphs.length; j++)
        if (overlap(page.paragraphs[i].bounds, page.paragraphs[j].bounds) > 0.5)
          throw new Error(`第 ${page.page} 页段落区域重叠`);
  }
}
export async function renderNativePDF(
  options: RenderOptions,
  progress?: (event: NativePDFProgress) => void,
): Promise<NativePDFReadingReport> {
  const { input, prepared, targets, output, layout } = options;
  if (
    !["side-by-side", "alternating", "translation-only"].includes(layout) ||
    resolve(input) === resolve(output) ||
    (layout === "translation-only" && options.reading !== true) ||
    (options.reading && layout === "alternating")
  )
    throw new Error("输出模式或路径无效");
  validatePrepared(prepared, options.reading);
  if (!targets || typeof targets !== "object" || Array.isArray(targets))
    throw new Error("译文格式无效");
  const bytes = await readLimited(input, 512 * 1024 * 1024);
  if (sha256(bytes) !== prepared.originalSha256)
    throw new Error("原文身份校验失败");
  const keep = new Set(options.keepOriginalPages ?? []);
  if (
    [...keep].some(
      (n) => !Number.isInteger(n) || !prepared.pages.some((p) => p.page === n),
    )
  )
    throw new Error("保留原文页码无效");
  const paragraphIds = new Set(
    prepared.pages.flatMap((p) => p.paragraphs.map((v) => v.id)),
  );
  if (Object.keys(targets).some((id) => !paragraphIds.has(id)))
    throw new Error("译文段落不属于当前任务");
  if (options.reading)
    for (const target of Object.values(targets))
      if (typeof target !== "string") throw new Error("译文格式无效");
  for (const p of prepared.pages) {
    if (
      !keep.has(p.page) &&
      (!p.paragraphs.length || prepared.noTextPages.includes(p.page))
    )
      if (options.reading) keep.add(p.page);
      else throw new Error(`第 ${p.page} 页需明确保留原文`);
    if (!options.reading && !keep.has(p.page))
      for (const paragraph of p.paragraphs)
        if (typeof targets[paragraph.id] !== "string")
          throw new Error(`第 ${p.page} 页段落 ${paragraph.id} 缺少译文`);
  }
  const task = await openPDF(bytes);
  try {
    const pdf = await task.promise;
    if (pdf.numPages !== prepared.totalPages || pdf.isPureXfa)
      throw new Error("PDF 原文页数或格式无效");
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    // A Form XObject has page contents/resources only. Drop action/annotation edges
    // before PDF-LIB's object copier can traverse the source page dictionary.
    for (const p of source.getPages())
      for (const key of [
        "Annots",
        "AA",
        "A",
        "Metadata",
        "PieceInfo",
        "PresSteps",
        "B",
        "Dur",
        "Trans",
        "Parent",
      ])
        if (key !== "Parent") p.node.delete(PDFName.of(key));
    const result = await PDFDocument.create();
    const { font } = await loadFont(result);
    const fits = new Map<string, ReturnType<typeof fitParagraph>>();
    const report: NativePDFReadingReport = {
      pages: [],
      translatedParagraphs: 0,
      originalParagraphs: 0,
      warnings: options.reading ? [...prepared.warnings] : [],
    };
    for (let i = 0; i < prepared.pages.length; i++) {
      const p = prepared.pages[i];
      if (!keep.has(p.page))
        for (const paragraph of p.paragraphs) {
          if (paragraph.preserveOriginalReason !== undefined) {
            report.warnings.push(
              `${paragraph.preserveOriginalReason}，段落 ${paragraph.id} 保留原文`,
            );
            continue;
          }
          const target = targets[paragraph.id];
          if (options.reading && target === undefined) {
            report.warnings.push(
              `第 ${p.page} 页段落 ${paragraph.id} 缺少可用于原版式的译文，保留原文`,
            );
            continue;
          }
          try {
            // The report keeps the saved target verbatim for selection anchors.
            const plain = options.reading
              ? target.replace(/(?<![$\\])\$([A-Za-z])\$(?!\$)/g, "$1")
              : target;
            fits.set(
              paragraph.id,
              fitParagraph(paragraph, plain.includes("$") ? target : plain, font),
            );
          } catch (error) {
            if (!options.reading) throw error;
            report.warnings.push(
              `${error instanceof Error ? error.message : "段落排版失败"}，保留原文`,
            );
          }
        }
      report.pages.push({
        page: p.page,
        width: p.width,
        height: p.height,
        outputWidth: layout === "side-by-side" ? 2 * p.width + 12 : p.width,
        translationOffsetX: layout === "side-by-side" ? p.width + 12 : 0,
        paragraphs: p.paragraphs.map((paragraph) => {
          const translated = fits.has(paragraph.id);
          if (translated) report.translatedParagraphs++;
          else {
            report.originalParagraphs++;
            if (keep.has(p.page))
              report.warnings.push(
                `第 ${p.page} 页段落 ${paragraph.id} 保留原文`,
              );
          }
          return {
            id: paragraph.id,
            blockId: paragraph.blockId,
            sourceHash: sha256("zh-CN:v1:" + paragraph.originalSource),
            bounds: paragraph.bounds,
            translated,
            ...(translated ? { target: targets[paragraph.id] } : {}),
          };
        }),
      });
      progress?.({
        stage: "layout",
        done: i + 1,
        total: prepared.pages.length,
      });
    }
    for (let i = 0; i < prepared.pages.length; i++) {
      const p = prepared.pages[i],
        actual = await pdf.getPage(p.page),
        viewport = actual.getViewport({ scale: 1 });
      if (
        Math.abs(viewport.width - p.width) > 0.001 ||
        Math.abs(viewport.height - p.height) > 0.001 ||
        actual.rotate !== p.rotation ||
        actual.view.some((v, j) => Math.abs(v - p.cropBox[j]) > 0.001)
      )
        throw new Error(`第 ${p.page} 页几何与原文不符`);
      const wide = layout === "side-by-side";
      const page = result.addPage([
        wide ? 2 * p.width + 12 : p.width,
        p.height,
      ]);
      const translated =
        layout === "alternating" ? result.addPage([p.width, p.height]) : page;
      const offset = wide ? p.width + 12 : 0;
      const retainPage =
        keep.has(p.page) ||
        (options.reading && !p.paragraphs.some((v) => fits.has(v.id)));
      if (layout !== "translation-only" || retainPage) {
        const raw = source.getPage(p.page - 1);
        // PDF-lib needs a content stream even when the original page is blank.
        if (!raw.node.Contents()) raw.drawText("");
        const embedded = await result.embedPage(raw, {
          left: p.cropBox[0],
          bottom: p.cropBox[1],
          right: p.cropBox[2],
          top: p.cropBox[3],
        });
        if (layout !== "translation-only")
          drawOriginal(page, embedded, p, actual.userUnit);
        if (retainPage)
          drawOriginal(translated, embedded, p, actual.userUnit, offset);
      }
      if (!retainPage) {
        const { canvas, scale } = await printRaster(actual),
          context = canvas.getContext("2d");
        try {
          const formulas = new Map<
            string,
            { bytes: Buffer; width: number; height: number }
          >();
          for (const paragraph of p.paragraphs)
            if (fits.has(paragraph.id))
              for (const f of paragraph.formulas) {
                const w = Math.ceil(f.bounds.width * scale),
                  h = Math.ceil(f.bounds.height * scale);
                const crop = createCanvas(w, h);
                crop
                  .getContext("2d")
                  .drawImage(
                    canvas,
                    f.bounds.x * scale,
                    f.bounds.y * scale,
                    f.bounds.width * scale,
                    f.bounds.height * scale,
                    0,
                    0,
                    w,
                    h,
                  );
                formulas.set(`${paragraph.id}:${f.token}`, {
                  bytes: crop.toBuffer("image/png"),
                  width: f.bounds.width,
                  height: f.bounds.height,
                });
                crop.width = crop.height = 1;
              }
          context.fillStyle = "white";
          for (const paragraph of p.paragraphs) {
            if (!fits.has(paragraph.id)) continue;
            const b = paragraph.bounds;
            context.fillRect(
              Math.floor(b.x * scale),
              Math.floor(b.y * scale),
              Math.ceil((b.x + b.width) * scale) - Math.floor(b.x * scale),
              Math.ceil((b.y + b.height) * scale) - Math.floor(b.y * scale),
            );
          }
          const background = await result.embedPng(
            canvas.toBuffer("image/png"),
          );
          // PDF-LIB retains decoded RGB until PDFImage.embed(), even after the
          // Canvas is released. Embed only images here; flush() would repeatedly
          // freeze/rebuild the still evolving font subset.
          await background.embed();
          translated.drawImage(background, {
            x: offset,
            y: p.height - canvas.height / scale,
            width: canvas.width / scale,
            height: canvas.height / scale,
          });
          for (const paragraph of p.paragraphs) {
            const fit = fits.get(paragraph.id);
            if (!fit) continue;
            for (const run of fit.runs) {
              if (run.kind === "text")
                translated.drawText(run.text, {
                  font,
                  size: fit.fontSize,
                  x: offset + run.x,
                  y: p.height - run.y - run.ascent,
                });
              else {
                const crop = formulas.get(`${paragraph.id}:${run.text}`)!;
                const image = await result.embedPng(crop.bytes);
                await image.embed();
                translated.drawImage(image, {
                  x: offset + run.x,
                  y: p.height - run.y - run.height,
                  width: crop.width,
                  height: crop.height,
                });
              }
            }
          }
        } finally {
          canvas.width = canvas.height = 1;
        }
      }
      actual.cleanup();
      progress?.({
        stage: "composing",
        done: i + 1,
        total: prepared.pages.length,
      });
    }
    await atomicWrite(output, await result.save());
    return report;
  } finally {
    await task.destroy();
  }
}
