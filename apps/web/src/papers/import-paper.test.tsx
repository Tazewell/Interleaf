// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@interleaf/api";
import { toast } from "sonner";
import { ImportPaperDialog } from "./ImportPaperDialog";
import { looksLikeReference } from "./actions";
import { usePaperUI } from "./state";
import { useReaderStore } from "../store";
import { paper } from "./fixtures";
vi.mock("@interleaf/api", async (importOriginal) => ({
  RequestError: (await importOriginal<typeof import("@interleaf/api")>())
    .RequestError,
  api: {
    resolveDocument: vi.fn(),
    previewBibliography: vi.fn(async () => ({
      entries: [
        {
          index: 0,
          key: "old",
          title: "Entry",
          matchedId: "existing",
          warnings: [],
        },
      ],
    })),
    importBibliography: vi.fn(async () => []),
    papers: vi.fn(async () => []),
    documents: vi.fn(async () => []),
    zoteroDefaults: vi.fn(async () => ({ directory: "/tmp/Zotero" })),
    scanZotero: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
let root: Root, host: HTMLDivElement;
const close = vi.fn(),
  choose = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  usePaperUI.setState({
    view: "starred",
    query: "x",
    tagFilter: { tags: ["missing"], match: "all" },
    selectedId: null,
  });
  useReaderStore.setState({
    documents: [],
    paperItems: [],
    libraryPreferences: {},
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ImportPaperDialog open onOpenChange={close} onChooseFiles={choose} />,
    ),
  );
});
it("uses the current paper category for file and reference imports", async () => {
  await act(async () => {
    useReaderStore.setState({
      documents: [paper({ folders: ["Security/Web"] })],
      libraryPreferences: { papers: { categories: ["Security/Web"] } },
    });
    usePaperUI.getState().setView("folder:Security/Web");
  });
  await act(async () =>
    root.render(
      <ImportPaperDialog
        open={false}
        onOpenChange={close}
        onChooseFiles={choose}
      />,
    ),
  );
  await act(async () =>
    root.render(
      <ImportPaperDialog open onOpenChange={close} onChooseFiles={choose} />,
    ),
  );
  const folder = document.querySelector<HTMLButtonElement>(
    '[aria-labelledby="import-paper-folder-label"]',
  );
  expect(folder?.textContent).toContain("Security / Web");
  await act(async () => tab("本地文件")!.click());
  const fileButton = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("选择 PDF 文件"),
  )!;
  await act(async () => fileButton.click());
  expect(choose).toHaveBeenCalledWith("folder:Security/Web");
  await act(async () => tab("链接与标识")!.click());

  vi.mocked(api.resolveDocument).mockResolvedValue(
    paper({ id: "new", folders: ["Security/Web"] }),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, "1706.03762"));
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.resolveDocument).toHaveBeenCalledWith("1706.03762", {
    library: "papers",
    allowLarge: false,
    folder: "Security/Web",
  });
  expect(usePaperUI.getState().view).toBe("folder:Security/Web");
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("defaults to the current smart category and passes its ID to both import paths", async () => {
  await act(async () => {
    useReaderStore.setState({
      libraryPreferences: {
        papers: {
          smartCategories: [
            { id: "web", name: "Web Security", tags: ["Security", "Web"] },
          ],
        },
      },
    });
    usePaperUI.getState().setView("smart:web");
    root.render(
      <ImportPaperDialog
        open={false}
        onOpenChange={close}
        onChooseFiles={choose}
      />,
    );
  });
  await act(async () =>
    root.render(
      <ImportPaperDialog open onOpenChange={close} onChooseFiles={choose} />,
    ),
  );
  expect(
    document.querySelector('[aria-labelledby="import-paper-folder-label"]')
      ?.textContent,
  ).toContain("Web Security（智能标签）");
  await act(async () => tab("本地文件")!.click());
  const fileButton = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("选择 PDF 文件"),
  )!;
  await act(async () => fileButton.click());
  expect(choose).toHaveBeenCalledWith("smart:web");
  await act(async () => tab("链接与标识")!.click());
  vi.mocked(api.resolveDocument).mockResolvedValue(
    paper({ tags: ["Security", "Web"] }),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, "1706.03762"));
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.resolveDocument).toHaveBeenCalledWith("1706.03762", {
    library: "papers",
    allowLarge: false,
    smartCategory: "web",
  });
  expect(usePaperUI.getState().view).toBe("smart:web");
});
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
it("recognizes pasted identifiers but not arbitrary text", () => {
  for (const ref of [
    "2401.01234",
    "arXiv:2401.01234v2",
    "10.1145/3290605.3300857",
    "doi:10.1000/x",
    "https://openreview.net/forum?id=abc",
  ])
    expect(looksLikeReference(ref)).toBe(true);
  for (const text of ["hello world", "Attention is all you need", "2024"])
    expect(looksLikeReference(text)).toBe(false);
});
it("imports by reference and shows the new paper", async () => {
  vi.mocked(api.resolveDocument).mockResolvedValue(
    paper({ id: "new", title: "Attention" }),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, " 1706.03762 "));
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.resolveDocument).toHaveBeenCalledExactlyOnceWith("1706.03762");
  expect(toast.success).toHaveBeenCalledWith("已导入《Attention》");
  expect(usePaperUI.getState()).toMatchObject({
    view: "all",
    query: "",
    selectedId: "new",
    tagFilter: { tags: [], match: "all" },
  });
  expect(close).toHaveBeenCalledWith(false);
});
it("keeps the dialog open and reports a failed lookup", async () => {
  vi.mocked(api.resolveDocument).mockRejectedValue(
    new Error("找到了《X》，但没有公开的 PDF"),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, "10.1000/closed"));
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(toast.error).toHaveBeenCalledWith("找到了《X》，但没有公开的 PDF");
  expect(close).not.toHaveBeenCalled();
});

