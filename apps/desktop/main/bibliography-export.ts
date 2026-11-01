import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface BibliographyExportOptions {
  folder: string;
  includeChildren: boolean;
  mode: "bibtex" | "biblatex";
}

export interface BibliographyExportTarget extends BibliographyExportOptions {
  path: string;
  takeover: boolean;
}

interface ExportHost<T> {
  choose: (suggestedName: string) => Promise<string | null>;
  confirmTakeover: (path: string) => Promise<boolean>;
  register: (target: BibliographyExportTarget) => Promise<T>;
}

/** The renderer chooses a collection, never a filesystem path or capability. */
export async function configureBibliographyExport<T>(
  input: unknown,
  host: ExportHost<T>,
): Promise<T | null> {
  if (!input || typeof input !== "object") throw new Error("无效的导出设置");
  const options = input as Record<string, unknown>;
  if (
    typeof options.folder !== "string" ||
    options.folder.length > 1000 ||
    /[\u0000-\u001f]/.test(options.folder) ||
    (options.includeChildren !== undefined &&
      typeof options.includeChildren !== "boolean") ||
    (options.mode !== "bibtex" && options.mode !== "biblatex")
  )
    throw new Error("无效的导出设置");
  const folder = options.folder.trim();
  const name = (folder.split("/").at(-1) || "references")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 80);
  const path = await host.choose(`${name || "references"}.bib`);
  if (!path) return null;
  if (!isAbsolute(path)) throw new Error("请选择完整的导出文件位置");
  let takeover = false;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("导出位置必须是普通文件");
    if (!(await host.confirmTakeover(path))) return null;
    takeover = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The server revalidates ownership, creates the backup and performs the write.
  return host.register({
    folder,
    includeChildren: options.includeChildren !== false,
    mode: options.mode,
    path,
    takeover,
  });
}
