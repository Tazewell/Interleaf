import { createCanvas, loadImage } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Region } from "./layout";
import { scanPaperTitle } from "./paper-title-ocr";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));

const windowsRoot = "D:\\Windows";
const titleRegion: Region = {
  label: "doc_title",
  confidence: 0.86,
  order: 0,
  bounds: { x: 0.12, y: 0.15, width: 0.44, height: 0.02 },
};
let output: string;

beforeEach(async () => {
  output = await mkdtemp(join(tmpdir(), "interleaf-title-test-"));
  execFile.mockReset();
  vi.stubGlobal("process", {
    ...process,
    platform: "win32",
    env: { SystemRoot: windowsRoot },
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rmdir(output);
});

it("passes only the identified title crop to local Windows OCR and cleans it up", async () => {
  const canvas = createCanvas(1200, 1600);
  let dimensions: [number, number] | undefined;
  let imagePath: string | undefined;
  execFile.mockImplementation(async (_executable, _args, options, callback) => {
    imagePath = options.env.INTERLEAF_PAPER_TITLE_IMAGE;
    const image = await loadImage(imagePath!);
    dimensions = [image.width, image.height];
    callback(null, "Judgment under Uncertainty ： Heuristics and Biases\n");
  });

  await expect(scanPaperTitle(canvas, [titleRegion], output)).resolves.toBe(
    "Judgment under Uncertainty: Heuristics and Biases",
  );
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    windowsRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      expect.any(String),
    ],
    expect.objectContaining({ cwd: output, windowsHide: true, timeout: 5000 }),
    expect.any(Function),
  );
  expect(dimensions?.[0]).toBeGreaterThan(528);
  expect(dimensions?.[0]).toBeLessThan(1000);
  expect(dimensions?.[1]).toBeGreaterThan(32);
  expect(dimensions?.[1]).toBeLessThan(90);
  expect(dirname(dirname(imagePath!))).toBe(output);
  expect(existsSync(imagePath!)).toBe(false);
  expect(await readdir(output)).toEqual([]);
});

it("skips ambiguous, low-confidence and invalid regions", async () => {
  const canvas = createCanvas(1200, 1600);
  // If an invalid region reaches the subprocess, the test should fail promptly.
  execFile.mockImplementation((_executable, _args, _options, callback) =>
    callback(null, "Invalid geometry should not produce a title"),
  );
  const alternate = {
    ...titleRegion,
    bounds: { ...titleRegion.bounds, y: 0.3 },
  };
  await expect(
    scanPaperTitle(canvas, [titleRegion, alternate], output),
  ).resolves.toBeUndefined();
  await expect(
    scanPaperTitle(canvas, [{ ...titleRegion, confidence: 0.55 }], output),
  ).resolves.toBeUndefined();
  await expect(
    scanPaperTitle(
      canvas,
      [{ ...titleRegion, bounds: { ...titleRegion.bounds, width: 0 } }],
      output,
    ),
  ).resolves.toBeUndefined();
  await expect(
    scanPaperTitle(
      canvas,
      [{ ...titleRegion, bounds: { ...titleRegion.bounds, x: 0.8 } }],
      output,
    ),
  ).resolves.toBeUndefined();
  expect(execFile).not.toHaveBeenCalled();
});

it("does not launch OCR on other platforms", async () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  await expect(
    scanPaperTitle(createCanvas(1200, 1600), [titleRegion], output),
  ).resolves.toBeUndefined();
  expect(execFile).not.toHaveBeenCalled();
});

it("leaves title unset and removes the crop when the OCR process fails", async () => {
  execFile.mockImplementation((_executable, _args, _options, callback) =>
    callback(new Error("OCR unavailable")),
  );
  await expect(
    scanPaperTitle(createCanvas(1200, 1600), [titleRegion], output),
  ).resolves.toBeUndefined();
  expect(await readdir(output)).toEqual([]);
});
