// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@interleaf/api";
import type { Document } from "@interleaf/core";
import { TrashView } from "./TrashView";
import { useReaderStore } from "./store";
vi.mock("@interleaf/api", () => ({
  api: {
    restoreDocument: vi.fn(),
    removeDocument: vi.fn(),
    restorePaper: vi.fn(),
    removePaper: vi.fn(),
    emptyTrash: vi.fn(),
    trash: vi.fn(async () => []),
    papers: vi.fn(async () => []),
    documents: vi.fn(async () => []),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const trashed = (id: string, title: string) =>
  ({
    id,
    paperId: `item-${id}`,
    title,
    author: "Ada",
    type: "pdf",
    library: "papers",
    deletedAt: "2026-10-08T10:00:00Z",
  }) as Document;
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  useReaderStore.setState({
    libraryPreferences: { mode: "papers" },
    trash: [trashed("a", "Alpha"), trashed("b", "Beta")],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <TrashView documents={[trashed("a", "Alpha"), trashed("b", "Beta")]} />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});
const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => b.textContent?.trim() === label,
  );
it("restores one document from the trash", async () => {
  await act(async () => button("恢复")[1].click());
  expect(api.restorePaper).toHaveBeenCalledExactlyOnceWith("item-b");
  expect(api.removePaper).not.toHaveBeenCalled();
});
it("purges only after confirmation", async () => {
  await act(async () => button("彻底删除")[0].click());
  expect(api.removePaper).not.toHaveBeenCalled();
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("彻底删除 1 份");
  await act(async () => button("彻底删除", dialog)[0].click());
  expect(api.removePaper).toHaveBeenCalledExactlyOnceWith("item-a");
});
it("purges each paper item so metadata-only entries are included", async () => {
  await act(async () => button("清空回收站")[0].click());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  await act(async () => button("彻底删除", dialog)[0].click());
  expect(api.removePaper).toHaveBeenNthCalledWith(1, "item-a");
  expect(api.removePaper).toHaveBeenNthCalledWith(2, "item-b");
  expect(api.emptyTrash).not.toHaveBeenCalled();
});
