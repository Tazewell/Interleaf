// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, researchAPI } from "@interleaf/api";
import {
  defaultTheme,
  type Document,
  type PaperItem,
  type ResearchTopic,
} from "@interleaf/core";
import { App } from "./App";
import { paper } from "./papers/fixtures";
import { usePaperUI } from "./papers/state";
import { useReaderStore } from "./store";

vi.mock("./Workspace", () => ({ Workspace: () => null }));
const settingsMounted = vi.hoisted(() => vi.fn());
vi.mock("./Settings", () => ({
  Settings: ({ open }: { open: boolean }) => {
    settingsMounted(open);
    return open ? <p>设置窗口已打开</p> : null;
  },
}));
vi.mock("./release-notes/ReleaseNotesHost", () => ({
  ReleaseNotesHost: () => null,
}));
vi.mock("./research/ResearchNavigation", () => ({
  ResearchNavigation: () => null,
}));
vi.mock("./research/ResearchPanel", () => ({ ResearchPanel: () => null }));
vi.mock("./annotated-pdf-export", () => ({
  exportAnnotatedPDFWithToast: vi.fn(),
}));
vi.mock("@interleaf/api", async (original) => ({
  ...(await original<typeof import("@interleaf/api")>()),
  researchAPI: { listTopics: vi.fn() },
  api: {
    documents: vi.fn(),
    papers: vi.fn(),
    trash: vi.fn(),
    processing: vi.fn(),
    overviewJobs: vi.fn(),
    libraryPreferences: vi.fn(),
    saveLibraryPreferences: vi.fn(async (value) => value),
    settings: vi.fn(),
    saveSettings: vi.fn(async (value) => value),
    shortcutPreferences: vi.fn(),
    update: vi.fn(),
    connectorRevision: vi.fn(),
    import: vi.fn(),
    importWithOutcome: vi.fn(),
    attachPaper: vi.fn(),
    snapshotStatus: vi.fn(async () => ({ available: false })),
    journalRankConfig: vi.fn(async () => ({
      enabled: false,
      hasKey: false,
      selected: [],
      available: [],
    })),
    ensureCitationKeys: vi.fn(async () => []),
  },
}));

let host: HTMLDivElement;
let root: Root;
const book = (patch: Partial<Document>) =>
  paper({ library: "books", ...patch });
const citation: PaperItem = {
  id: "citation",
  title: "Understanding Reading",
  author: "Emilia Lee",
  metadata: { doi: "10.1000/reading" },
  tags: [],
  folders: [],
  favorite: false,
  createdAt: "2026-10-01T00:00:00Z",
  primaryDocumentId: "",
  citationKey: "Lee2026",
  attachments: [],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.resetAllMocks();
  vi.mocked(api.documents).mockResolvedValue([]);
  vi.mocked(api.papers).mockResolvedValue([]);
  vi.mocked(api.trash).mockResolvedValue([]);
  vi.mocked(api.processing).mockResolvedValue([]);
  vi.mocked(api.overviewJobs).mockResolvedValue([]);
  vi.mocked(api.libraryPreferences).mockResolvedValue({ primaryMode: "books" });
  vi.mocked(api.settings).mockResolvedValue(defaultTheme);
  vi.mocked(api.shortcutPreferences).mockResolvedValue({});
  vi.mocked(api.connectorRevision).mockResolvedValue({ revision: 0 });
  vi.mocked(api.update).mockResolvedValue(paper());
  usePaperUI.setState({
    view: "all",
    query: "",
    selectedId: null,
    researchTopicId: null,
    tagFilter: { tags: [], match: "all" },
    picking: false,
  });
  useReaderStore.setState({
    documents: [],
    paperItems: null,
    active: null,
    libraryPreferences: {},
    theme: defaultTheme,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<App />));
const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.trim().includes(label),
  );
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const quickFind = async (query: string) => {
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="快速查找"]')!.click(),
  );
  const input = dialog().querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const drop = (files: File[]) => {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  host.querySelector(".app")!.dispatchEvent(event);
};

it("refreshes the library when local titles have changed before the first revision poll", async () => {
  vi.mocked(api.documents)
    .mockResolvedValueOnce([book({ id: "first", title: "paper (1)" })])
    .mockResolvedValue([book({ id: "first", title: "Recognized title" })]);
  vi.mocked(api.connectorRevision).mockResolvedValue({ revision: 1 });
  await render();
  expect(host.textContent).toContain("Recognized title");
});

