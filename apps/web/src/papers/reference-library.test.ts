import { beforeEach, expect, it, vi } from "vitest";
import { api } from "@interleaf/api";
import type { PaperItem } from "@interleaf/core";
import { paper } from "./fixtures";
import { projectPapers } from "./projection";
import { patchPapers } from "./actions";
import { formatCitations } from "./citation";
import { useReaderStore } from "../store";
import { removeLibraryDocuments } from "../library-actions";
vi.mock("@interleaf/api", () => ({
  api: {
    update: vi.fn(),
    updatePaper: vi.fn(),
    documents: vi.fn(async () => []),
    papers: vi.fn(async () => []),
    exportBibliography: vi.fn(async () => ({ text: "@misc{stable}" })),
    ensureCitationKeys: vi.fn(async () => [
      { id: "item", citationKey: "stable" },
    ]),
    trashPaper: vi.fn(),
    trash: vi.fn(async () => []),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
export const item = (patch: Partial<PaperItem> = {}): PaperItem => ({
  id: "item",
  title: "Metadata paper",
  author: "Author",
  metadata: {},
  tags: [],
  folders: [],
  favorite: false,
  createdAt: "2026-10-21",
  primaryDocumentId: "",
  citationKey: "stable",
  attachments: [],
  ...patch,
});
beforeEach(() => {
  vi.clearAllMocks();
  useReaderStore.setState({ documents: [], paperItems: [] });
});
it("projects one item while retaining primary progress and summing attachment counts", () => {
  const a = paper({ id: "a", percentage: 0.2, noteCount: 2 });
  const b = paper({
    id: "b",
    percentage: 0.9,
    noteCount: 3,
    highlightCount: 4,
  });
  const [row] = projectPapers(
    [
      item({
        primaryDocumentId: "a",
        attachments: [a, b].map((d) => ({
          documentId: d.id,
          title: d.title,
          type: d.type,
          size: d.size,
          role: "original",
        })),
      }),
    ],
    [a, b],
  );
  expect(row).toMatchObject({
    id: "a",
    paperId: "item",
    title: "Metadata paper",
    percentage: 0.2,
    noteCount: 5,
    highlightCount: 4,
    metadataOnly: false,
  });
  expect(row.attachments?.map((a) => a.documentId)).toEqual(["a", "b"]);
});
it("keeps attachmentless items editable through the paper API", async () => {
  const [row] = projectPapers([item()], []);
  expect(row.metadataOnly).toBe(true);
  await patchPapers([[row, { title: "Edited", tags: ["review"] }]]);
  expect(api.updatePaper).toHaveBeenCalledWith("item", {
    title: "Edited",
    tags: ["review"],
  });
  expect(api.update).not.toHaveBeenCalled();
});
it("uses the server serializer for bibliography export in either ordering", async () => {
  const docs = [
    paper({ paperId: "item", citationKey: "stable" }),
    paper({ id: "b", paperId: "other", citationKey: "otherKey" }),
  ];
  await expect(formatCitations(docs, "bibtex")).resolves.toBe("@misc{stable}");
  await formatCitations([...docs].reverse(), "biblatex");
  expect(api.exportBibliography).toHaveBeenNthCalledWith(
    1,
    ["item", "other"],
    "bibtex",
  );
  expect(api.exportBibliography).toHaveBeenNthCalledWith(
    2,
    ["other", "item"],
    "biblatex",
  );
});
it("exports the allocated persistent key in RIS as well as CSL JSON", async () => {
  useReaderStore.setState({
    paperItems: [item({ citationKey: "" })],
    documents: [paper({ paperId: "item", citationKey: "" })],
  });
  const doc = paper({ paperId: "item", citationKey: "" });
  expect(await formatCitations([doc], "ris")).toContain("ID  - stable");
  expect(
    JSON.parse(await formatCitations([doc], "csl-json"))[0]["citation-key"],
  ).toBe("stable");
  expect(useReaderStore.getState().paperItems?.[0].citationKey).toBe("stable");
  expect(useReaderStore.getState().documents[0].citationKey).toBe("stable");
});
it("preserves the item identity for immediate undo before the trash poll completes", async () => {
  const entry = item({
    primaryDocumentId: "a",
    attachments: [
      { documentId: "a", role: "original", title: "A", type: "pdf", size: 1 },
    ],
  });
  useReaderStore.setState({
    paperItems: [entry],
    documents: [paper({ id: "a" })],
    trash: [],
    libraryPreferences: { mode: "papers" },
  });
  vi.mocked(api.trashPaper).mockResolvedValue({
    ...entry,
    deletedAt: "2026-10-21",
  });
  vi.mocked(api.trash).mockReturnValue(new Promise(() => {}));
  await removeLibraryDocuments(["a"]);
  expect(useReaderStore.getState().trash[0]).toMatchObject({
    id: "a",
    paperId: "item",
  });
});
