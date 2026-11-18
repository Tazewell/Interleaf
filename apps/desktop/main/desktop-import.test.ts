import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopImportService } from "./desktop-import";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "interleaf-import-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function file(name: string) {
  const path = join(directory, name);
  await writeFile(path, "sample data");
  return path;
}

it("reports every selected file and refreshes the library once after partial success", async () => {
  const paths = [
    await file("ready.pdf"),
    join(directory, "missing.pdf"),
    await file("already.pdf"),
    await file("long.pdf"),
    await file("bad.pdf"),
  ];
  const submit = vi.fn(async (form: FormData) => {
    const name = (form.get("file") as File).name;
    expect(form.get("smartCategory")).toBe("paper");
    if (name === "ready.pdf")
      return Response.json({ id: "ready", library: "papers" }, { status: 201 });
    if (name === "already.pdf")
      return Response.json({ id: "already", library: "books" });
    if (name === "long.pdf")
      return Response.json(
        { code: "large-paper", pages: 122 },
        { status: 409 },
      );
    return Response.json({ error: "文件损坏" }, { status: 400 });
  });
  const refresh = vi.fn();
  const service = new DesktopImportService(submit, refresh);

  expect(await service.importPaths(paths, "papers", "smart:paper")).toEqual([
    {
      status: "imported",
      name: "ready.pdf",
      documentId: "ready",
      library: "papers",
    },
    {
      status: "failed",
      name: "missing.pdf",
      message: expect.any(String),
      retryId: expect.any(String),
    },
    {
      status: "elsewhere",
      name: "already.pdf",
      documentId: "already",
      library: "books",
    },
    {
      status: "large",
      name: "long.pdf",
      pages: 122,
      retryId: expect.any(String),
    },
    {
      status: "failed",
      name: "bad.pdf",
      message: "文件损坏",
      retryId: expect.any(String),
    },
  ]);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("claims retry IDs once and keeps failed-file retry separate from large-file approval", async () => {
  const lost = join(directory, "lost.pdf");
  const long = await file("long.pdf");
  const submit = vi.fn(async (form: FormData) => {
    const name = (form.get("file") as File).name;
    if (name === "long.pdf" && form.get("allowLarge") !== "1")
      return Response.json(
        { code: "large-paper", pages: 200 },
        { status: 409 },
      );
    return Response.json(
      { id: name, library: form.get("library") },
      { status: 201 },
    );
  });
  const service = new DesktopImportService(submit, () => {});
  const [failed, large] = await service.importPaths([lost, long], "papers");
  await writeFile(lost, "now readable");
  expect(await service.retry([large.retryId!], "failed", "papers")).toEqual([]);
  expect(await service.retry([failed.retryId!], "large", "papers")).toEqual([]);

  const id = failed.retryId!;
  const [first, duplicate] = await Promise.all([
    service.retry([id, id], "failed", "papers"),
    service.retry([id], "failed", "papers"),
  ]);
  expect(first).toEqual([
    {
      status: "imported",
      name: "lost.pdf",
      documentId: "lost.pdf",
      library: "papers",
    },
  ]);
  expect(duplicate).toEqual([]);
  expect(submit.mock.calls[1][0].get("allowLarge")).toBeNull();

  expect(await service.retry([large.retryId!], "large", "books")).toEqual([
    {
      status: "imported",
      name: "long.pdf",
      documentId: "long.pdf",
      library: "books",
    },
  ]);
  expect(submit.mock.calls[2][0].get("allowLarge")).toBe("1");
});

it("distinguishes an existing document and releases explicitly discarded retries", async () => {
  const present = await file("present.pdf");
  const missing = join(directory, "missing.pdf");
  const submit = vi.fn(async () =>
    Response.json({ id: "present", library: "papers" }),
  );
  const service = new DesktopImportService(submit, () => {});
  const [existing, failed] = await service.importPaths(
    [present, missing],
    "papers",
  );
  expect(existing).toEqual({
    name: "present.pdf",
    status: "existing",
    documentId: "present",
    library: "papers",
  });
  service.discard([failed.retryId!]);
  await writeFile(missing, "now readable");
  expect(await service.retry([failed.retryId!], "failed", "papers")).toEqual(
    [],
  );
  expect(submit).toHaveBeenCalledTimes(1);
});
