import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BilingualPDFSaveService,
  type BilingualPDFSaveHost,
} from "./bilingual-pdf-export";
import { open } from "node:fs/promises";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let dir: string, library: string, destination: string;
const request = { documentId: "doc-1", jobId: "job-1" };
const ready = () =>
  Response.json({
    id: "job-1",
    status: "ready",
    preflight: { pages: 2, outputPages: 2 },
  });
const frame = { url: "http://127.0.0.1:9000/" };
const contents = { mainFrame: frame };
const event = { sender: contents, senderFrame: frame };
let host: BilingualPDFSaveHost;
let service: BilingualPDFSaveService;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reader-bilingual-save-"));
  library = join(dir, "library");
  await mkdir(library);
  destination = join(dir, "export.pdf");
  host = {
    context: () => ({
      contents,
      appURL: frame.url,
      serverURL: "http://127.0.0.1:8000",
      token: "test-token",
      library,
      available: true,
    }),
    choose: vi.fn(async () => destination),
    fetch: vi.fn(async (url) =>
      url.endsWith("/file")
        ? new Response("%PDF-1.7\ncomplete", {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Length": "17",
            },
          })
        : ready(),
    ),
  };
  service = new BilingualPDFSaveService(host);
});
afterEach(async () => {
  await service.stop();
  await rm(dir, { recursive: true, force: true });
});

