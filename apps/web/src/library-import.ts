import { useRef, useState } from "react";
import type {
  DesktopImportResult,
  Document,
  LibraryMode,
} from "@interleaf/core";
import { api, RequestError } from "@interleaf/api";
import { toast } from "sonner";
import { refreshLibrary, useReaderStore } from "./store";

export interface ImportTarget {
  library: LibraryMode;
  folder: string;
}

export interface ImportEntry {
  result: Omit<DesktopImportResult, "status"> & {
    status: DesktopImportResult["status"] | "skipped";
  };
  target: ImportTarget;
  file?: File;
  allowLarge?: boolean;
  document?: Document;
}

async function upload(
  file: File,
  target: ImportTarget,
  allowLarge = false,
): Promise<ImportEntry> {
  const name = file.name;
  const supported = target.library === "papers" ? /\.pdf$/i : /\.(epub|pdf)$/i;
  if (!supported.test(name))
    return {
      target,
      result: {
        name,
        status: "skipped",
        message:
          target.library === "papers"
            ? "论文库仅支持 PDF"
            : "仅支持 EPUB 和 PDF",
      },
    };
  try {
    const { document, existing } = await api.importWithOutcome(
      file,
      target.library,
      allowLarge,
      target.folder,
    );
    return {
      target,
      document,
      result: {
        name,
        status:
          document.library !== target.library
            ? "elsewhere"
            : existing
              ? "existing"
              : "imported",
        library: document.library,
        documentId: document.id,
      },
    };
  } catch (error) {
    return {
      target,
      file,
      allowLarge,
      result:
        error instanceof RequestError &&
        error.code === "large-paper" &&
        !allowLarge
          ? { name, status: "large", pages: error.pages }
          : { name, status: "failed", message: (error as Error).message },
    };
  }
}

function discardNativeRetries(entries: ImportEntry[]) {
  const ids = entries.flatMap(({ result }) =>
    result.retryId ? [result.retryId] : [],
  );
  if (ids.length)
    void window.interleafDesktop?.discardImports?.(ids).catch(() => {});
}

export function useLibraryImport() {
  const [entries, setEntries] = useState<ImportEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const running = useRef(false);
  const action = useRef(0);
  const confirm = entries.filter(({ result }) => result.status === "large");

  const run = async (operation: () => Promise<ImportEntry[]>) => {
    if (running.current) return;
    running.current = true;
    ++action.current;
    setBusy(true);
    try {
      const next = await operation();
      if (!next.length) return;
      setEntries(next);
      setRefreshError(false);
      if (next.some(({ result }) => !!result.documentId)) {
        await refreshLibrary().catch(() => setRefreshError(true));
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const choose = (target: ImportTarget) => {
    const desktop = window.interleafDesktop;
    if (!desktop || entries.length) return;
    return run(async () =>
      (await desktop.importFiles(target.library, target.folder)).map(
        (result) => ({
          result,
          target,
        }),
      ),
    );
  };

  const drop = (files: File[], target: ImportTarget) => {
    if (!files.length || entries.length) return;
    return run(async () => {
      const next: ImportEntry[] = [];
      for (const file of files) next.push(await upload(file, target));
      return next;
    });
  };

  const retry = (library?: LibraryMode) =>
    run(async () => {
      const next: ImportEntry[] = [];
      const desktop = window.interleafDesktop;
      for (const entry of entries) {
        const { result, file } = entry;
        const retrying = library
          ? result.status === "large"
          : result.status === "failed";
        if (!retrying) {
          next.push(entry);
          continue;
        }
        const target =
          library === "books" ? { library, folder: "" } : entry.target;
        if (file) {
          next.push(await upload(file, target, !!library || entry.allowLarge));
          continue;
        }
        if (!desktop || !result.retryId) {
          next.push(entry);
          continue;
        }
        try {
          const ids = [result.retryId];
          const [outcome] = library
            ? await desktop.importLargePapers(
                ids,
                target.library,
                target.folder,
              )
            : await desktop.retryImports(ids, target.library, target.folder);
          next.push({
            target,
            result: outcome ?? {
              name: result.name,
              status: "failed",
              message: "无法重新打开文件，请重新选择文件。",
            },
          });
        } catch (error) {
          if (library) discardNativeRetries([entry]);
          next.push({
            ...entry,
            target,
            result: {
              ...result,
              status: "failed",
              retryId: library ? undefined : result.retryId,
              message: (error as Error).message,
            },
          });
        }
      }
      return next;
    });

  const close = () => {
    ++action.current;
    discardNativeRetries(entries);
    setEntries([]);
  };

  const read = async (
    { result, document }: ImportEntry,
    onRead: (document: Document) => void,
  ) => {
    if (!result.documentId) return;
    const selection = ++action.current;
    const getDocument = () =>
      useReaderStore
        .getState()
        .documents.find((doc) => doc.id === result.documentId);
    let doc = getDocument() ?? document;
    try {
      if (!doc) {
        await refreshLibrary();
        doc = getDocument();
      }
      if (selection !== action.current) return;
      if (!doc) throw new Error("在书库中找不到这份文档。");
    } catch (error) {
      if (selection === action.current) toast.error((error as Error).message);
      return;
    }
    close();
    onRead(doc);
  };

  return {
    entries,
    confirm,
    busy,
    refreshError,
    choose,
    drop,
    retry,
    read,
    close,
    cancelLarge: () => {
      discardNativeRetries(confirm);
      setEntries((current) =>
        current.map((entry) =>
          entry.result.status === "large"
            ? {
                target: entry.target,
                result: {
                  name: entry.result.name,
                  status: "skipped",
                  message: "已取消导入",
                },
              }
            : entry,
        ),
      );
    },
  };
}
