export type DesktopImportResult = {
  name: string;
  status: "imported" | "existing" | "elsewhere" | "failed" | "large";
  documentId?: string;
  library?: "books" | "papers";
  message?: string;
  pages?: number;
  retryId?: string;
};