it("shows a usable library while saved shortcut preferences are pending", async () => {
  vi.mocked(api.documents).mockResolvedValue([
    book({ id: "first", title: "Ready to read" }),
  ]);
  let finishShortcuts!: () => void;
  vi.mocked(api.shortcutPreferences).mockReturnValue(
    new Promise((resolve) => {
      finishShortcuts = () => resolve({});
    }),
  );
  await render();
  expect(host.textContent).toContain("Ready to read");
  expect(host.textContent).not.toContain("正在打开本地书库");
  expect(api.shortcutPreferences).toHaveBeenCalledOnce();
  await act(async () => finishShortcuts());
});

it("mounts settings only after it is requested from the library", async () => {
  await render();
  expect(settingsMounted).not.toHaveBeenCalled();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!.click(),
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(host.textContent).toContain("设置窗口已打开");
});

it("finds a DOI from the other library and opens the metadata-only detail", async () => {
  vi.mocked(api.papers).mockImplementation(async (trash) =>
    trash ? [] : [citation],
  );
  await render();
  await quickFind("10.1000/reading");
  const result = button(citation.title, dialog());
  expect(result?.textContent).toContain("仅元数据");
  await act(async () => result!.click());
  expect(usePaperUI.getState().selectedId).toBe("paper:citation");
  expect(useReaderStore.getState().libraryPreferences.mode).toBe("papers");
  expect(
    host.querySelector<HTMLTextAreaElement>('.paper-detail [aria-label="标题"]')
      ?.value,
  ).toBe(citation.title);
  expect(button("添加附件", host)?.disabled).toBe(false);
  expect(useReaderStore.getState().active).toBeNull();
});

it("keeps the metadata search result open when a pending research topic returns", async () => {
  vi.mocked(api.libraryPreferences).mockResolvedValue({
    primaryMode: "papers",
  });
  vi.mocked(api.papers).mockImplementation(async (trash) =>
    trash ? [] : [{ ...citation, folders: ["Reading"] }],
  );
  let finishResearch!: (topics: ResearchTopic[]) => void;
  vi.mocked(researchAPI.listTopics).mockReturnValue(
    new Promise((resolve) => (finishResearch = resolve)),
  );
  await render();
  await act(async () =>
    button("Reading", host)!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    ),
  );
  const research = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent?.trim() === "主题研究");
  await act(async () => research!.click());
  expect(researchAPI.listTopics).toHaveBeenCalledOnce();

  await quickFind(citation.metadata.doi!);
  await act(async () => button(citation.title, dialog())!.click());
  await act(async () =>
    finishResearch([
      {
        id: "late-topic",
        title: "Reading",
        folder: "Reading",
        scopeState: "active",
        includeChildren: true,
        networkAllowed: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ]),
  );

  expect(usePaperUI.getState().researchTopicId).toBeNull();
  expect(button("添加附件", host)?.disabled).toBe(false);
});

it("keeps the selected record when a local file becomes its readable attachment", async () => {
  const attachment = book({ id: "attachment", title: "Full text" });
  let item = citation;
  let documents: Document[] = [];
  vi.mocked(api.papers).mockImplementation(async (trash) =>
    trash ? [] : [item],
  );
  vi.mocked(api.documents).mockImplementation(async () => documents);
  vi.mocked(api.import).mockResolvedValue(attachment);
  vi.mocked(api.attachPaper).mockImplementation(async () => {
    documents = [{ ...attachment, library: "papers", paperId: citation.id }];
    item = {
      ...item,
      primaryDocumentId: attachment.id,
      attachments: [
        {
          documentId: attachment.id,
          role: "original",
          title: attachment.title,
          type: "pdf",
          size: 1,
        },
      ],
    };
    return item;
  });

  await render();
  await quickFind(citation.metadata.doi!);
  await act(async () => button(citation.title, dialog())!.click());
  const input = host.querySelector<HTMLInputElement>(
    '.paper-detail input[type="file"]',
  )!;
  const file = new File(["full text"], "full-text.pdf");
  Object.defineProperty(input, "files", { value: [file] });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
  expect(api.attachPaper).toHaveBeenCalledWith(
    "citation",
    "attachment",
    "original",
    true,
  );
  expect(usePaperUI.getState().selectedId).toBe("attachment");
  await act(async () => button("开始阅读", host)!.click());
  expect(useReaderStore.getState().active?.id).toBe("attachment");
});

