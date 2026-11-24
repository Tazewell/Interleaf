import type { NativePDFBounds } from "./bilingual-pdf";

export type NativePDFReadingEngine = "babeldoc";

export type NativePDFReadingLayout = "side-by-side" | "translation-only";

/** Geometry and identity of one paragraph in the derived PDF, never a new translation. */
export interface NativePDFReadingParagraph {
  id: string;
  blockId: string;
  /** Existing reading translation identity: SHA256("zh-CN:v1:" + originalSource). */
  sourceHash: string;
  bounds: NativePDFBounds;
  translated: boolean;
  /** Exact existing reading target used by the renderer; absent for retained original ink. */
  target?: string;
}
export interface NativePDFReadingPage {
  /** Original one-based page; the combined PDF keeps the same page count. */
  page: number;
  width: number;
  height: number;
  outputWidth: number;
  translationOffsetX: number;
  paragraphs: NativePDFReadingParagraph[];
}
export interface NativePDFReadingReport {
  pages: NativePDFReadingPage[];
  translatedParagraphs: number;
  originalParagraphs: number;
  warnings: string[];
}
export interface NativePDFReadingManifest extends NativePDFReadingReport {
  /** Omitted for the Interleaf renderer. */
  engine?: NativePDFReadingEngine;
  /** Omitted by historical manifests; defaults to side-by-side. */
  layout?: NativePDFReadingLayout;
  version: 1;
  documentId: string;
  cacheKey: string;
  originalSha256: string;
  layoutRevision: string;
  translationRevision: string;
  rendererVersion: string;
  pdfSha256: string;
  pdfBytes: number;
}
export interface NativePDFReadingJob {
  id: string;
  cacheKey: string;
  status: "preparing" | "running" | "ready" | "failed";
  stage: "prepare" | "layout" | "composing" | "ready";
  done: number;
  total: number;
  error?: string;
  metadata?: NativePDFReadingManifest;
}
