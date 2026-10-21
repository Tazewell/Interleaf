import type { Document, PaperItem } from "@reader/core";
/** Display rows keep a real primary file ID, with a guarded synthetic ID only for empty items. */
export function projectPapers(
  items: PaperItem[],
  documents: Document[],
): Document[] {
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  return items.map((item) => {
    const files = item.attachments.flatMap((a) =>
      byId.has(a.documentId) ? [byId.get(a.documentId)!] : [],
    );
    const primary =
      files.find((d) => d.id === item.primaryDocumentId) || files[0];
    return {
      ...(primary || {
        category: "paper" as const,
        categorySource: "manual" as const,
        classificationStatus: "done" as const,
        classificationError: "",
        type: "pdf" as const,
        size: 0,
        lastOpenedAt: "",
        percentage: 0,
        readingStatus: "unread" as const,
        related: [],
      }),
      ...item,
      id: primary?.id || `paper:${item.id}`,
      paperId: item.id,
      library: "papers",
      metadataOnly: !primary,
      noteCount: files.reduce((n, d) => n + d.noteCount, 0),
      highlightCount: files.reduce((n, d) => n + d.highlightCount, 0),
      openQuestionCount: files.reduce((n, d) => n + d.openQuestionCount, 0),
    };
  });
}
export function libraryPapers(
  items: PaperItem[] | null,
  documents: Document[],
) {
  return items === null
    ? documents.filter((d) => d.library === "papers")
    : projectPapers(items, documents);
}
