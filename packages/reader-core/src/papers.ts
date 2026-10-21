import type { PaperMetadata } from "./index";

export type PaperAttachmentRole =
  "original" | "translation" | "supplement" | "other";
export interface PaperAttachment {
  documentId: string;
  role: PaperAttachmentRole;
  title: string;
  type: "pdf" | "epub";
  size: number;
}
export interface PaperItem {
  id: string;
  title: string;
  author: string;
  metadata: PaperMetadata;
  tags: string[];
  folders: string[];
  favorite: boolean;
  createdAt: string;
  deletedAt?: string;
  primaryDocumentId: string;
  citationKey: string;
  attachments: PaperAttachment[];
}

export type BibliographyMode = "bibtex" | "biblatex";
export interface BibliographyExport {
  id: string;
  folder: string;
  includeChildren: boolean;
  mode: BibliographyMode;
  path: string;
  lastExportedAt?: string;
  error?: string;
  paused: boolean;
}
export interface BibliographyPreview {
  entries: {
    index: number;
    key: string;
    title: string;
    matchedId?: string;
    warnings: string[];
  }[];
  errors?: string[];
}
export interface BibliographyDecision {
  index: number;
  action: "create" | "merge" | "skip";
  paperId?: string;
  citationKey?: string;
}
export type PaperPatch = Partial<
  Pick<
    PaperItem,
    | "title"
    | "author"
    | "tags"
    | "folders"
    | "favorite"
    | "primaryDocumentId"
    | "citationKey"
  >
> & {
  metadata?: Partial<PaperMetadata>;
};
