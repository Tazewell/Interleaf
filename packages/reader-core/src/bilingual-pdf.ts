export interface BilingualPDFOptions {
  layout: "side-by-side" | "alternating";
  fromPage?: number;
  toPage?: number;
  translateMissing?: boolean;
  keepOriginalPages?: number[];
}
/** Physical points in the PDF.js visible, rotated, top-left coordinate system. */
export interface NativePDFBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface NativePDFFormula {
  token: string;
  bounds: NativePDFBounds;
}
export interface NativePDFParagraph {
  id: string;
  blockId: string;
  page: number;
  source: string;
  originalSource: string;
  sourceHash: string;
  bounds: NativePDFBounds;
  fontSize: number;
  formulas: NativePDFFormula[];
}
export interface NativePDFPage {
  page: number;
  width: number;
  height: number;
  rotation: number;
  cropBox: [number, number, number, number];
  paragraphs: NativePDFParagraph[];
}
export interface NativePDFPrepared {
  version: 1;
  originalSha256: string;
  /** SHA256 of the exact layout-manifest bytes; not a reading-translation hash. */
  revision: string;
  totalPages: number;
  pages: NativePDFPage[];
  noTextPages: number[];
  warnings: string[];
}

export interface BilingualPDFPreflight {
  pages: number;
  outputPages: number;
  missingParagraphs: number;
  noTextPages: number[];
  apiConfigured: boolean;
  warnings: string[];
}
export interface BilingualPDFStart {
  translateMissing: boolean;
  keepOriginalPages: number[];
}
/** In-memory export; cancellation, deletion, restart or 30 minutes removes it. */
export interface BilingualPDFJob {
  id: string;
  status:
    | "preparing"
    | "awaiting-confirmation"
    | "translating"
    | "running"
    | "ready"
    | "failed";
  stage: "prepare" | "translating" | "layout" | "composing" | "ready";
  done: number;
  total: number;
  preflight?: BilingualPDFPreflight;
  error?: string;
}
