// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { api } from "@interleaf/api";
import { BibliographyImportDialog } from "./BibliographyImportDialog";
import { BibliographyExportDialog } from "./BibliographyExportDialog";
import { downloadText } from "../download";
import { useReaderStore } from "../store";
import { paper } from "./fixtures";
vi.mock("@interleaf/api", () => ({
  api: {
    previewBibliography: vi.fn(async () => ({
      entries: [
        {
          index: 0,
          key: "old",
          title: "Entry",
          matchedId: "existing",
          warnings: ["保留已有键"],
        },
      ],
    })),
    importBibliography: vi.fn(async () => []),
    papers: vi.fn(async () => []),
    documents: vi.fn(async () => []),
    bibliographyExports: vi.fn(async () => []),
    ensureCitationKeys: vi.fn(async () => []),
    exportBibliography: vi.fn(async () => ({ text: "@misc{stable}" })),
    saveLibraryPreferences: vi.fn(async (v) => v),
  },
}));
vi.mock("../download", () => ({ downloadText: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
let root: Root;
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
  vi.stubGlobal("PointerEvent", MouseEvent);
  const h = document.createElement("div");
  document.body.append(h);
  root = createRoot(h);
  useReaderStore.setState({ paperItems: [], libraryPreferences: {} });
  delete window.interleafDesktop;
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const button = (s: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === s,
  );
it("requires an explicit decision for every preview entry before writing", async () => {
  await act(async () =>
    root.render(<BibliographyImportDialog onClose={() => {}} />),
  );
  const input = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="BibTeX 内容"]',
  );
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "@misc{old,title={Entry}}");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("预览导入")!.click());
  expect(document.body.textContent).toContain("保留已有键");
  expect(button("确认导入")?.disabled).toBe(true);
  expect(api.importBibliography).not.toHaveBeenCalled();
  await act(async () => button("跳过")!.click());
  expect(button("确认导入")?.disabled).toBe(false);
  await act(async () => button("确认导入")!.click());
  expect(api.importBibliography).toHaveBeenCalledWith(
    "@misc{old,title={Entry}}",
    [{ index: 0, action: "skip" }],
    false,
  );
});
it("downloads a folder bibliography in browsers without offering arbitrary path registration", async () => {
  await act(async () =>
    root.render(
      <BibliographyExportDialog
        folder="Project"
        documents={[paper({ paperId: "item", folders: ["Project/sub"] })]}
        onClose={() => {}}
      />,
    ),
  );
  expect(button("保存 .bib")).toBeTruthy();
  expect(button("设置自动导出位置")).toBeUndefined();
  await act(async () => button("保存 .bib")!.click());
  expect(api.exportBibliography).toHaveBeenCalledWith(["item"], "bibtex");
  expect(downloadText).toHaveBeenCalledWith(
    "@misc{stable}",
    "Project.bib",
    "application/x-bibtex",
  );
});
it("uses only the desktop native chooser capability for managed export", async () => {
  const configure = vi.fn(async () => null);
  window.interleafDesktop = {
    platform: "win32",
    configureBibliographyExport: configure,
  } as unknown as typeof window.interleafDesktop;
  await act(async () =>
    root.render(
      <BibliographyExportDialog
        folder="Project"
        documents={[]}
        onClose={() => {}}
      />,
    ),
  );
  const setup = button("设置自动导出位置");
  expect(setup).toBeTruthy();
  await act(async () => setup!.click());
  expect(configure).toHaveBeenCalledWith({
    folder: "Project",
    includeChildren: true,
    mode: "bibtex",
  });
});