it("uses authenticated fixed local routes and atomically replaces the native chosen file", async () => {
  await writeFile(destination, "existing");
  expect(await service.save(event, request)).toEqual({
    saved: true,
    fileName: "export.pdf",
  });
  expect(await readFile(destination, "utf8")).toBe("%PDF-1.7\ncomplete");
  const calls = vi.mocked(host.fetch).mock.calls;
  expect(
    calls.every(
      ([url, init]) =>
        url.startsWith(
          "http://127.0.0.1:8000/api/documents/doc-1/bilingual-pdf/job-1",
        ) &&
        new Headers(init?.headers).get("Authorization") === "Bearer test-token",
    ),
  ).toBe(true);
  expect(await readdir(dir)).toEqual(["export.pdf", "library"]);
});
it("rejects subframes, foreign origins, arbitrary input fields and invalid IDs before the picker", async () => {
  for (const [sender, input] of [
    [{ ...event, senderFrame: { ...frame } }, request],
    [{ ...event, sender: {} }, request],
    [event, { ...request, path: destination }],
    [event, { ...request, jobId: "../escape" }],
  ] as const)
    await expect(service.save(sender, input)).rejects.toThrow();
  frame.url = "https://evil.example";
  host.context = () => ({
    contents,
    appURL: "http://127.0.0.1:9000",
    serverURL: "http://127.0.0.1:8000",
    token: "t",
    library,
    available: true,
  });
  await expect(service.save(event, request)).rejects.toThrow();
  frame.url = "http://127.0.0.1:9000/";
  expect(host.choose).not.toHaveBeenCalled();
});
it("native cancellation writes nothing and never downloads the file", async () => {
  host.choose = async () => null;
  expect(await service.save(event, request)).toEqual({ saved: false });
  expect(
    vi.mocked(host.fetch).mock.calls.some(([url]) => url.endsWith("/file")),
  ).toBe(false);
  expect(await readdir(dir)).toEqual(["library"]);
});
it("preserves the existing destination and cleans owned temporary files on a broken stream", async () => {
  await writeFile(destination, "original");
  host.fetch = async (url) =>
    url.endsWith("/file")
      ? new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("%PDF-"));
              c.error(new Error("broken"));
            },
          }),
          { headers: { "Content-Type": "application/pdf" } },
        )
      : ready();
  await expect(service.save(event, request)).rejects.toThrow();
  expect(await readFile(destination, "utf8")).toBe("original");
  expect(await readdir(dir)).toEqual(["export.pdf", "library"]);
});
it("preserves the destination and removes the owned temp when disk writes fail", async () => {
  await writeFile(destination, "original");
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    return handle;
  });
  await expect(service.save(event, request)).rejects.toThrow(
    "保存双语 PDF 失败",
  );
  expect(await readFile(destination, "utf8")).toBe("original");
  expect(await readdir(dir)).toEqual(["export.pdf", "library"]);
});
it.each(["text/html", "application/pdf"])(
  "rejects invalid or truncated output (%s)",
  async (type) => {
    await writeFile(destination, "original");
    host.fetch = async (url) =>
      url.endsWith("/file")
        ? new Response("not a pdf", {
            headers: { "Content-Type": type, "Content-Length": "100" },
          })
        : ready();
    await expect(service.save(event, request)).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("original");
  },
);
it("rejects managed library destinations and aliases into it", async () => {
  destination = join(library, "original.pdf");
  await writeFile(destination, "user source");
  await expect(service.save(event, request)).rejects.toThrow();
  const alias = join(dir, "alias");
  await symlink(library, alias, "dir");
  destination = join(alias, "other.pdf");
  await expect(service.save(event, request)).rejects.toThrow();
  expect(await readFile(join(library, "original.pdf"), "utf8")).toBe(
    "user source",
  );
});
it("rejects symlinks and nonregular destinations", async () => {
  const target = join(dir, "source.pdf");
  await writeFile(target, "source");
  await symlink(target, destination);
  await expect(service.save(event, request)).rejects.toThrow();
  destination = library;
  await expect(service.save(event, request)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("source");
});
it("blocks duplicate clicks and a cancelled late picker", async () => {
  let choose!: (path: string) => void;
  host.choose = () =>
    new Promise((resolve) => {
      choose = resolve;
    });
  const pending = service.save(event, request);
  await vi.waitFor(() => expect(choose).toBeTypeOf("function"));
  expect(await service.save(event, request)).toEqual({ saved: false });
  await service.cancel(event, request);
  choose(destination);
  expect(await pending).toEqual({ saved: false });
  expect(await readdir(dir)).toEqual(["library"]);
});
it("stop prevents a late picker and a cancelled request from starting again", async () => {
  let choose!: (path: string) => void;
  host.choose = () =>
    new Promise((resolve) => {
      choose = resolve;
    });
  const pending = service.save(event, request);
  await vi.waitFor(() => expect(choose).toBeTypeOf("function"));
  await service.stop();
  choose(destination);
  expect(await pending).toEqual({ saved: false });
  expect(await service.save(event, request)).toEqual({ saved: false });
  expect(await readdir(dir)).toEqual(["library"]);
});
it("does not commit a download after source deletion or library context change", async () => {
  let statusCalls = 0;
  host.fetch = async (url) =>
    url.endsWith("/file")
      ? new Response("%PDF-1.7\ncomplete", {
          headers: { "Content-Type": "application/pdf" },
        })
      : ++statusCalls === 1
        ? ready()
        : new Response(null, { status: 404 });
  await expect(service.save(event, request)).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["library"]);
  const original = host.context;
  host.choose = async () => {
    host.context = () => ({ ...original(), library: join(dir, "new-library") });
    return destination;
  };
  statusCalls = 0;
  expect(await service.save(event, request)).toEqual({ saved: false });
  expect(await readdir(dir)).toEqual(["library"]);
});
it("suggests mode-specific filenames from trusted preflight geometry", async () => {
  await service.save(event, request);
  expect(host.choose).toHaveBeenLastCalledWith("双语导出-并排.pdf");
  const original = host.fetch;
  host.fetch = (url, init) =>
    url.endsWith("/file")
      ? original(url, init)
      : Promise.resolve(
          Response.json({
            status: "ready",
            preflight: { pages: 2, outputPages: 4 },
          }),
        );
  await service.save(event, request);
  expect(host.choose).toHaveBeenLastCalledWith("双语导出-交替.pdf");
});
it("cancellation expires with the server job lifetime while a delayed picker stays invalidated", async () => {
  const now = Date.now();
  const time = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await service.cancel(event, request);
    expect(await service.save(event, request)).toEqual({ saved: false });
    time.mockReturnValue(now + 31 * 60 * 1000);
    expect(await service.save(event, request)).toEqual({
      saved: true,
      fileName: "export.pdf",
    });
  } finally {
    time.mockRestore();
  }
});
it("aborts an outstanding stream and joins temporary-file cleanup before stop returns", async () => {
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  host.fetch = async (url) =>
    url.endsWith("/file")
      ? new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new TextEncoder().encode("%PDF-"));
              reading();
              return new Promise(() => {});
            },
          }),
          { headers: { "Content-Type": "application/pdf" } },
        )
      : ready();
  const pending = service.save(event, request);
  await started;
  await service.stop();
  expect(await pending).toEqual({ saved: false });
  expect(await readdir(dir)).toEqual(["library"]);
});