it.each(["papers", "books"] as const)(
  "asks before importing a large reference into %s",
  async (library) => {
    const { RequestError } = await import("@interleaf/api");
    const { LargePaperConfirmation } = await import("../LargePaperDialog");
    const { importReference } = await import("./actions");
    await act(async () => root.render(<LargePaperConfirmation />));
    vi.mocked(api.resolveDocument)
      .mockRejectedValueOnce(new RequestError("too large", "large-paper", 120))
      .mockResolvedValueOnce(paper({ library }));
    let result: ReturnType<typeof importReference>;
    await act(async () => {
      result = importReference("1706.03762", "smart:web");
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("检测到 PDF 过大");
    expect(api.resolveDocument).toHaveBeenCalledTimes(1);
    const label =
      library === "papers"
        ? "确认是论文，仍然导入论文库"
        : "不是论文，导入图书库";
    const choice = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === label,
    )!;
    await act(async () => {
      choice.click();
      await result;
    });
    expect(api.resolveDocument).toHaveBeenLastCalledWith("1706.03762", {
      library,
      allowLarge: true,
      ...(library === "papers" ? { smartCategory: "web" } : {}),
    });
  },
);
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.textContent === name,
  );
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === name,
  );
it("retains reference and BibTeX drafts while switching import tabs", async () => {
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, "10.1000/draft"));
  expect(tab("BibTeX")).toBeTruthy();
  await act(async () => tab("BibTeX")!.click());
  const bib = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="BibTeX 内容"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(bib, "@misc{draft}");
    bib.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => tab("链接与标识")!.click());
  expect(
    document.querySelector<HTMLInputElement>('[aria-label="论文标识或链接"]')!
      .value,
  ).toBe("10.1000/draft");
  await act(async () => tab("BibTeX")!.click());
  expect(
    document.querySelector<HTMLTextAreaElement>('[aria-label="BibTeX 内容"]')!
      .value,
  ).toBe("@misc{draft}");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
});
it("guards switching and closing while a reference download is pending", async () => {
  let reject!: (e: Error) => void;
  vi.mocked(api.resolveDocument).mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="论文标识或链接"]',
  )!;
  await act(async () => type(input, "10.1000/pending"));
  await act(async () =>
    input.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(tab("BibTeX")?.getAttribute("aria-disabled")).toBe("true");
  await act(async () => tab("BibTeX")!.click());
  expect(tab("链接与标识")?.getAttribute("aria-selected")).toBe("true");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
      .click(),
  );
  expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error("offline")));
  expect(input.value).toBe("10.1000/pending");
  expect(tab("BibTeX")?.getAttribute("aria-disabled")).not.toBe("true");
});
it("requires explicit BibTeX decisions and citation-key confirmation inside the import dialog", async () => {
  await act(async () =>
    useReaderStore.setState({
      paperItems: [
        { id: "existing", title: "Existing", citationKey: "stable" },
      ] as never,
    }),
  );
  expect(tab("BibTeX")).toBeTruthy();
  await act(async () => tab("BibTeX")!.click());
  const bib = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="BibTeX 内容"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(bib, "@misc{old}");
    bib.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("预览导入")!.click());
  expect(button("确认导入")!.disabled).toBe(true);
  await act(async () => button("合并")!.click());
  await act(async () =>
    type(
      document.querySelector<HTMLInputElement>(
        '[aria-label="替换引用键 old"]',
      )!,
      "changed",
    ),
  );
  expect(button("确认导入")!.disabled).toBe(true);
  await act(async () => tab("链接与标识")!.click());
  await act(async () => tab("BibTeX")!.click());
  expect(button("确认导入")!.disabled).toBe(true);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click(),
  );
  await act(async () => button("确认导入")!.click());
  expect(api.importBibliography).toHaveBeenCalledWith(
    "@misc{old}",
    [
      {
        index: 0,
        action: "merge",
        paperId: "existing",
        citationKey: "changed",
      },
    ],
    true,
  );
});
it("keeps BibTeX input and blocks navigation while its preview is pending", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api.previewBibliography).mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  await act(async () => tab("BibTeX")!.click());
  const bib = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="BibTeX 内容"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(bib, "@misc{draft}");
    bib.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("预览导入")!.click());
  await act(async () => {
    tab("链接与标识")!.click();
    document
      .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
      .click();
  });
  expect(tab("BibTeX")?.getAttribute("aria-selected")).toBe("true");
  expect(close).not.toHaveBeenCalled();
  expect(bib.disabled).toBe(true);
  await act(async () => reject(new Error("preview unavailable")));
  expect(bib.value).toBe("@misc{draft}");
  expect(bib.disabled).toBe(false);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "preview unavailable",
  );
});
it("retains migration input across tabs and guards a pending scan", async () => {
  expect(api.zoteroDefaults).not.toHaveBeenCalled();
  await act(async () => tab("文献库迁移")!.click());
  const directory =
    document.querySelector<HTMLInputElement>("#zotero-directory")!;
  await act(async () => type(directory, "/tmp/custom-library"));
  await act(async () => tab("链接与标识")!.click());
  await act(async () => tab("文献库迁移")!.click());
  expect(
    document.querySelector<HTMLInputElement>("#zotero-directory")!.value,
  ).toBe("/tmp/custom-library");
  let reject!: (error: Error) => void;
  vi.mocked(api.scanZotero).mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  await act(async () =>
    directory.form!.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(api.scanZotero).toHaveBeenCalledWith("/tmp/custom-library", "");
  await act(async () => {
    tab("链接与标识")!.click();
    tab("EndNote")!.click();
    document
      .querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!
      .click();
  });
  expect(tab("文献库迁移")?.getAttribute("aria-selected")).toBe("true");
  expect(tab("Zotero")?.getAttribute("aria-selected")).toBe("true");
  expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error("scan unavailable")));
  expect(directory.value).toBe("/tmp/custom-library");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "scan unavailable",
  );
  expect(tab("BibTeX")?.getAttribute("aria-disabled")).not.toBe("true");
});
