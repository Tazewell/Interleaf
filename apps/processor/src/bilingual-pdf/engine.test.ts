import { afterEach, expect, it, vi } from "vitest";
import type { SKRSContext2D } from "@napi-rs/canvas";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";
import { prepareNativePDF } from "./prepare";
import { renderNativePDF } from "./compose";
import { protectFormulas, validateFormulaTokens } from "./formula";
import { fitParagraph } from "./layout";
import { openPDF, loadFont } from "./runtime";

const dirs: string[] = [];
it("prepares and renders literal prose braces with real embedded font in both layouts", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const source = 'Use {} {name} {value} {"a":{"b":1}} open { and close }.';
  doc.addPage([600, 250]).drawText(source, { x: 20, y: 180, size: 12, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "braces",
          page: 1,
          label: "text",
          bounds: { x: 0.02, y: 0.15, width: 0.96, height: 0.5 },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    p = prepared.pages[0].paragraphs[0];
  expect(p.source).toBe(source);
  expect(p.formulas).toEqual([]);
  const target = '文本 {} {name} {value} {"a":{"b":1}} 打开 { 关闭 }。';
  for (const layout of ["alternating", "side-by-side"] as const) {
    const output = join(f.dir, `braces-${layout}.pdf`);
    await renderNativePDF({
      ...f,
      prepared,
      targets: { [p.id]: target },
      layout,
      output,
    });
    const task = await openPDF(output);
    try {
      const pdf = await task.promise,
        page = await pdf.getPage(layout === "alternating" ? 2 : 1);
      const text = (await page.getTextContent()).items
        .map((i) => ("str" in i ? i.str : ""))
        .join("");
      expect(text.replace(/\s/g, "")).toContain(target.replace(/\s/g, ""));
      if (layout === "alternating") expect(text).not.toContain("Use");
      const result = await PDFDocument.load(await readFile(output));
      expect(
        result.context
          .enumerateIndirectObjects()
          .some(([, o]) => o.toString().includes("/FontFile2")),
      ).toBe(true);
    } finally {
      await task.destroy();
    }
  }
  const collision = await PDFDocument.create();
  collision.addPage([600, 250]).drawText("Use {v0} literally.", { x: 20, y: 180, size: 12, font: await collision.embedFont(StandardFonts.Helvetica) });
  const collisionBytes = await collision.save();
  await writeFile(f.input, collisionBytes);
  const manifest = JSON.parse(await readFile(f.layout, "utf8"));
  manifest.inputSHA256 = createHash("sha256").update(collisionBytes).digest("hex");
  await writeFile(f.layout, JSON.stringify(manifest));
  await expect(prepareNativePDF(f)).rejects.toThrow(/原文.*公式协议/);
}, 30000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
it("uses per-position TJ/Tc/Tw/Tz geometry for a mixed item's formula crop and restored ink", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([300, 200]);
  p.node.set(
    PDFName.of("Resources"),
    doc.context.obj({ Font: { F1: font.ref } }),
  );
  p.node.set(
    PDFName.of("Contents"),
    doc.context.register(
      doc.context.flateStream(
        "BT /F1 12 Tf 1 Tc 2 Tw 125 Tz 1 0 0 1 20 140 Tm [(Prefix a) -120 (=b) -50 ( suffix)] TJ ET",
      ),
    ),
  );
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: { x: 0.02, y: 0.15, width: 0.96, height: 0.5 },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    para = prepared.pages[0].paragraphs[0],
    formula = para.formulas[0];
  const expectedX = 20 + (font.widthOfTextAtSize("Prefix ", 12) + 7 + 2) * 1.25;
  const expectedWidth = (font.widthOfTextAtSize("a=b", 12) + 2 + 1.44) * 1.25;
  expect(para.formulas).toHaveLength(1);
  expect(formula.bounds.x).toBeCloseTo(expectedX, 3);
  expect(formula.bounds.width).toBeCloseTo(expectedWidth, 3);
  const output = join(f.dir, "tj.pdf"),
    target = "测试 {v0} 完成";
  await renderNativePDF({
    ...f,
    prepared,
    targets: { [para.id]: target },
    output,
    layout: "alternating",
  });
  const { font: targetFont } = await loadFont(await PDFDocument.create()),
    run = fitParagraph(para, target, targetFont).runs.find(
      (r) => r.kind === "formula",
    )!;
  const tasks = [await openPDF(f.input), await openPDF(output)],
    ink = [];
  try {
    const { createCanvas } = await import("@napi-rs/canvas"),
      scale = 300 / 72;
    for (let i = 0; i < 2; i++) {
      const page = await (await tasks[i].promise).getPage(i ? 2 : 1),
        canvas = createCanvas(1250, 834);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport: page.getViewport({ scale }),
        background: "white",
      }).promise;
      const b = i ? run : formula.bounds,
        pixels = canvas
          .getContext("2d")
          .getImageData(
            Math.ceil(b.x * scale),
            Math.ceil(b.y * scale),
            Math.floor(b.width * scale) - 1,
            Math.floor(b.height * scale) - 1,
          ).data;
      ink.push(pixels.filter((v, n) => n % 4 !== 3 && v < 128).length);
    }
    expect(ink[0]).toBeGreaterThan(300);
    expect(ink[1] / ink[0]).toBeGreaterThan(0.9);
    expect(ink[1] / ink[0]).toBeLessThan(1.1);
  } finally {
    for (const t of tasks) await t.destroy();
  }
}, 30000);
it("retains a mixed TextItem's nonuniform TJ offsets instead of distributing total width", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([300, 200]);
  p.node.set(
    PDFName.of("Resources"),
    doc.context.obj({ Font: { F1: font.ref } }),
  );
  p.node.set(
    PDFName.of("Contents"),
    doc.context.register(
      doc.context.flateStream(
        "BT /F1 12 Tf 0 Tc 0 Tw 100 Tz 1 0 0 1 20 140 Tm [(Prefix a) -100 (=b) 80 ( suffix)] TJ ET",
      ),
    ),
  );
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: { x: 0.02, y: 0.15, width: 0.96, height: 0.5 },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    para = prepared.pages[0].paragraphs[0],
    formula = para.formulas[0];
  const expectedX = 20 + font.widthOfTextAtSize("Prefix ", 12);
  const expectedWidth = font.widthOfTextAtSize("a=b", 12) + 1.2;
  expect(para.formulas).toHaveLength(1);
  expect(formula.bounds.x).toBeCloseTo(expectedX, 3);
  expect(formula.bounds.width).toBeCloseTo(expectedWidth, 3);
  const output = join(f.dir, "tj.pdf"),
    target = "测试 {v0} 完成";
  await renderNativePDF({
    ...f,
    prepared,
    targets: { [para.id]: target },
    output,
    layout: "alternating",
  });
  const { font: targetFont } = await loadFont(await PDFDocument.create()),
    run = fitParagraph(para, target, targetFont).runs.find(
      (r) => r.kind === "formula",
    )!;
  const tasks = [await openPDF(f.input), await openPDF(output)],
    ink = [];
  try {
    const { createCanvas } = await import("@napi-rs/canvas"),
      scale = 300 / 72;
    for (let i = 0; i < 2; i++) {
      const page = await (await tasks[i].promise).getPage(i ? 2 : 1),
        canvas = createCanvas(1250, 834);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport: page.getViewport({ scale }),
        background: "white",
      }).promise;
      const b = i ? run : formula.bounds,
        pixels = canvas
          .getContext("2d")
          .getImageData(
            Math.ceil(b.x * scale),
            Math.ceil(b.y * scale),
            Math.floor(b.width * scale) - 1,
            Math.floor(b.height * scale) - 1,
          ).data;
      ink.push(pixels.filter((v, n) => n % 4 !== 3 && v < 128).length);
    }
    expect(ink[0]).toBeGreaterThan(300);
    expect(ink[1] / ink[0]).toBeGreaterThan(0.9);
    expect(ink[1] / ink[0]).toBeLessThan(1.1);
  } finally {
    for (const t of tasks) await t.destroy();
  }
}, 30000);
it("embeds and releases every decoded raster before advancing pages without flushing evolving font subsets", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    blocks = [];
  for (let page = 1; page <= 6; page++) {
    doc
      .addPage([360, 360])
      .drawText("Body a=b", { x: 20, y: 300, size: 12, font });
    blocks.push({
      id: "b" + page,
      page,
      label: "text",
      bounds: { x: 0.03, y: 0.1, width: 0.9, height: 0.3 },
    });
  }
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 6,
      blocks,
    }),
  );
  const prepared = await prepareNativePDF(f),
    images: object[] = [],
    retained: number[] = [],
    fontSubsets: number[] = [],
    original = PDFDocument.prototype.embedPng;
  let outputDoc: PDFDocument | undefined;
  // Observe the actual pinned PDF-LIB decoder ownership; preserve every real call.
  vi.spyOn(PDFDocument.prototype, "embedPng").mockImplementation(
    async function (this: PDFDocument, ...args) {
      outputDoc = this;
      const image = await original.apply(this, args);
      images.push(image);
      return image;
    },
  );
  const targets = Object.fromEntries(
    prepared.pages.map((p, i) => [
      p.paragraphs[0].id,
      "字形" +
        "一二三四五六"[i] +
        " " +
        p.paragraphs[0].formulas.map((f) => f.token).join(" "),
    ]),
  );
  const output = join(f.dir, "bounded.pdf");
  await renderNativePDF(
    { ...f, prepared, targets, output, layout: "alternating" },
    (event) => {
      if (event.stage === "composing") {
        retained.push(
          images.reduce(
            (sum, image) =>
              sum +
              ((image as { embedder?: { image?: { rgbChannel?: Uint8Array } } })
                .embedder?.image?.rgbChannel?.byteLength ?? 0),
            0,
          ),
        );
        fontSubsets.push(
          outputDoc!.context
            .enumerateIndirectObjects()
            .filter(([, o]) => o.toString().includes("/FontFile2")).length,
        );
      }
    },
  );
  expect(retained).toHaveLength(6);
  expect(Math.max(...retained)).toBe(0);
  expect(fontSubsets).toEqual([0, 0, 0, 0, 0, 0]);
  const task = await openPDF(output);
  try {
    const pdf = await task.promise;
    for (let i = 0; i < 6; i++) {
      const page = await pdf.getPage(i * 2 + 2);
      expect(
        (await page.getTextContent()).items
          .map((t) => ("str" in t ? t.str : ""))
          .join(""),
      ).toContain("字形" + "一二三四五六"[i]);
    }
  } finally {
    await task.destroy();
  }
}, 30000);
it("extends a clipped inline detector to the full superscript glyph outer bounds", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([240, 200]);
  p.drawText("We use", { x: 20, y: 140, size: 12, font });
  p.drawText("x", { x: 80, y: 140, size: 12, font });
  p.drawText("2", { x: 86, y: 148, size: 7, font });
  p.drawText("here.", { x: 100, y: 140, size: 12, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: { x: 0.03, y: 0.2, width: 0.9, height: 0.4 },
        },
        {
          id: "math",
          page: 1,
          label: "inline_formula",
          bounds: {
            x: 79 / 240,
            y: 48 / 200,
            width: 15 / 240,
            height: 20 / 200,
          },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    para = prepared.pages[0].paragraphs[0];
  expect(para.formulas).toHaveLength(1);
  expect(para.formulas[0].bounds.y).toBeLessThan(46.5);
  expect(para.source).not.toContain("2");
  const output = join(f.dir, "superscript.pdf");
  await renderNativePDF({
    ...f,
    prepared,
    targets: { [para.id]: "测试 {v0} 完成" },
    output,
    layout: "alternating",
  });
  const { font: targetFont } = await loadFont(await PDFDocument.create()),
    run = fitParagraph(para, "测试 {v0} 完成", targetFont).runs.find(
      (r) => r.kind === "formula",
    )!;
  const tasks = [await openPDF(f.input), await openPDF(output)],
    ink = [];
  try {
    const { createCanvas } = await import("@napi-rs/canvas"),
      scale = 300 / 72;
    for (let i = 0; i < 2; i++) {
      const page = await (await tasks[i].promise).getPage(i ? 2 : 1),
        canvas = createCanvas(1000, 834);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport: page.getViewport({ scale }),
        background: "white",
      }).promise;
      const b = i ? run : para.formulas[0].bounds,
        pixels = canvas
          .getContext("2d")
          .getImageData(
            Math.ceil(b.x * scale),
            Math.ceil(b.y * scale),
            Math.floor(b.width * scale) - 1,
            Math.floor(6 * scale),
          ).data;
      ink.push(pixels.filter((v, n) => n % 4 !== 3 && v < 128).length);
    }
    expect(ink[0]).toBeGreaterThan(40);
    expect(ink[1] / ink[0]).toBeGreaterThan(0.8);
    expect(ink[1] / ink[0]).toBeLessThan(1.15);
  } finally {
    for (const t of tasks) await t.destroy();
  }
}, 30000);
it("rejects an unowned inline formula partly intersecting a body erase rectangle", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([240, 200]);
  p.drawText("Body", { x: 20, y: 140, size: 12, font });
  p.drawText("a=b", { x: 110, y: 140, size: 12, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: {
            x: 15 / 240,
            y: 40 / 200,
            width: 103 / 240,
            height: 40 / 200,
          },
        },
        {
          id: "unowned",
          page: 1,
          label: "inline_formula",
          bounds: {
            x: 109 / 240,
            y: 48 / 200,
            width: 30 / 240,
            height: 25 / 200,
          },
        },
      ],
    }),
  );
  await expect(prepareNativePDF(f)).rejects.toThrow(/公式.*归属|公式.*重叠/);
});
it("rejects a large-TJ equation whose left operand was split into an ambiguous body TextItem", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([300, 200]);
  p.node.set(
    PDFName.of("Resources"),
    doc.context.obj({ Font: { F1: font.ref } }),
  );
  p.node.set(
    PDFName.of("Contents"),
    doc.context.register(
      doc.context.flateStream(
        "BT /F1 12 Tf 1 Tc 2 Tw 125 Tz 1 0 0 1 20 140 Tm [(Prefix a) -800 (=b) -250 ( suffix)] TJ ET",
      ),
    ),
  );
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: { x: 0.02, y: 0.15, width: 0.96, height: 0.5 },
        },
      ],
    }),
  );
  await expect(prepareNativePDF(f)).rejects.toThrow(/公式.*文字项.*关联/);
});
it("groups a unique adjacent isolated Latin operand from a separate TextItem in the same body block", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([240, 200]);
  p.drawText("We use", { x: 20, y: 140, size: 12, font });
  p.drawText("a", {
    x: 80,
    y: 140,
    size: 12,
    font: await doc.embedFont(StandardFonts.Courier),
  });
  p.drawText("= b", { x: 88, y: 140, size: 12, font });
  p.drawText("here.", { x: 115, y: 140, size: 12, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: { x: 0.03, y: 0.2, width: 0.94, height: 0.4 },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    para = prepared.pages[0].paragraphs[0];
  expect(para.formulas).toHaveLength(1);
  expect(para.formulas[0].bounds.x).toBeCloseTo(80, 3);
  expect(para.formulas[0].bounds.width).toBeGreaterThan(20);
  expect(para.source).not.toMatch(/\ba\b/);
  expect(para.source).toContain("We use");
  expect(para.source).toContain("here.");
  await renderNativePDF({
    ...f,
    prepared,
    targets: { [para.id]: "此处使用 {v0} 。" },
    output: join(f.dir, "isolated.pdf"),
    layout: "alternating",
  });
}, 30000);
async function fixture(rotation = 0, unit = 1) {
  const dir = await mkdtemp(join(tmpdir(), "native-pdf-"));
  dirs.push(dir);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([240, 320]);
  p.setCropBox(20, 30, 200, 260);
  p.setRotation(degrees(rotation));
  p.node.set(PDFName.of("UserUnit"), PDFNumber.of(unit));
  p.drawText("Original body", { x: 40, y: 230, size: 12, font });
  p.drawRectangle({
    x: 175,
    y: 60,
    width: 20,
    height: 20,
    color: rgb(1, 0, 0),
  });
  p.node.set(
    PDFName.of("Annots"),
    doc.context.obj([
      {
        Type: "Annot",
        Subtype: "Link",
        Rect: [40, 220, 100, 240],
        A: { S: "URI", URI: "https://example.com" },
      },
    ]),
  );
  doc.addJavaScript("bad", "app.alert('bad')");
  const p2 = doc.addPage([300, 200]);
  p2.drawText("Second body", { x: 30, y: 140, size: 12, font });
  const bytes = await doc.save();
  const input = join(dir, "original.pdf");
  await writeFile(input, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const layout = join(dir, "manifest.json");
  // Normalized bounds are in the same PDF.js visible viewport as the existing layout pipeline.
  await writeFile(
    layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: sha,
      pages: 2,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: { x: 0.08, y: 0.12, width: 0.74, height: 0.34 },
        },
        {
          id: "body2",
          page: 2,
          label: "text",
          bounds: { x: 0.08, y: 0.15, width: 0.8, height: 0.4 },
        },
      ],
    }),
  );
  return { dir, input, layout };
}
it("protects math tokens and rejects missing, duplicate and unknown placeholders", () => {
  const formulas = [
    { token: "{v0}", bounds: { x: 1, y: 2, width: 20, height: 10 } },
  ];
  expect(validateFormulaTokens("结果 {v0} 成立", formulas)).toBeUndefined();
  for (const text of ["结果", "{v0}{v0}", "{v0}{v1}", "{v0}{V2}", "{v0}{v01}"])
    expect(() => validateFormulaTokens(text, formulas)).toThrow(/公式/);
});
it("allows set braces inside a protected formula and literal source prose", () => {
  const span = {
    text: "S={1,2}",
    math: true,
    fontSize: 12,
    bounds: { x: 10, y: 10, width: 45, height: 12 },
  };
  expect(protectFormulas([span])).toMatchObject({
    source: "{v0}",
    originalSource: "S={1,2}",
    formulas: [{ token: "{v0}" }],
  });
  expect(protectFormulas([{ ...span, math: false }])).toMatchObject({
    source: "S={1,2}",
    formulas: [],
  });
  expect(() =>
    protectFormulas([{ ...span, text: "Use {v0}", math: false }]),
  ).toThrow(/公式协议/);
});
it("measures CJK, retains Latin words and spaces, moves formulas inline and fails at the 9pt floor", async () => {
  const { font } = await loadFont(await PDFDocument.create());
  const paragraph = {
    id: "p1",
    page: 2,
    bounds: { x: 10, y: 20, width: 100, height: 80 },
    fontSize: 12,
    formulas: [
      { token: "{v0}", bounds: { x: 40, y: 40, width: 24, height: 12 } },
    ],
  };
  const fit = fitParagraph(paragraph, "中文 Latin word {v0} 后续文字", font);
  expect(fit.fontSize).toBeGreaterThanOrEqual(9);
  expect(
    fit.runs
      .filter((r) => r.kind === "text")
      .map((r) => r.text)
      .join(""),
  ).toBe("中文 Latin word  后续文字");
  expect(fit.runs.find((r) => r.kind === "formula")).toMatchObject({
    width: 24,
  });
  expect(fit.runs.every((r) => r.x + r.width <= 110.01)).toBe(true);
  expect(() =>
    fitParagraph(
      { ...paragraph, bounds: { x: 0, y: 0, width: 10, height: 8 } },
      "中文".repeat(200) + "{v0}",
      font,
    ),
  ).toThrow(/第 2 页.*p1.*9/);
  expect(() => fitParagraph(paragraph, "\u{10ffff}{v0}", font)).toThrow(/缺字/);
  expect(
    fitParagraph(
      {
        id: "floor",
        page: 1,
        bounds: { x: 0, y: 0, width: 9.1, height: 9.1 },
        fontSize: 9.2,
        formulas: [],
      },
      "中",
      font,
    ).fontSize,
  ).toBe(9);
});
it("prepares actual PDF text and composes two wide pages or four alternating pages with embedded searchable Chinese", async () => {
  const f = await fixture();
  const prepared = await prepareNativePDF(f);
  expect(prepared.pages).toHaveLength(2);
  expect(prepared.pages[0]).toMatchObject({
    width: 200,
    height: 260,
    cropBox: [20, 30, 220, 290],
  });
  expect(prepared.pages[0].paragraphs[0].originalSource).toContain(
    "Original body",
  );
  const targets = Object.fromEntries(
    prepared.pages.flatMap((p) => p.paragraphs.map((v) => [v.id, "中文译文"])),
  );
  for (const mode of ["side-by-side", "alternating"] as const) {
    const output = join(f.dir, `${mode}.pdf`);
    await renderNativePDF({ ...f, prepared, targets, output, layout: mode });
    const task = await openPDF(output);
    try {
      const pdf = await task.promise;
      expect(pdf.numPages).toBe(mode === "alternating" ? 4 : 2);
      const page = await pdf.getPage(mode === "alternating" ? 2 : 1);
      expect(page.getViewport({ scale: 1 }).width).toBe(
        mode === "alternating" ? 200 : 412,
      );
      const text = (await page.getTextContent()).items
        .map((i) => ("str" in i ? i.str : ""))
        .join("");
      expect(text).toContain("中文译文");
      if (mode === "alternating") expect(text).not.toContain("Original body");
      expect(await page.getAnnotations()).toEqual([]);
      expect(await pdf.getJSActions()).toBeNull();
    } finally {
      await task.destroy();
    }
    const result = await PDFDocument.load(await readFile(output));
    expect(
      result.context
        .enumerateIndirectObjects()
        .some(([, o]) => o.toString().includes("/FontFile2")),
    ).toBe(true);
  }
}, 30000);
it.each([0, 90, 180, 270])(
  "honors cropped physical geometry and UserUnit for rotation %i",
  async (rotation) => {
    const f = await fixture(rotation, 2);
    const prepared = await prepareNativePDF({ ...f, fromPage: 1, toPage: 1 });
    expect(prepared.pages).toHaveLength(1);
    expect([prepared.pages[0].width, prepared.pages[0].height]).toEqual(
      rotation % 180 === 0 ? [400, 520] : [520, 400],
    );
    const output = join(f.dir, "geometry.pdf");
    await renderNativePDF({
      ...f,
      prepared,
      targets: {},
      output,
      layout: "alternating",
      keepOriginalPages: [1],
    });
    const original = await openPDF(f.input),
      result = await openPDF(output);
    try {
      const { createCanvas } = await import("@napi-rs/canvas");
      const { width, height } = prepared.pages[0];
      const buffers = [];
      for (const task of [original, result]) {
        const p = await (await task.promise).getPage(1);
        const canvas = createCanvas(width, height);
        await p.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          viewport: p.getViewport({ scale: 1 }),
          background: "white",
          annotationMode: 0,
        }).promise;
        buffers.push(
          canvas.getContext("2d").getImageData(0, 0, width, height).data,
        );
      }
      // Compare the asymmetric red marker, independent of text/font anti-aliasing.
      const red = (pixels: Uint8ClampedArray) => {
        const points: number[] = [];
        for (let i = 0; i < pixels.length; i += 4)
          if (pixels[i] > 240 && pixels[i + 1] < 10 && pixels[i + 2] < 10)
            points.push(i / 4);
        return points;
      };
      expect(red(buffers[1])).toEqual(red(buffers[0]));
      expect(red(buffers[0]).length).toBeGreaterThan(100);
    } finally {
      await original.destroy();
      await result.destroy();
    }
  },
  30000,
);
it("rejects wrong input identity, invalid ranges and missing translations without output", async () => {
  const f = await fixture();
  await expect(prepareNativePDF({ ...f, fromPage: 3 })).rejects.toThrow(/页/);
  const prepared = await prepareNativePDF(f),
    output = join(f.dir, "bad.pdf");
  await expect(
    renderNativePDF({
      ...f,
      prepared,
      output,
      targets: {},
      layout: "alternating",
    }),
  ).rejects.toThrow(/译文/);
  prepared.originalSha256 = "0".repeat(64);
  await expect(
    renderNativePDF({
      ...f,
      prepared,
      output,
      targets: {},
      layout: "alternating",
    }),
  ).rejects.toThrow(/原文/);
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});
it("preserves two columns, a figure and its separate caption while moving protected formula pixels inline", async () => {
  const f = await fixture();
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([420, 420]);
  p.drawText("We use", { x: 20, y: 340, font, size: 12 });
  p.drawText("a=b", { x: 65, y: 340, font, size: 12 });
  p.drawText("in practice.", { x: 90, y: 340, font, size: 12 });
  p.drawText("Right column", { x: 230, y: 340, font, size: 12 });
  p.drawRectangle({
    x: 20,
    y: 150,
    width: 160,
    height: 80,
    color: rgb(1, 0, 0),
  });
  p.drawText("Figure 1. Result", { x: 20, y: 125, font, size: 10 });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  const bounds = (x: number, y: number, width: number, height: number) => ({
    x: x / 420,
    y: y / 420,
    width: width / 420,
    height: height / 420,
  });
  const manifest = {
    schemaVersion: 1,
    inputSHA256: createHash("sha256").update(bytes).digest("hex"),
    pages: 1,
    blocks: [
      { id: "left", page: 1, label: "text", bounds: bounds(15, 60, 175, 80) },
      { id: "right", page: 1, label: "text", bounds: bounds(225, 60, 175, 80) },
      {
        id: "figure",
        page: 1,
        label: "image",
        bounds: bounds(20, 190, 160, 80),
      },
      {
        id: "caption",
        page: 1,
        label: "figure_title",
        bounds: bounds(15, 280, 175, 35),
      },
    ],
  };
  await writeFile(f.layout, JSON.stringify(manifest));
  const prepared = await prepareNativePDF(f),
    para = prepared.pages[0].paragraphs[0];
  expect(prepared.pages[0].paragraphs).toHaveLength(3);
  expect(para.source).toContain("{v0}");
  expect(para.formulas).toHaveLength(1);
  const output = join(f.dir, "columns.pdf");
  await renderNativePDF({
    ...f,
    prepared,
    output,
    layout: "alternating",
    targets: {
      "p1.left": "公式移到此处：{v0}，继续说明。",
      "p1.right": "右栏正文保持独立，不跨越图形区域。",
      "p1.caption": "图一：结果说明。",
    },
  });
  const task = await openPDF(output);
  try {
    const pdf = await task.promise,
      page = await pdf.getPage(2);
    const text = (await page.getTextContent()).items
      .filter((i) => "str" in i)
      .map((i) => i.str)
      .join("");
    expect(text).toContain("公式移到此处");
    expect(text).not.toContain("a=b");
    expect(text).not.toContain("We use");
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(420, 420);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: page.getViewport({ scale: 1 }),
    }).promise;
    const image = canvas.getContext("2d").getImageData(50, 220, 1, 1).data;
    expect([...image]).toEqual([255, 0, 0, 255]);
    const pixels = canvas.getContext("2d").getImageData(15, 60, 175, 80).data;
    expect(
      Array.from(pixels).filter((v, i) => i % 4 !== 3 && v < 100).length,
    ).toBeGreaterThan(200);
  } finally {
    await task.destroy();
  }
  manifest.blocks.push({
    id: "table",
    page: 1,
    label: "table",
    bounds: bounds(50, 60, 100, 80),
  });
  await writeFile(f.layout, JSON.stringify(manifest));
  await expect(prepareNativePDF(f)).rejects.toThrow(/重叠/);
}, 30000);
it("built CLI writes atomic job artifacts, emits progress and rejects invalid tokens and foreign output paths", async () => {
  const f = await fixture(),
    cli = join(f.dir, "bilingual-pdf-cli.mjs");
  // Bundle in processor's source directory to resolve native dependencies in the child.
  const built = join(process.cwd(), "apps/processor/.bilingual-cli-test.mjs");
  try {
    await build({
      entryPoints: ["apps/processor/src/bilingual-pdf-cli.ts"],
      outfile: built,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
    });
    const prepared = join(f.dir, "prepared.json"),
      targets = join(f.dir, "targets.json"),
      output = join(f.dir, "out.pdf");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [built, ...args], {
        encoding: "utf8",
        timeout: 30000,
        cwd: process.cwd(),
      });
    const prep = run([
      "--stage",
      "prepare",
      "--input",
      f.input,
      "--layout",
      f.layout,
      "--prepared",
      prepared,
    ]);
    expect(prep.status, prep.stderr).toBe(0);
    expect(prep.stdout).toContain('"stage":"prepare"');
    const data = JSON.parse(await readFile(prepared, "utf8"));
    await writeFile(
      targets,
      JSON.stringify(
        Object.fromEntries(
          data.pages.flatMap((p: any) =>
            p.paragraphs.map((v: any) => [v.id, "中文译文"]),
          ),
        ),
      ),
    );
    const render = run([
      "--stage",
      "render",
      "--input",
      f.input,
      "--prepared",
      prepared,
      "--targets",
      targets,
      "--output",
      output,
      "--mode",
      "side-by-side",
    ]);
    expect(render.status, render.stderr).toBe(0);
    expect(render.stdout).toContain('"stage":"composing"');
    expect((await readFile(output)).subarray(0, 5).toString()).toBe("%PDF-");
    await writeFile(
      targets,
      JSON.stringify({ [data.pages[0].paragraphs[0].id]: "未知公式 {v9}" }),
    );
    const bad = run([
      "--stage",
      "render",
      "--input",
      f.input,
      "--prepared",
      prepared,
      "--targets",
      targets,
      "--output",
      join(f.dir, "bad.pdf"),
      "--mode",
      "side-by-side",
    ]);
    expect(bad.status).toBe(1);
    await expect(readFile(join(f.dir, "bad.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const foreign = run([
      "--stage",
      "render",
      "--input",
      f.input,
      "--prepared",
      prepared,
      "--targets",
      targets,
      "--output",
      join(tmpdir(), "foreign.pdf"),
      "--mode",
      "side-by-side",
    ]);
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toMatch(/目录/);
  } finally {
    await rm(built, { force: true });
  }
}, 30000);
it("groups actual multi-span italic variables and subscripts into one formula crop", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const p = doc.addPage([240, 200]);
  p.drawText("We measure", { x: 20, y: 140, size: 12, font });
  p.drawText("x", { x: 95, y: 140, size: 12, font: italic });
  p.drawText("i", { x: 101, y: 136, size: 7, font: italic });
  p.drawText("=1", { x: 106, y: 140, size: 12, font });
  p.drawText("in a region.", { x: 125, y: 140, size: 12, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "math",
          page: 1,
          label: "text",
          bounds: { x: 0.05, y: 0.2, width: 0.9, height: 0.4 },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    para = prepared.pages[0].paragraphs[0];
  expect(para.formulas).toHaveLength(1);
  expect(para.formulas[0].bounds.width).toBeGreaterThan(20);
  expect(para.formulas[0].bounds.height).toBeGreaterThan(12);
  expect(para.source).toContain("We measure");
  expect(para.source).toContain("in a region.");
  const output = join(f.dir, "subscript.pdf");
  await renderNativePDF({
    ...f,
    prepared,
    output,
    layout: "alternating",
    targets: { [para.id]: "测量结果 {v0} 在此区域。" },
  });
  const task = await openPDF(output);
  try {
    const page = await (await task.promise).getPage(2);
    expect(
      (await page.getTextContent()).items
        .map((i) => ("str" in i ? i.str : ""))
        .join(""),
    ).toContain("测量结果");
  } finally {
    await task.destroy();
  }
}, 30000);
it("trims a detector margin only when the removed strip contains no source glyphs", async () => {
  const f = await fixture(),
    m = JSON.parse(await readFile(f.layout, "utf8"));
  m.blocks.push({
    id: "margin",
    page: 1,
    label: "image",
    bounds: { x: 0.08, y: 0.455, width: 0.74, height: 0.1 },
  });
  await writeFile(f.layout, JSON.stringify(m));
  const prepared = await prepareNativePDF(f);
  expect(
    prepared.pages[0].paragraphs[0].bounds.y +
      prepared.pages[0].paragraphs[0].bounds.height,
  ).toBeLessThanOrEqual(118.3);
  m.blocks.at(-1).bounds.y = 0.19;
  await writeFile(f.layout, JSON.stringify(m));
  await expect(prepareNativePDF(f)).rejects.toThrow(/重叠/);
});
it("includes actual source glyph bounds when the detector clips the top of a line", async () => {
  const f = await fixture(),
    m = JSON.parse(await readFile(f.layout, "utf8"));
  m.blocks[0].bounds.y = 0.205;
  await writeFile(f.layout, JSON.stringify(m));
  const prepared = await prepareNativePDF(f);
  expect(prepared.pages[0].paragraphs[0].bounds.y).toBeLessThan(52);
});
it("keeps a detected fraction rule and multi-line numerator/denominator in a single inline crop", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([240, 200]);
  p.drawText("The ratio is", { x: 20, y: 140, size: 12, font });
  p.drawText("1", { x: 102, y: 146, size: 8, font });
  p.drawText("2", { x: 102, y: 130, size: 8, font });
  p.drawLine({
    start: { x: 95, y: 141 },
    end: { x: 115, y: 141 },
    thickness: 1,
  });
  p.drawText("in this case.", { x: 125, y: 140, size: 12, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: { x: 0.05, y: 0.2, width: 0.9, height: 0.4 },
        },
        {
          id: "fraction",
          page: 1,
          label: "inline_formula",
          bounds: {
            x: 94 / 240,
            y: 45 / 200,
            width: 22 / 240,
            height: 32 / 200,
          },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    para = prepared.pages[0].paragraphs[0];
  expect(para.formulas).toHaveLength(1);
  expect(para.formulas[0].bounds).toMatchObject({ width: 22, height: 32 });
  const output = join(f.dir, "fraction.pdf");
  await renderNativePDF({
    ...f,
    prepared,
    output,
    layout: "alternating",
    targets: { [para.id]: "此处比例 {v0} 作为示例。" },
  });
  const task = await openPDF(output);
  try {
    const page = await (await task.promise).getPage(2);
    expect(
      (await page.getTextContent()).items
        .map((i) => ("str" in i ? i.str : ""))
        .join(""),
    ).toContain("此处比例");
  } finally {
    await task.destroy();
  }
}, 30000);
it("merges overlapping same-column footnotes into one export paragraph containing each source exactly once", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([240, 200]);
  p.drawText("First footnote.", { x: 20, y: 50, size: 9, font });
  p.drawText("Second footnote.", { x: 20, y: 39, size: 9, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "note1",
          page: 1,
          label: "footnote",
          bounds: {
            x: 15 / 240,
            y: 140 / 200,
            width: 200 / 240,
            height: 16 / 200,
          },
        },
        {
          id: "note2",
          page: 1,
          label: "footnote",
          bounds: {
            x: 15 / 240,
            y: 152 / 200,
            width: 200 / 240,
            height: 20 / 200,
          },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    paras = prepared.pages[0].paragraphs;
  expect(paras).toHaveLength(1);
  expect(paras[0].blockId).toBe("note1");
  expect(paras[0].source.match(/First footnote\./g)).toHaveLength(1);
  expect(paras[0].source.match(/Second footnote\./g)).toHaveLength(1);
  const output = join(f.dir, "notes.pdf");
  await renderNativePDF({
    ...f,
    prepared,
    output,
    layout: "alternating",
    targets: { [paras[0].id]: "第一条脚注。第二条脚注。" },
  });
  const task = await openPDF(output);
  try {
    const page = await (await task.promise).getPage(2),
      text = (await page.getTextContent()).items
        .map((i) => ("str" in i ? i.str : ""))
        .join("");
    expect(text).toContain("第一条脚注");
    expect(text).not.toContain("footnote");
  } finally {
    await task.destroy();
  }
}, 30000);
it("extracts a unique merged asset caption for translation while preserving pixels of internal figure labels", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([240, 200]);
  p.drawRectangle({
    x: 20,
    y: 80,
    width: 180,
    height: 80,
    color: rgb(1, 0, 0),
  });
  p.drawText("INTERNAL LABEL", { x: 40, y: 120, font, size: 12 });
  p.drawText("Figure 1. Merged caption", { x: 20, y: 60, font, size: 10 });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  const m = {
    schemaVersion: 1,
    inputSHA256: createHash("sha256").update(bytes).digest("hex"),
    pages: 1,
    blocks: [
      {
        id: "asset",
        page: 1,
        label: "image",
        caption: "Figure 1. Merged caption",
        bounds: { x: 0.05, y: 0.15, width: 0.9, height: 0.6 },
      },
    ],
  };
  await writeFile(f.layout, JSON.stringify(m));
  const prepared = await prepareNativePDF(f),
    paras = prepared.pages[0].paragraphs;
  expect(paras).toHaveLength(1);
  expect(paras[0].blockId).toBe("asset");
  expect(paras[0].originalSource).toBe("Figure 1. Merged caption");
  const output = join(f.dir, "merged-caption.pdf");
  await renderNativePDF({
    ...f,
    prepared,
    output,
    layout: "alternating",
    targets: { [paras[0].id]: "图一" },
  });
  const tasks = [await openPDF(f.input), await openPDF(output)];
  try {
    const { createCanvas } = await import("@napi-rs/canvas"),
      images: SKRSContext2D[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const page = await (await tasks[i].promise).getPage(i ? 2 : 1),
        canvas = createCanvas(1000, 834);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport: page.getViewport({ scale: 300 / 72 }),
        background: "white",
      }).promise;
      images.push(canvas.getContext("2d"));
    }
    const label = (i: number) => {
      const pixels = images[i].getImageData(125, 250, 625, 125).data,
        points: number[] = [];
      for (let n = 0; n < pixels.length; n += 4)
        if (pixels[n] < 80) points.push(n / 4);
      return points;
    };
    const before = label(0),
      after = label(1);
    expect(after.length / before.length).toBeGreaterThan(0.98);
    expect(after.length / before.length).toBeLessThan(1.02);
    expect(
      Math.abs(
        after.reduce((s, v) => s + (v % 625), 0) / after.length -
          before.reduce((s, v) => s + (v % 625), 0) / before.length,
      ),
    ).toBeLessThan(1);
    const cleared = images[1].getImageData(334, 542, 250, 45).data;
    expect(cleared.every((v, i) => i % 4 === 3 || v > 250)).toBe(true);
    const b = paras[0].bounds,
      below = images[1].getImageData(
        Math.floor((b.x * 300) / 72),
        Math.ceil(((b.y + b.height) * 300) / 72) + 1,
        200,
        20,
      ).data;
    expect(below.every((v, i) => i % 4 === 3 || v > 250)).toBe(true);
  } finally {
    for (const t of tasks) await t.destroy();
  }
  m.blocks[0].caption = "Caption absent from source";
  await writeFile(f.layout, JSON.stringify(m));
  await expect(prepareNativePDF(f)).rejects.toThrow(/图题.*定位/);
}, 30000);
it("protects a spaced equation's plain digits with its adjacent math symbols", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    p = doc.addPage([240, 200]);
  p.drawText("We set a = 123 in this case.", { x: 20, y: 140, size: 12, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: { x: 0.05, y: 0.2, width: 0.9, height: 0.4 },
        },
      ],
    }),
  );
  const para = (await prepareNativePDF(f)).pages[0].paragraphs[0];
  expect(para.formulas).toHaveLength(1);
  expect(para.source).not.toContain("123");
  expect(para.source).not.toContain(" a ");
  expect(para.source).toContain("in this case.");
});
it("requires explicit retention for blank pages and refuses oversized 300DPI pages without output", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const big = doc.addPage([2000, 2000]),
    font = await doc.embedFont(StandardFonts.Helvetica);
  big.drawText("Body", { x: 20, y: 1900, size: 12, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 2,
      blocks: [
        {
          id: "body",
          page: 2,
          label: "text",
          bounds: { x: 0.005, y: 0.01, width: 0.9, height: 0.5 },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    output = join(f.dir, "limit.pdf");
  expect(prepared.noTextPages).toEqual([1]);
  const targets = { [prepared.pages[1].paragraphs[0].id]: "正文" };
  await expect(
    renderNativePDF({ ...f, prepared, targets, output, layout: "alternating" }),
  ).rejects.toThrow(/第 1 页.*保留/);
  await expect(
    renderNativePDF({
      ...f,
      prepared,
      targets,
      output,
      layout: "alternating",
      keepOriginalPages: [1],
    }),
  ).rejects.toThrow(/第 2 页.*300 DPI/);
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  await renderNativePDF({
    ...f,
    prepared,
    targets: {},
    output,
    layout: "alternating",
    keepOriginalPages: [1, 2],
  });
  const task = await openPDF(output);
  try {
    expect((await task.promise).numPages).toBe(4);
  } finally {
    await task.destroy();
  }
}, 30000);
it("renders every repeated Latin and Chinese glyph across pages against the original regular face outlines", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    sourceFont = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++)
    doc
      .addPage([360, 180])
      .drawText("Source paragraph", {
        x: 20,
        y: 130,
        size: 18,
        font: sourceFont,
      });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 2,
      blocks: [1, 2].map((page) => ({
        id: `body-${page}`,
        page,
        label: "text",
        bounds: { x: 0.05, y: 0.15, width: 0.9, height: 0.6 },
      })),
    }),
  );
  const prepared = await prepareNativePDF(f),
    texts = ["PDF API PBXD 中文 PDF", "API PDF XBDP 第二页 API"],
    targets = Object.fromEntries(
      prepared.pages.map((p, i) => [p.paragraphs[0].id, texts[i]]),
    ),
    { font, face } = await loadFont(await PDFDocument.create()),
    { createCanvas, Path2D } = await import("@napi-rs/canvas"),
    scale = 300 / 72;
  const ratios: { glyph: string; ratio: number }[] = [];
  for (const layout of ["alternating", "side-by-side"] as const) {
    const output = join(f.dir, `${layout}-glyphs.pdf`);
    await renderNativePDF({ ...f, prepared, targets, output, layout });
    const task = await openPDF(output);
    try {
      const pdf = await task.promise;
      for (let i = 0; i < 2; i++) {
        const page = await pdf.getPage(
            layout === "alternating" ? 2 * i + 2 : i + 1,
          ),
          viewport = page.getViewport({ scale }),
          actual = createCanvas(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          ),
          expected = createCanvas(actual.width, actual.height),
          context = expected.getContext("2d"),
          offset = layout === "side-by-side" ? 372 : 0,
          fit = fitParagraph(prepared.pages[i].paragraphs[0], texts[i], font);
        context.fillStyle = "white";
        context.fillRect(0, 0, expected.width, expected.height);
        context.fillStyle = "black";
        await page.render({
          canvas: actual as unknown as HTMLCanvasElement,
          viewport,
          background: "white",
        }).promise;
        for (const run of fit.runs) {
          const shaped = face.layout(run.text),
            unit = fit.fontSize / face.unitsPerEm;
          let advance = 0;
          for (let g = 0; g < shaped.glyphs.length; g++) {
            const glyph = shaped.glyphs[g],
              pos = shaped.positions[g],
              b = glyph.bbox,
              x = offset + run.x + (advance + pos.xOffset) * unit,
              y = run.y + run.ascent - pos.yOffset * unit;
            advance += pos.xAdvance;
            if (!Number.isFinite(b.minX)) continue;
            context.save();
            context.translate(x * scale, y * scale);
            context.scale(unit * scale, -unit * scale);
            context.fill(new Path2D(glyph.path.toSVG()));
            context.restore();
            const left = Math.floor((x + b.minX * unit) * scale) - 1,
              top = Math.floor((y - b.maxY * unit) * scale) - 1,
              width = Math.ceil((b.maxX - b.minX) * unit * scale) + 3,
              height = Math.ceil((b.maxY - b.minY) * unit * scale) + 3,
              ink = (c: SKRSContext2D) =>
                c
                  .getImageData(left, top, width, height)
                  .data.reduce(
                    (sum, v, n) => sum + (n % 4 === 0 ? (255 - v) / 255 : 0),
                    0,
                  ),
              reference = ink(context);
            expect(reference).toBeGreaterThan(10);
            ratios.push({
              glyph: `${layout}/page${i + 1}/${String.fromCodePoint(...glyph.codePoints)}`,
              ratio: ink(actual.getContext("2d")) / reference,
            });
          }
        }
      }
    } finally {
      await task.destroy();
    }
  }
  expect(ratios.length).toBeGreaterThan(50);
  expect(ratios.filter((r) => r.ratio < 0.8 || r.ratio > 1.2)).toEqual([]);
}, 30000);
it("protects a line-end Latin operand separately from its next-line equation and preserves both crops", async () => {
  const f = await fixture(),
    doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.TimesRoman),
    p = doc.addPage([360, 220]);
  const first = "The inline formula a",
    second = "= b + c remains visible";
  p.drawText(first, { x: 24, y: 164, size: 12, font });
  p.drawText(second, { x: 24, y: 146, size: 12, font });
  const bytes = await doc.save();
  await writeFile(f.input, bytes);
  await writeFile(
    f.layout,
    JSON.stringify({
      schemaVersion: 1,
      inputSHA256: createHash("sha256").update(bytes).digest("hex"),
      pages: 1,
      blocks: [
        {
          id: "body",
          page: 1,
          label: "text",
          bounds: { x: 0.05, y: 0.2, width: 0.9, height: 0.4 },
        },
      ],
    }),
  );
  const prepared = await prepareNativePDF(f),
    para = prepared.pages[0].paragraphs[0];
  expect(para.source).not.toMatch(/\ba\b/);
  expect(para.formulas).toHaveLength(2);
  expect(para.formulas[0].bounds.x).toBeCloseTo(
    24 + font.widthOfTextAtSize("The inline formula ", 12),
    3,
  );
  expect(para.formulas[0].bounds.width).toBeCloseTo(
    font.widthOfTextAtSize("a", 12),
    3,
  );
  expect(para.formulas[1].bounds.x).toBe(24);
  expect(para.formulas[0].bounds.y).toBeLessThan(para.formulas[1].bounds.y);
  const output = join(f.dir, "wrapped-equation.pdf"),
    target = "跨行公式 {v0} {v1} 保持完整";
  await renderNativePDF({
    ...f,
    prepared,
    targets: { [para.id]: target },
    output,
    layout: "alternating",
  });
  const { font: targetFont } = await loadFont(await PDFDocument.create()),
    fit = fitParagraph(para, target, targetFont),
    tasks = [await openPDF(f.input), await openPDF(output)],
    images: SKRSContext2D[] = [];
  try {
    const { createCanvas } = await import("@napi-rs/canvas"),
      scale = 300 / 72;
    for (let i = 0; i < 2; i++) {
      const page = await (await tasks[i].promise).getPage(i ? 2 : 1),
        canvas = createCanvas(1500, 917);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport: page.getViewport({ scale }),
        background: "white",
      }).promise;
      images.push(canvas.getContext("2d"));
    }
    for (let i = 0; i < 2; i++) {
      const original = para.formulas[i].bounds,
        restored = fit.runs.filter((r) => r.kind === "formula")[i],
        ink = (
          context: SKRSContext2D,
          b: { x: number; y: number; width: number; height: number },
        ) =>
          context
            .getImageData(
              Math.ceil(b.x * scale),
              Math.ceil(b.y * scale),
              Math.floor(b.width * scale) - 1,
              Math.floor(b.height * scale) - 1,
            )
            .data.filter((v, n) => n % 4 === 0 && v < 128).length,
        before = ink(images[0], original),
        after = ink(images[1], restored);
      expect(before).toBeGreaterThan(30);
      expect(after / before).toBeGreaterThan(0.85);
      expect(after / before).toBeLessThan(1.15);
    }
  } finally {
    for (const t of tasks) await t.destroy();
  }
}, 30000);
it.each([
  { first: "The inline formula a b", x: 24 },
  { first: "The inline formula a", x: 180 },
])(
  "rejects a wrapped operand with ambiguous candidates or a different column: $first / $x",
  async ({ first, x }) => {
    const f = await fixture(),
      doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.TimesRoman),
      p = doc.addPage([360, 220]);
    p.drawText(first, { x: 24, y: 164, size: 12, font });
    p.drawText("= b + c remains", { x, y: 146, size: 12, font });
    const bytes = await doc.save();
    await writeFile(f.input, bytes);
    await writeFile(
      f.layout,
      JSON.stringify({
        schemaVersion: 1,
        inputSHA256: createHash("sha256").update(bytes).digest("hex"),
        pages: 1,
        blocks: [
          {
            id: "body",
            page: 1,
            label: "text",
            bounds: { x: 0.05, y: 0.2, width: 0.9, height: 0.4 },
          },
        ],
      }),
    );
    await expect(prepareNativePDF(f)).rejects.toThrow(/跨行公式.*无法唯一证明/);
  },
);