it("retries a failed attachment link without importing the file again", async () => {
  const fileDocument = book({ id: "saved", title: "Saved full text" });
  vi.mocked(api.papers).mockImplementation(async (trash) =>
    trash ? [] : [citation],
  );
  vi.mocked(api.import).mockResolvedValue(fileDocument);
  vi.mocked(api.attachPaper)
    .mockRejectedValueOnce(new Error("写入失败"))
    .mockResolvedValueOnce(citation);
  vi.mocked(api.documents).mockImplementation(async () =>
    vi.mocked(api.import).mock.calls.length ? [fileDocument] : [],
  );
  await render();
  await quickFind(citation.metadata.doi!);
  await act(async () => button(citation.title, dialog())!.click());
  const input = host.querySelector<HTMLInputElement>(
    '.paper-detail input[type="file"]',
  )!;
  Object.defineProperty(input, "files", {
    value: [new File(["full text"], "full-text.pdf")],
  });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
  expect(host.querySelector(".paper-detail")?.textContent).toContain(
    "Saved full text》仍在图书库",
  );
  await act(async () => button("重试添加附件", host)!.click());
  expect(api.import).toHaveBeenCalledOnce();
  expect(api.attachPaper).toHaveBeenCalledTimes(2);
  expect(api.attachPaper).toHaveBeenLastCalledWith(
    citation.id,
    fileDocument.id,
    "original",
    true,
  );
});

it("refreshes documents after a desktop import without leaving the active research topic", async () => {
  let changed: (() => void) | undefined;
  vi.stubGlobal("interleafDesktop", {
    platform: "win32",
    setAppearance: vi.fn(async () => {}),
    onLibraryChanged: (listener: () => void) => {
      changed = listener;
      return () => {};
    },
  });
  vi.mocked(api.libraryPreferences).mockResolvedValue({
    primaryMode: "papers",
  });
  await render();
  const imported = book({ id: "book", title: "New book" });
  vi.mocked(api.documents).mockResolvedValue([imported]);
  await act(async () => usePaperUI.getState().setResearchTopic("topic"));
  await act(async () => changed!());
  expect(usePaperUI.getState().researchTopicId).toBe("topic");
  expect(useReaderStore.getState().documents).toEqual([imported]);
});

it("reads a successful native import and resubmits only a failed native handle", async () => {
  const first = book({ id: "native", title: "Native" });
  const imported = vi.fn(async () => [
    {
      name: "native.pdf",
      status: "imported",
      documentId: first.id,
      library: "books",
    },
    {
      name: "missing.pdf",
      status: "failed",
      retryId: "failed-handle",
      message: "文件不可读",
    },
  ]);
  const retry = vi.fn(async () => [
    {
      name: "missing.pdf",
      status: "failed",
      retryId: "new-handle",
      message: "文件仍不可读",
    },
  ]);
  const discard = vi.fn(async () => {});
  vi.stubGlobal("interleafDesktop", {
    platform: "win32",
    setAppearance: vi.fn(async () => {}),
    onLibraryChanged: vi.fn(),
    importFiles: imported,
    retryImports: retry,
    discardImports: discard,
  });
  vi.mocked(api.documents).mockImplementation(async () =>
    imported.mock.calls.length ? [first] : [],
  );
  await render();
  await act(async () => button("导入 EPUB / PDF", host)!.click());
  expect(imported).toHaveBeenCalledWith("books", "");
  expect(dialog().textContent).toContain("文件不可读");
  await act(async () => button("重试失败项", dialog())!.click());
  expect(retry).toHaveBeenCalledExactlyOnceWith(["failed-handle"], "books", "");
  expect(dialog().textContent).toContain("文件仍不可读");
  await act(async () => button("阅读原文", dialog())!.click());
  expect(useReaderStore.getState().active?.id).toBe(first.id);
  expect(discard).toHaveBeenCalledExactlyOnceWith(["new-handle"]);
});

