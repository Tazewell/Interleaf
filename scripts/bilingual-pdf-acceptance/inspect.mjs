// Reopen every successful sample with PDF.js, then render every page in Poppler.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const require = createRequire(
  new URL("../../apps/processor/package.json", import.meta.url),
);
const { DOMMatrix, ImageData, Path2D } = require("@napi-rs/canvas");
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const { getDocument, Util } = await import(
  pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))
);
const out = process.argv[2],
  result = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
assert.equal(
  result.passed,
  true,
  "HTTP/native lifecycle acceptance did not complete",
);
const normalized = (s) => s.replace(/\s+/gu, "");
const assets = dirname(require.resolve("pdfjs-dist/package.json"));
const open = async (path) =>
  getDocument({
    data: new Uint8Array(await readFile(path)),
    useSystemFonts: false,
    cMapUrl: join(assets, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(assets, "standard_fonts") + "/",
    wasmUrl: join(assets, "wasm") + "/",
  });
const geometry = JSON.parse(
  await readFile(join(out, "geometry-expected.json"), "utf8"),
);
let rendered = 0;
for (const entry of result.exports) {
  const prepared = JSON.parse(
    await readFile(join(entry.evidence, "prepared.json"), "utf8"),
  );
  const targets = JSON.parse(
    await readFile(join(entry.evidence, "targets.json"), "utf8"),
  );
  const pdfTask = await open(entry.file),
    sourceTask = await open(entry.source);
  const pdf = await pdfTask.promise,
    source = await sourceTask.promise;
  try {
    const alternating = entry.mode === "alternating";
    assert.equal(pdf.numPages, prepared.pages.length * (alternating ? 2 : 1));
    for (const [i, p] of prepared.pages.entries()) {
      if (entry.name === "geometry") {
        const expected = geometry[i];
        assert.equal(p.rotation, expected.rotation);
        assert.deepEqual(p.cropBox, expected.cropBox);
        assert.equal(p.width, expected.width);
        assert.equal(p.height, expected.height);
      }
      const original = await pdf.getPage(alternating ? i * 2 + 1 : i + 1),
        translated = alternating ? await pdf.getPage(i * 2 + 2) : original;
      const view = translated.getViewport({ scale: 1 });
      assert.equal(view.width, alternating ? p.width : p.width * 2 + 12);
      assert.equal(view.height, p.height);
      if (alternating) {
        const v = original.getViewport({ scale: 1 });
        assert.equal(v.width, p.width);
        assert.equal(v.height, p.height);
      }
      const items = (await translated.getTextContent()).items.filter(
        (x) => "str" in x,
      );
      const translatedItems = items.filter(
        (item) =>
          alternating ||
          Util.transform(view.transform, item.transform)[4] >=
            p.width + 12 - 0.01,
      );
      const translatedText = normalized(
        translatedItems.map((item) => item.str).join(""),
      );
      assert.match(translatedText, /[\u3400-\u9fff]/u);
      assert.doesNotMatch(translatedText, /\{v\d+\}/u);
      for (const paragraph of p.paragraphs) {
        assert.ok(
          !translatedText.includes(normalized(paragraph.originalSource)),
          `hidden English remains: ${paragraph.id}`,
        );
        const expected = normalized(
          targets[paragraph.id].replace(/\{v\d+\}/g, ""),
        );
        assert.ok(
          translatedText.includes(expected),
          `missing searchable target: ${paragraph.id}`,
        );
      }
      const sourcePage = await source.getPage(p.page),
        sourceItems = (await sourcePage.getTextContent()).items.filter(
          (x) => "str" in x,
        );
      const originalItems = (await original.getTextContent()).items.filter(
        (item) =>
          "str" in item &&
          (alternating ||
            Util.transform(
              original.getViewport({ scale: 1 }).transform,
              item.transform,
            )[4] < p.width),
      );
      assert.deepEqual(
        originalItems.map((x) => x.str).filter(Boolean),
        sourceItems.map((x) => x.str).filter(Boolean),
        "original text/order changed",
      );
      const fontSizes = translatedItems
        .filter((x) => /[\u3400-\u9fff]/u.test(x.str))
        .map((x) =>
          Math.hypot(
            ...Util.transform(view.transform, x.transform).slice(2, 4),
          ),
        );
      assert.ok(
        fontSizes.length && Math.min(...fontSizes) >= 8.99,
        "translated text below 9pt",
      );
    }
    const fonts = execFileSync("pdffonts", [entry.file], { encoding: "utf8" });
    assert.match(fonts, /CID TrueType.*yes\s+yes\s+yes/);
    await writeFile(join(entry.evidence, "pdffonts.txt"), fonts);
    const render = join(entry.evidence, "render");
    await mkdir(render, { recursive: true });
    execFileSync(
      "pdftoppm",
      ["-r", "72", "-png", entry.file, join(render, "page")],
      { stdio: "pipe" },
    );
    entry.inspection = {
      pages: pdf.numPages,
      dimensions: prepared.pages.map((p) => [p.width, p.height]),
      searchableTargets: true,
      noHiddenEnglish: true,
      originalTextOrder: true,
      embeddedSubsetUnicodeFont: true,
      minimumTextSize: 9,
    };
    rendered += pdf.numPages;
    console.log(
      entry.name,
      entry.mode,
      `${pdf.numPages} pages: dimensions/order/text/font/9pt PASS; all pages rendered`,
    );
  } finally {
    await pdfTask.destroy();
    await sourceTask.destroy();
  }
}
result.renderedPages = rendered;
await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(
  `Reopened 4 exports, rendered ${rendered} pages. PNG appearance still requires human/image review.`,
);
