import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { execFile } from "node:child_process";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import type { Region } from "./layout";
import { blockCropBounds } from "./render-page";

// Windows PowerShell 5.1 projects the built-in WinRT OCR API. The fixed script
// receives a private crop path as data and only uses installed OCR languages.
const recognizeTitle = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult,Windows.Media.Ocr,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
    $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation')
} | Select-Object -First 1
function Wait-WinRT($operation, $type) {
  $task = $asTask.MakeGenericMethod(@($type)).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
$languages = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
$english = $languages | Where-Object { $_.LanguageTag -like 'en-*' } | Select-Object -First 1
if ($english) {
  $ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($english)
}
if (!$ocr) { $ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (!$ocr -and $languages.Count -gt 0) {
  $ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($languages[0])
}
if (!$ocr) { exit 0 }
$file = Wait-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:INTERLEAF_PAPER_TITLE_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Wait-WinRT ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
$decoder = Wait-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Wait-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
(Wait-WinRT ($ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])).Text
`;

const command = Buffer.from(recognizeTitle, "utf16le").toString("base64");
const titleCropMaxWidth = 2400;
const titleCropMaxHeight = 900;

function titleText(text: string) {
  const title = text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(
      /(?<=[\p{Script=Latin}\d])\s*[：:]\s*(?=[\p{Script=Latin}\d])/gu,
      ": ",
    );
  const letters = title.match(/\p{L}/gu)?.length ?? 0;
  if (title.length > 300 || /\p{Cc}/u.test(title)) return;
  if (
    /(?:[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]\s*){4}/u.test(
      title,
    )
  )
    return title;
  if (letters >= 12 && title.includes(" ")) return title;
}

/** Use a single high-confidence title block on the first page of an image-only paper. */
export async function scanPaperTitle(
  canvas: Canvas,
  regions: Region[],
  output: string,
): Promise<string | undefined> {
  if (process.platform !== "win32") return;
  const titles = regions.filter(
    ({ label, confidence, bounds: { x, y, width, height } }) =>
      label === "doc_title" &&
      confidence >= 0.7 &&
      [x, y, width, height].every(Number.isFinite) &&
      x >= 0 &&
      y >= 0 &&
      y < 0.42 &&
      width > 0 &&
      height > 0 &&
      height < 0.18 &&
      x + width <= 1 &&
      y + height <= 1,
  );
  if (titles.length !== 1) return;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  if (!win32.isAbsolute(systemRoot)) return;
  const executable = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let directory: string | undefined;
  try {
    const bounds = blockCropBounds(
      titles[0].bounds,
      canvas.width,
      canvas.height,
    );
    // Preserve surrounding whitespace before upscaling small print.
    const margin = 7;
    const x = Math.max(0, bounds.x - margin);
    const y = Math.max(0, bounds.y - margin);
    const width = Math.min(canvas.width, bounds.x + bounds.width + margin) - x;
    const height =
      Math.min(canvas.height, bounds.y + bounds.height + margin) - y;
    const scale = Math.min(
      1.25,
      titleCropMaxWidth / width,
      titleCropMaxHeight / height,
    );
    const crop = createCanvas(
      Math.ceil(width * scale),
      Math.ceil(height * scale),
    );
    crop
      .getContext("2d")
      .drawImage(canvas, x, y, width, height, 0, 0, crop.width, crop.height);
    directory = await mkdtemp(join(output, ".title-ocr-"));
    const path = join(directory, "title.png");
    await writeFile(path, crop.toBuffer("image/png"), { mode: 0o600 });
    const text = await new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          command,
        ],
        {
          cwd: output,
          env: { ...process.env, INTERLEAF_PAPER_TITLE_IMAGE: path },
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 16 * 1024,
          encoding: "utf8",
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    return titleText(text);
  } catch {
    // Missing language packs, blocked PowerShell or OCR failure do not fail import.
    return;
  } finally {
    if (directory) {
      await rm(join(directory, "title.png"), { force: true }).catch(() => {});
      await rmdir(directory).catch(() => {});
    }
  }
}