it("keeps the newer import summary when a dismissed result finishes loading", async () => {
  const first = book({ id: "first", title: "First file" });
  const importFiles = vi
    .fn()
    .mockResolvedValueOnce([
      {
        name: "first.pdf",
        status: "imported",
        documentId: first.id,
        library: "books",
      },
    ])
    .mockResolvedValueOnce([
      {
        name: "second.pdf",
        status: "failed",
        retryId: "second-handle",
      },
    ]);
  const discardImports = vi.fn(async () => {});
  vi.stubGlobal("interleafDesktop", {
    platform: "win32",
    setAppearance: vi.fn(async () => {}),
    onLibraryChanged: vi.fn(),
    importFiles,
    discardImports,
  });
  await render();
  let finishRefresh!: (documents: Document[]) => void;
  vi.mocked(api.documents)
    .mockRejectedValueOnce(new Error("刷新失败"))
    .mockReturnValueOnce(new Promise((resolve) => (finishRefresh = resolve)));

  const choose = () => button("导入 EPUB / PDF", host)!.click();
  await act(async () => choose());
  await act(async () => button("阅读原文", dialog())!.click());
  await act(async () => button("完成", dialog())!.click());
  await act(async () => choose());
  expect(dialog().textContent).toContain("second.pdf");
  await act(async () => finishRefresh([first]));

  expect(useReaderStore.getState().active).toBeNull();
  expect(dialog().textContent).toContain("second.pdf");
  await act(async () => button("完成", dialog())!.click());
  expect(discardImports).toHaveBeenCalledExactlyOnceWith(["second-handle"]);
});

it("lets an empty paper library choose local PDFs from the main pane", async () => {
  vi.mocked(api.libraryPreferences).mockResolvedValue({
    primaryMode: "papers",
  });
  await render();
  const click = vi.spyOn(HTMLInputElement.prototype, "click");
  const add = button("导入论文 PDF", host.querySelector("main")!);
  expect(add).toBeDefined();
  await act(async () => add!.click());
  expect(click).toHaveBeenCalledOnce();
  click.mockRestore();
});

it("shows an already present file as existing and keeps it readable", async () => {
  const existing = book({ id: "existing", title: "Already here" });
  vi.mocked(api.documents).mockResolvedValue([existing]);
  vi.mocked(api.importWithOutcome).mockResolvedValue({
    document: existing,
    existing: true,
  });
  await render();
  await act(async () => drop([new File(["copy"], "copy.pdf")]));
  expect(dialog().textContent).toContain("已在图书库");
  await act(async () => button("阅读原文", dialog())!.click());
  expect(useReaderStore.getState().active?.id).toBe(existing.id);
});

it("keeps successes on both sides of a failed file and retries only that file", async () => {
  const first = book({ id: "first", type: "epub", title: "First" });
  const last = book({ id: "last", title: "Last" });
  const retried = book({ id: "retried", title: "Retry" });
  const persisted: Document[] = [];
  const attempts: string[] = [];
  vi.mocked(api.documents).mockImplementation(async () => [...persisted]);
  vi.mocked(api.importWithOutcome).mockImplementation(async (file) => {
    if (file.name === "retry.pdf" && !attempts.includes(file.name)) {
      attempts.push(file.name);
      throw new Error("PDF 已损坏");
    }
    attempts.push(file.name);
    const doc =
      file.name === "first.epub"
        ? first
        : file.name === "last.pdf"
          ? last
          : retried;
    persisted.push(doc);
    return { document: doc, existing: false };
  });
  await render();
  await act(async () =>
    drop([
      new File(["first"], "first.epub"),
      new File(["retry"], "retry.pdf"),
      new File(["last"], "last.pdf"),
    ]),
  );
  expect(useReaderStore.getState().documents.map(({ id }) => id)).toEqual([
    "first",
    "last",
  ]);
  expect(dialog().textContent).toContain("PDF 已损坏");
  expect(dialog().textContent).toContain("last.pdf");
  await act(async () => button("重试失败项", dialog())!.click());
  expect(attempts).toEqual([
    "first.epub",
    "retry.pdf",
    "last.pdf",
    "retry.pdf",
  ]);
  expect(dialog().textContent).not.toContain("PDF 已损坏");
  await act(async () => button("阅读原文", dialog())!.click());
  expect(useReaderStore.getState().active?.id).toBe("first");
});
