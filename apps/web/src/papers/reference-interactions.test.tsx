// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { PaperDetail } from "./PaperDetail";
import { TrashView } from "../TrashView";
import { useReaderStore } from "../store";
import { paper } from "./fixtures";
import { MergeDialog } from "./MergeDialog";
vi.mock("@reader/api", () => ({
  api: {
    snapshotStatus: vi.fn(async () => ({ available: false })),
    documents: vi.fn(async () => []),
    papers: vi.fn(async () => []),
    trash: vi.fn(async () => []),
    updatePaper: vi.fn(),
    update: vi.fn(),
    detachPaper: vi.fn(),
    restorePaper: vi.fn(),
    restoreDocument: vi.fn(),
    bibliographyExports: vi.fn(async () => []),
    annotations: vi.fn(async () => [
      {
        id: "annotation-2",
        documentId: "secondary",
        kind: "note",
        note: "Second file note",
        quote: "Original quote",
        location: { type: "pdf", page: 7 },
      },
    ]),
  },
  publicationURL: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const secondary = paper({ id: "secondary", title: "译文", noteCount: 3 });
const row = paper({
  id: "primary",
  paperId: "item",
  citationKey: "stable",
  attachments: [
    {
      documentId: "primary",
      role: "original",
      title: "原文",
      type: "pdf",
      size: 1,
    },
    {
      documentId: "secondary",
      role: "translation",
      title: "译文",
      type: "pdf",
      size: 1,
    },
  ],
});
let root: Root, host: HTMLDivElement;
const actions = {
  open: vi.fn(),
  move: vi.fn(),
  trash: vi.fn(),
  newCategory: vi.fn(),
  newTag: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useReaderStore.setState({
    documents: [paper({ id: "primary" }), secondary],
    paperItems: null,
    libraryPreferences: { mode: "papers" },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) =>
      b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
it("disables file actions for metadata-only papers without snapshot requests", async () => {
  await act(async () =>
    root.render(
      <PaperDetail
        doc={paper({ id: "paper:empty", paperId: "empty", metadataOnly: true })}
        actions={actions}
      />,
    ),
  );
  expect(button("开始阅读")?.disabled).toBe(true);
  expect(button("查找论文信息")?.disabled).toBe(true);
  expect(api.snapshotStatus).not.toHaveBeenCalled();
});
it("opens a secondary attachment using its real document and preserves its note identity", async () => {
  await act(async () =>
    root.render(<PaperDetail doc={row} actions={actions} />),
  );
  const open = button("打开附件 译文");
  expect(open).toBeTruthy();
  await act(async () => open!.click());
  expect(actions.open).toHaveBeenCalledWith(secondary);
  expect(document.body.textContent).toContain("3 条批注");
});
it("opens a secondary attachment annotation at its own saved location", async () => {
  await act(async () =>
    root.render(<PaperDetail doc={row} actions={actions} />),
  );
  const notes = button("查看附件批注 译文");
  expect(notes).toBeTruthy();
  await act(async () => notes!.click());
  await act(async () => button("Second file note")!.click());
  expect(api.annotations).toHaveBeenCalledWith("secondary");
  expect(useReaderStore.getState().linkTarget).toEqual({
    id: "secondary",
    annotation: "annotation-2",
  });
  expect(actions.open).toHaveBeenCalledWith(secondary);
});
it("distinguishes detaching a file from trashing the whole item", async () => {
  await act(async () =>
    root.render(<PaperDetail doc={row} actions={actions} />),
  );
  const detach = button("移出附件 译文");
  expect(detach).toBeTruthy();
  await act(async () => detach!.click());
  expect(document.body.textContent).toContain("保留文件及其阅读记录");
  await act(async () => button("确认移出")!.click());
  expect(api.detachPaper).toHaveBeenCalledWith("item", "secondary");
  expect(actions.trash).not.toHaveBeenCalled();
});
it("restores a metadata-only paper through its item identity", async () => {
  const empty = paper({
    id: "paper:empty",
    paperId: "empty",
    metadataOnly: true,
    deletedAt: "2026-10-21",
  });
  useReaderStore.setState({ trash: [empty] });
  await act(async () => root.render(<TrashView documents={[empty]} />));
  await act(async () => button("恢复")!.click());
  expect(api.restorePaper).toHaveBeenCalledWith("empty");
  expect(api.restoreDocument).not.toHaveBeenCalled();
});
it("shows field conflicts and requires a retained key and citation impact confirmation before merge", async () => {
  await act(async () =>
    root.render(
      <MergeDialog
        group={[
          row,
          paper({
            id: "second",
            paperId: "second-item",
            title: "Other title",
            citationKey: "oldKey",
            metadata: { venue: "Other venue" },
          }),
        ]}
        onClose={() => {}}
      />,
    ),
  );
  expect(document.body.textContent).toContain("保留全部附件");
  expect(document.body.textContent).toContain("冲突字段");
  expect(document.body.textContent).toContain("oldKey");
  expect(document.body.textContent).toContain("LaTeX");
  expect(button("合并")?.disabled).toBe(true);
});
