import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { DesktopImportResult } from "../../../packages/interleaf-core/src/desktop-import";

type Library = NonNullable<DesktopImportResult["library"]>;
type RetryKind = "failed" | "large";
type PendingImport = { path: string; kind: RetryKind; allowLarge: boolean };

export class DesktopImportService {
  private pending = new Map<string, PendingImport>();

  constructor(
    private submit: (form: FormData) => Promise<Response>,
    private onLibraryChanged: () => void,
  ) {}

  importPaths(paths: string[], library: Library, folder = "") {
    return this.run(
      paths.map((path) => ({ path, allowLarge: false })),
      library,
      folder,
    );
  }

  retry(ids: string[], kind: RetryKind, library: Library, folder = "") {
    const files = ids.flatMap((id) => {
      const entry = this.pending.get(id);
      if (!entry || entry.kind !== kind) return [];
      this.pending.delete(id);
      return [
        { path: entry.path, allowLarge: kind === "large" || entry.allowLarge },
      ];
    });
    return this.run(files, library, folder);
  }

  discard(ids: string[]) {
    for (const id of ids) this.pending.delete(id);
  }

  private remember(file: Omit<PendingImport, "kind">, kind: RetryKind) {
    const id = randomBytes(16).toString("hex");
    this.pending.set(id, { ...file, kind });
    return id;
  }

  private async run(
    files: Omit<PendingImport, "kind">[],
    library: Library,
    folder: string,
  ) {
    const results: DesktopImportResult[] = [];
    for (const file of files)
      results.push(await this.importOne(file, library, folder));
    if (
      results.some(
        ({ status }) =>
          status === "imported" ||
          status === "existing" ||
          status === "elsewhere",
      )
    )
      this.onLibraryChanged();
    return results;
  }

  private async importOne(
    file: Omit<PendingImport, "kind">,
    library: Library,
    folder: string,
  ): Promise<DesktopImportResult> {
    const name = basename(file.path);
    const supported = library === "papers" ? /\.pdf$/i : /\.(epub|pdf)$/i;
    if (!supported.test(name))
      return { name, status: "failed", message: "此书库不支持该文件格式。" };
    const fail = (message: string): DesktopImportResult => ({
      name,
      status: "failed",
      message,
      retryId: this.remember(file, "failed"),
    });
    let data: Buffer<ArrayBuffer>;
    try {
      data = await readFile(file.path);
    } catch {
      return fail("无法读取所选文件。请确认文件仍在原位置。");
    }
    const form = new FormData();
    form.append("library", library);
    if (file.allowLarge) form.append("allowLarge", "1");
    if (folder.startsWith("smart:"))
      form.append("smartCategory", folder.slice(6));
    else if (folder)
      form.append(
        "folder",
        folder.startsWith("folder:") ? folder.slice(7) : folder,
      );
    form.append("file", new Blob([data]), name);

    try {
      const response = await this.submit(form);
      const result = await response.json();
      if (!response.ok) {
        if (result?.code === "large-paper" && !file.allowLarge)
          return {
            name,
            status: "large",
            pages: typeof result.pages === "number" ? result.pages : undefined,
            retryId: this.remember(file, "large"),
          };
        return fail(
          typeof result?.error === "string" && result.error
            ? result.error
            : "本地服务未能导入此文件。",
        );
      }
      if (
        typeof result?.id !== "string" ||
        !result.id ||
        (result.library !== "books" && result.library !== "papers")
      )
        return fail("本地服务返回了无法识别的导入结果。");
      return {
        name,
        status:
          result.library !== library
            ? "elsewhere"
            : response.status === 201
              ? "imported"
              : "existing",
        documentId: result.id,
        library: result.library,
      };
    } catch {
      return fail("无法获取本地服务的导入结果，请重试。");
    }
  }
}
