import { createCanvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist";
import type { Box } from "./layout";

/** Exact PNG crop pixels, including the layout worker's three-pixel margin. */
export function blockCropBounds(
  bounds: Box,
  pageWidth: number,
  pageHeight: number,
) {
  const x = Math.max(0, Math.floor(bounds.x * pageWidth) - 3);
  const y = Math.max(0, Math.floor(bounds.y * pageHeight) - 3);
  return {
    x,
    y,
    width: Math.min(pageWidth - x, Math.ceil(bounds.width * pageWidth) + 6),
    height: Math.min(pageHeight - y, Math.ceil(bounds.height * pageHeight) + 6),
  };
}

/** Shared by layout analysis and visual reading; no layout model is required. */
export async function renderPage(page: PDFPageProxy) {
  const original = page.getViewport({ scale: 1 });
  const scale = Math.min(
    2,
    Math.sqrt(4_000_000 / (original.width * original.height)),
    16384 / Math.max(original.width, original.height),
  );
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: canvas.getContext(
      "2d",
    ) as unknown as CanvasRenderingContext2D,
    viewport,
    background: "white",
  }).promise;
  return { canvas, scale };
}
