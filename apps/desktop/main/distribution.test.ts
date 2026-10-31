import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectRelease } from "./updates";
import { devIsolation } from "./dev-isolation";
import { isInterleafLink } from "./command-line";
import {
  interleafLink,
  parseInterleafLink,
} from "../../../packages/interleaf-core/src/interleaf-link";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("downloads independent Windows updates from Tazewell/Interleaf", () => {
  const result = selectRelease(
    { tag_name: "v0.9.0" },
    "0.8.7",
    "win32",
    "x64",
    `${"a".repeat(64)}  Interleaf-0.9.0-win-x64.exe\n`,
  );
  expect(result).toMatchObject({
    status: "available",
    update: {
      installer: "Interleaf-0.9.0-win-x64.exe",
      downloadURL:
        "https://github.com/Tazewell/Interleaf/releases/download/v0.9.0/Interleaf-0.9.0-win-x64.exe",
      checksumURL:
        "https://github.com/Tazewell/Interleaf/releases/download/v0.9.0/SHA256SUMS.txt",
    },
  });
});

it("isolates development data from the original application", () => {
  expect(devIsolation({ isPackaged: false, env: {} }).userDataDirectory).toBe(
    "Interleaf Dev",
  );
});

it("creates Interleaf links and refuses the original application protocol", () => {
  const id = "a".repeat(32);
  expect(interleafLink({ id, page: 2 })).toBe(`interleaf://open?id=${id}&page=2`);
  expect(parseInterleafLink(`reader://open?id=${id}`)).toBeNull();
});

it("does not claim a command installed by another application", async () => {
  const directory = await mkdtemp(join(tmpdir(), "interleaf-ownership-"));
  temporary.push(directory);
  const bundle = join(directory, "Other.app");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleIdentifier</key><string>io.github.legacy.interleaf</string></dict></plist>",
  );
  expect(
    await isInterleafLink(join(bundle, "Contents/Resources/bin/interleaf")),
  ).toBe(false);
});
