import type { PaperMetadata } from "./index";

export type PaperAttachmentRole = "original" | "translation" | "supplement" | "other";
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
