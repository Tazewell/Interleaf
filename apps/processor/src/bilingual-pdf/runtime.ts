import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont } from "pdf-lib";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const fontFaces = new WeakMap<PDFFont, ReturnType<typeof fontkit.create>>();
export function textInkMetrics(font: PDFFont, text: string, size: number) {
  const face = fontFaces.get(font);
  if (!face) throw new Error("必须使用已校验的内置字体排版");
  if (!text.trim()) return { ascent: 0, descent: 0 };
  const run = face.layout(text);
  let top = 0,
    bottom = 0;
  for (let i = 0; i < run.glyphs.length; i++) {
    const b = run.glyphs[i].bbox,
      offset = run.positions[i]?.yOffset ?? 0;
    if (Number.isFinite(b.maxY)) top = Math.max(top, b.maxY + offset);
    if (Number.isFinite(b.minY)) bottom = Math.min(bottom, b.minY + offset);
  }
  return {
    ascent: (top * size) / face.unitsPerEm,
    descent: (-bottom * size) / face.unitsPerEm,
  };
}
export async function readLimited(path: string, limit = 64 * 1024 * 1024) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit)
    throw new Error("文件类型或大小无效");
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error("文件超过大小限制");
  return bytes;
}
export async function openPDF(input: string | Uint8Array) {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
  );
  const data =
    typeof input === "string"
      ? await readLimited(input, 512 * 1024 * 1024)
      : input;
  return getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    cMapUrl: join(assets, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(assets, "standard_fonts") + "/",
    wasmUrl: join(assets, "wasm") + "/",
    verbosity: 0,
  });
}
export async function loadFont(doc: PDFDocument) {
  const base = dirname(fileURLToPath(import.meta.url));
  // esbuild flattens the CLI/chunks into dist; source modules live in src/bilingual-pdf.
  const path = base.endsWith("bilingual-pdf")
    ? resolve(base, "../../fonts/NotoSansSC.ttf")
    : join(base, "fonts/NotoSansSC.ttf");
  const bytes = await readLimited(path, 20 * 1024 * 1024);
  const blob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (blob !== "fb0637bafbcd804fe32152370a1225990745b4bc")
    throw new Error("内置字体校验失败");
  // The pinned file is variable. Instantiate regular weight before subsetting.
  const face = fontkit.create(new Uint8Array(bytes)) as ReturnType<
    typeof fontkit.create
  > & {
    getVariation?: (
      axes: Record<string, number>,
    ) => ReturnType<typeof fontkit.create>;
  };
  if (!face.getVariation) throw new Error("字体不支持 wght=400 实例化");
  const regular = face.getVariation({ wght: 400 });
  doc.registerFontkit({ create: () => regular });
  const font = await doc.embedFont(new Uint8Array(bytes), {
    subset: true,
    customName: "RDRNSC+NotoSansSC-Regular",
  });
  fontFaces.set(font, regular);
  return { font, face: regular };
}
export async function printRaster(page: PDFPageProxy) {
  const scale = 300 / 72,
    viewport = page.getViewport({ scale }),
    width = Math.ceil(viewport.width),
    height = Math.ceil(viewport.height);
  if (width > 16384 || height > 16384 || width * height > 40_000_000)
    throw new Error(`第 ${page.pageNumber} 页 300 DPI 栅格超过内存/像素上限`);
  const canvas = createCanvas(width, height);
  try {
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
      background: "white",
      annotationMode: 0,
    }).promise;
    return { canvas, scale };
  } catch (error) {
    canvas.width = canvas.height = 1;
    throw error;
  }
}
/** Never expose a partial artifact or overwrite an input on failure. */
export async function atomicWrite(path: string, bytes: Uint8Array | string) {
  const temporary = join(dirname(path), `.bilingual-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
