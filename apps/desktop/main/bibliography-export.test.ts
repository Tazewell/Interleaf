import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureBibliographyExport } from "./bibliography-export";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function directory() {
  const p = await mkdtemp(join(tmpdir(), "interleaf-bib-export-"));
  directories.push(p);
  return p;
}

it("takes the output path only from the native chooser and normalizes options", async () => {
  const path = join(await directory(), "references.bib");
  let sent: unknown;
  const result = await configureBibliographyExport(
    {
      folder: "Research/Paper",
      mode: "biblatex",
      path: "/untrusted/overwrite.bib",
    },
    {
      choose: async (name) => {
        expect(name).toBe("Paper.bib");
        return path;
      },
      confirmTakeover: async () => {
        throw new Error("unexpected takeover");
      },
      register: async (target) => {
        sent = target;
        return { id: "managed" };
      },
    },
  );
  expect(sent).toEqual({
    folder: "Research/Paper",
    includeChildren: true,
    mode: "biblatex",
    path,
    takeover: false,
  });
  expect(result).toEqual({ id: "managed" });
});

it("leaves an existing bibliography untouched when takeover is declined", async () => {
  const path = join(await directory(), "manual.bib");
  await writeFile(path, "hand-maintained bibliography");
  const result = await configureBibliographyExport(
    { folder: "Paper", includeChildren: false, mode: "bibtex" },
    {
      choose: async () => path,
      confirmTakeover: async (chosen) => {
        expect(chosen).toBe(path);
        return false;
      },
      register: async () => {
        throw new Error("declined target was registered");
      },
    },
  );
  expect(result).toBeNull();
  expect(await readFile(path, "utf8")).toBe("hand-maintained bibliography");
});

it("requires explicit takeover for an existing file without modifying it in main", async () => {
  const path = join(await directory(), "existing.bib");
  await writeFile(path, "existing data");
  let takeover = false;
  await configureBibliographyExport(
    { folder: "Paper", mode: "bibtex" },
    {
      choose: async () => path,
      confirmTakeover: async () => true,
      register: async (target) => {
        takeover = target.takeover;
        return target;
      },
    },
  );
  expect(takeover).toBe(true);
  expect(await readFile(path, "utf8")).toBe("existing data");
});

it("rejects invalid options before opening a dialog and handles cancellation", async () => {
  const host = {
    choose: async () => {
      throw new Error("dialog should stay closed");
    },
    confirmTakeover: async () => false,
    register: async () => {
      throw new Error("no target");
    },
  };
  await expect(
    configureBibliographyExport({ mode: "shell", folder: "Paper" }, host),
  ).rejects.toThrow();
  await expect(
    configureBibliographyExport({ mode: "bibtex", folder: 3 }, host),
  ).rejects.toThrow();
  expect(
    await configureBibliographyExport(
      { mode: "bibtex", folder: "Paper" },
      { ...host, choose: async () => null },
    ),
  ).toBeNull();
});

it("refuses a symlink chosen as an output without touching its target", async () => {
  const parent = await directory();
  const real = join(parent, "real.bib"),
    link = join(parent, "link.bib");
  await writeFile(real, "original");
  await symlink(real, link);
  await expect(
    configureBibliographyExport(
      { mode: "bibtex", folder: "Paper" },
      {
        choose: async () => link,
        confirmTakeover: async () => true,
        register: async () => {
          throw new Error("symlink registered");
        },
      },
    ),
  ).rejects.toThrow();
  expect(await readFile(real, "utf8")).toBe("original");
});
