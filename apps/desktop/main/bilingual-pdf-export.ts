import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

interface SenderFrame {
  url: string;
}
interface Contents {
  mainFrame: SenderFrame;
}
interface Sender {
  sender: unknown;
  senderFrame: SenderFrame | null;
}
export interface BilingualPDFSaveRequest {
  documentId: string;
  jobId: string;
}
export interface BilingualPDFSaveHost {
  context: () => {
    contents: Contents | undefined;
    appURL: string;
    serverURL: string;
    token: string;
    library: string;
    available: boolean;
  };
  choose: (suggestedName: string) => Promise<string | null>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}
const maximumBytes = 1024 * 1024 * 1024;
function ids(input: unknown): BilingualPDFSaveRequest {
  if (!input || typeof input !== "object")
    throw new Error("无效的双语导出任务");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    ![value.documentId, value.jobId].every(
      (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(id),
    )
  )
    throw new Error("无效的双语导出任务");
  return value as unknown as BilingualPDFSaveRequest;
}
function inside(path: string, root: string) {
  // Windows paths are case-insensitive; realpath also resolves junction aliases.
  const normalize = (p: string) =>
    process.platform === "win32" ? p.toLowerCase() : p;
  const rel = relative(normalize(root), normalize(path));
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}
async function regularTarget(path: string) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("保存位置必须是普通文件");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Main owns local auth, native paths, temporary files, and cancellation. */
export class BilingualPDFSaveService {
  private operations = new Map<
    string,
    {
      abort: AbortController;
      initialReady?: Promise<unknown>;
      download?: Promise<unknown>;
    }
  >();
  private cancelled = new Map<string, number>();
  private stopped = false;
  constructor(private host: BilingualPDFSaveHost) {}
  private pruneCancelled() {
    for (const [key, time] of this.cancelled) {
      if (time <= Date.now() - 30 * 60 * 1000) this.cancelled.delete(key);
    }
    while (this.cancelled.size > 256)
      this.cancelled.delete(this.cancelled.keys().next().value!);
  }
  private authorize(event: Sender) {
    const context = this.host.context();
    if (
      !context.contents ||
      event.sender !== context.contents ||
      !event.senderFrame ||
      event.senderFrame !== context.contents.mainFrame ||
      new URL(event.senderFrame.url).origin !== new URL(context.appURL).origin
    )
      throw new Error("Invalid sender");
    return context;
  }
  async cancel(event: Sender, input: unknown) {
    this.authorize(event);
    const { documentId, jobId } = ids(input);
    const key = `${documentId}/${jobId}`;
    this.cancelled.set(key, Date.now());
    this.pruneCancelled();
    const operation = this.operations.get(key);
    operation?.abort.abort();
    // Native pickers cannot be closed portably. Invalidate them immediately;
    // wait only for owned I/O, whose AbortSignal is under our control.
    await Promise.allSettled([operation?.initialReady, operation?.download]);
  }
  async stop() {
    this.stopped = true;
    for (const operation of this.operations.values()) operation.abort.abort();
    await Promise.allSettled(
      [...this.operations.values()].flatMap((op) => [
        op.initialReady,
        op.download,
      ]),
    );
  }
  async save(
    event: Sender,
    input: unknown,
  ): Promise<{ saved: boolean; fileName?: string }> {
    const context = this.authorize(event);
    const { documentId, jobId } = ids(input);
    const key = `${documentId}/${jobId}`;
    this.pruneCancelled();
    if (
      this.stopped ||
      !context.available ||
      this.cancelled.has(key) ||
      this.operations.has(key)
    )
      return { saved: false };
    const operation = {
      abort: new AbortController(),
      initialReady: undefined as Promise<string> | undefined,
      download: undefined as Promise<unknown> | undefined,
    };
    this.operations.set(key, operation);
    const signal = operation.abort.signal;
    const active = () => {
      const current = this.host.context();
      return (
        !this.stopped &&
        !signal.aborted &&
        current.available &&
        current.contents === context.contents &&
        current.library === context.library &&
        current.serverURL === context.serverURL &&
        current.token === context.token
      );
    };
    const base = new URL(context.serverURL);
    if (
      base.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
    ) {
      this.operations.delete(key);
      throw new Error("无效的本地服务地址");
    }
    const route = `${base.origin}/api/documents/${documentId}/bilingual-pdf/${jobId}`;
    const init = {
      headers: { Authorization: `Bearer ${context.token}` },
      signal,
      redirect: "error" as const,
    };
    const ready = async () => {
      const response = await this.host.fetch(route, init);
      if (!response.ok) throw new Error("双语 PDF 尚未就绪或来源已变化");
      const job = (await response.json()) as {
        status?: string;
        preflight?: { pages: number; outputPages: number };
      };
      const pages = job.preflight?.pages,
        output = job.preflight?.outputPages;
      if (
        job.status !== "ready" ||
        !Number.isSafeInteger(pages) ||
        pages! < 1 ||
        (output !== pages && output !== pages! * 2)
      )
        throw new Error("双语 PDF 尚未就绪或来源已变化");
      return output === pages ? "并排" : "交替";
    };
    try {
      operation.initialReady = ready();
      const mode = await operation.initialReady;
      if (!active()) return { saved: false };
      const path = await this.host.choose(`双语导出-${mode}.pdf`);
      if (!path || !active()) return { saved: false };
      if (!isAbsolute(path)) throw new Error("请选择完整的保存位置");
      operation.download = this.download(
        path,
        context.library,
        `${route}/file`,
        init,
        ready,
        active,
      );
      await operation.download;
      return active()
        ? { saved: true, fileName: basename(path) }
        : { saved: false };
    } catch (error) {
      if (!active()) return { saved: false };
      if (error instanceof Error && /[\u4e00-\u9fff]/.test(error.message))
        throw error;
      throw new Error("保存双语 PDF 失败，请检查磁盘空间和文件权限后重试");
    } finally {
      operation.abort.abort();
      this.operations.delete(key);
    }
  }
  private async download(
    path: string,
    library: string,
    url: string,
    init: RequestInit,
    ready: () => Promise<unknown>,
    active: () => boolean,
  ) {
    const parent = await realpath(dirname(path));
    const managed = await realpath(library);
    const destination = join(parent, basename(path));
    if (inside(destination, managed))
      throw new Error("请将导出文件保存在纸间书库之外");
    await regularTarget(destination);
    const temporary = join(parent, `.interleaf-bilingual-${randomUUID()}.tmp`);
    let owned = false;
    try {
      const response = await this.host.fetch(url, init);
      if (
        !response.ok ||
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/pdf" ||
        !response.body
      )
        throw new Error("无法下载完整的双语 PDF");
      const lengthHeader = response.headers.get("content-length");
      const length = lengthHeader === null ? null : Number(lengthHeader);
      if (
        length !== null &&
        (!Number.isSafeInteger(length) || length < 5 || length > maximumBytes)
      )
        throw new Error("双语 PDF 文件大小无效");
      const handle = await open(temporary, "wx", 0o600);
      owned = true;
      let bytes = 0;
      let signature = Buffer.alloc(0);
      const reader = response.body.getReader();
      const abortReader = () => {
        void reader.cancel().catch(() => {});
      };
      init.signal?.addEventListener("abort", abortReader, { once: true });
      try {
        while (true) {
          if (!active()) throw new Error("导出已取消");
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > maximumBytes || (length !== null && bytes > length))
            throw new Error("双语 PDF 文件大小无效");
          if (signature.length < 5)
            signature = Buffer.concat([signature, value]).subarray(0, 5);
          // FileHandle.write may be short; writeFile finishes this chunk.
          await handle.writeFile(value);
        }
        if (
          signature.toString("ascii") !== "%PDF-" ||
          (length !== null && length !== bytes)
        )
          throw new Error("双语 PDF 下载不完整");
        await handle.sync();
      } finally {
        init.signal?.removeEventListener("abort", abortReader);
        await reader.cancel().catch(() => {});
        await handle.close();
      }
      await ready();
      await regularTarget(destination);
      if ((await realpath(dirname(path))) !== parent)
        throw new Error("保存目录已变化，请重新选择");
      if (!active()) throw new Error("导出已取消");
      // Keep the last cancellation check and atomic commit in one event turn.
      renameSync(temporary, destination);
      owned = false;
    } finally {
      if (owned) await unlink(temporary).catch(() => {});
    }
  }
}
