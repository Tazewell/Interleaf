import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
const require = createRequire(
  new URL("../../apps/processor/package.json", import.meta.url),
);
const {
  PDFDocument,
  StandardFonts,
  rgb,
  PDFName,
  PDFNumber,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
} = require("pdf-lib");
const out = process.argv[2];
if (!out) throw new Error("Usage: node fixtures.mjs OUTPUT_DIRECTORY");
await mkdir(out, { recursive: true });
const pdf = await PDFDocument.create();
pdf.setTitle("Interleaf synthetic bilingual export fixture");
pdf.setAuthor("Interleaf test fixture");
const roman = await pdf.embedFont(StandardFonts.TimesRoman);
const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
const small = await pdf.embedFont(StandardFonts.Helvetica);
function paragraph(
  page,
  text,
  x,
  y,
  width,
  size = 11,
  leading = 15,
  font = roman,
) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? line + " " + word : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  lines.forEach((s, i) =>
    page.drawText(s, { x, y: y - i * leading, size, font }),
  );
  return y - lines.length * leading;
}
function title(page, text, x, y, size = 13) {
  page.drawText(text, { x, y, size, font: bold });
}
const p = pdf.addPage([612, 792]);
title(p, "A Small Study of Local Document Reading", 70, 732, 21);
p.drawText("Interleaf synthetic test document", {
  x: 70,
  y: 706,
  size: 10,
  font: small,
});
title(p, "Abstract", 70, 670);
paragraph(
  p,
  "The reader keeps papers, notes and references on the local computer. This synthetic document evaluates a bilingual PDF export workflow. Paragraphs retain their page positions, while figures and equations preserve their original appearance. Exported Chinese text can be selected, searched and copied.",
  70,
  646,
  472,
);
title(p, "1 Introduction", 70, 550);
paragraph(
  p,
  'A useful research library connects original papers with notes, translations and stable citation keys. Users configure their own translation API. The export process checks completed responses before building a document and reports pages that cannot fit the translated text. Literal {} {name} {value} {"a":{"b":1}} open { close } extra {.',
  70,
  526,
  472,
);
title(p, "2 Equations and figures", 70, 430);
paragraph(
  p,
  "The inline formula x = y + z is preserved in this paragraph. The following display equation and figure retain their original appearance. Text inside the chart remains in its original language.",
  70,
  406,
  472,
);
p.drawText("s", { x: 240, y: 336, size: 22, font: italic });
p.drawText("i", { x: 250, y: 330, size: 13, font: italic });
p.drawText(" = a + b", { x: 258, y: 336, size: 22, font: italic });
for (const [i, h] of [54, 84, 66].entries()) {
  p.drawRectangle({
    x: 115 + i * 115,
    y: 180,
    width: 64,
    height: h,
    color: rgb(0.32, 0.48, 0.62),
  });
  p.drawText(["Session A", "Session B", "Session C"][i], {
    x: 111 + i * 115,
    y: 160,
    size: 10,
    font: small,
  });
}
p.drawLine({
  start: { x: 95, y: 180 },
  end: { x: 470, y: 180 },
  thickness: 0.7,
});
paragraph(
  p,
  "Figure 1: Example values for three local reading sessions.",
  105,
  128,
  402,
  10,
  13,
);
paragraph(
  p,
  "* Synthetic content only. No private paper or real API credential is included.",
  70,
  70,
  472,
  9,
  12,
);
p.drawText("1", { x: 301, y: 36, size: 10, font: roman });
const q = pdf.addPage([612, 792]);
title(q, "3 Two-column evaluation", 54, 735, 15);
title(q, "3.1 Layout and text", 54, 698, 12);
paragraph(
  q,
  "The first column explains the page layout. Original page size is preserved in both export modes. A side-by-side page contains the original on the left and the translation on the right. Alternating export places each translated page after its original.",
  54,
  675,
  236,
  10.5,
  14,
);
paragraph(
  q,
  "Chinese text uses an embedded font. The output does not rely on a font installed on the computer. Formula placeholders are checked before the result is accepted. Long translations produce a clear error instead of being truncated.",
  54,
  510,
  236,
  10.5,
  14,
);
title(q, "3.2 Results", 322, 698, 12);
paragraph(
  q,
  "The second column reports the evaluation. All numbers are synthetic. The table and its internal labels are preserved, while its caption can be translated. Source files and reading annotations remain unchanged throughout the workflow.",
  322,
  675,
  236,
  10.5,
  14,
);
paragraph(q, "Table 1: Synthetic workflow checks.", 322, 532, 236, 10, 13);
const rows = [
  ["Task", "Items", "Result"],
  ["Read", "12", "pass"],
  ["Export", "2", "pass"],
  ["Cancel", "1", "pass"],
];
for (let r = 0; r <= 4; r++)
  q.drawLine({
    start: { x: 322, y: 505 - r * 27 },
    end: { x: 558, y: 505 - r * 27 },
    thickness: 0.6,
  });
for (const x of [322, 402, 478, 558])
  q.drawLine({ start: { x, y: 505 }, end: { x, y: 397 }, thickness: 0.6 });
rows.forEach((row, r) =>
  row.forEach((s, c) =>
    q.drawText(s, {
      x: [330, 410, 486][c],
      y: 486 - r * 27,
      size: 10,
      font: r ? roman : bold,
    }),
  ),
);
title(q, "4 Conclusion", 54, 342, 12);
paragraph(
  q,
  "This document is a functional test fixture, not a published research paper. It checks native PDF composition, configured API transport, file saving and attachment management. The output examples use deterministic test translations.",
  54,
  319,
  504,
  11,
  15,
);
paragraph(
  q,
  "* Inspect the exported file for clear text, complete diagrams and correct page order.",
  54,
  80,
  504,
  9,
  12,
);
q.drawText("2", { x: 301, y: 36, size: 10, font: roman });
await writeFile(out + "/reader-synthetic-paper.pdf", await pdf.save());
// Counter-rotate the page content so its visible writing stays horizontal.
// All geometry is native PDF geometry, not a rasterized replacement page.
const geometry = await PDFDocument.create();
const geometryFont = await geometry.embedFont(StandardFonts.TimesRoman);
const geometrySpecs = [
  { rotation: 90, crop: [20, 30, 540, 720], unit: 1.25 },
  { rotation: 270, crop: [35, 45, 500, 680], unit: 1 },
  { rotation: 0, crop: [15, 25, 430, 590], unit: 1.5 },
];
const expected = [];
for (const [
  index,
  {
    rotation,
    crop: [x, y, w, h],
    unit,
  },
] of geometrySpecs.entries()) {
  const page = geometry.addPage([600, 800]);
  page.setCropBox(x, y, w, h);
  page.setRotation(degrees(rotation));
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(unit));
  const visibleWidth = (rotation ? h : w) * unit,
    visibleHeight = (rotation ? w : h) * unit;
  const matrix =
    rotation === 90
      ? [0, 1 / unit, -1 / unit, 0, x + w, y]
      : rotation === 270
        ? [0, -1 / unit, 1 / unit, 0, x, y + h]
        : [1 / unit, 0, 0, 1 / unit, x, y];
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...matrix),
  );
  paragraph(
    page,
    `Geometry page ${index + 1}: rotated crop and physical units`,
    48,
    visibleHeight - 65,
    visibleWidth - 96,
    17,
    22,
    geometryFont,
  );
  paragraph(
    page,
    "This horizontal paragraph checks a nonzero CropBox, page rotation and mixed physical page sizes. The inline formula a = b + c remains visible. Original vectors remain sharp after export.",
    48,
    visibleHeight - 130,
    visibleWidth - 96,
    12,
    18,
    geometryFont,
  );
  page.drawRectangle({
    x: 48,
    y: 110,
    width: 170,
    height: 80,
    color: rgb(0.32, 0.48, 0.62),
  });
  paragraph(
    page,
    `Protected chart ${index + 1}`,
    58,
    145,
    150,
    11,
    15,
    geometryFont,
  );
  page.pushOperators(popGraphicsState());
  expected.push({
    page: index + 1,
    width: visibleWidth,
    height: visibleHeight,
    rotation,
    cropBox: [x, y, x + w, y + h],
    userUnit: unit,
  });
}
await writeFile(out + "/reader-geometry.pdf", await geometry.save());
const blank = await PDFDocument.create();
blank.addPage([300, 400]);
await writeFile(out + "/reader-no-text.pdf", await blank.save());
await writeFile(
  out + "/geometry-expected.json",
  JSON.stringify(expected, null, 2),
);
console.log(
  "Generated owned paper (2 pages), mixed geometry (3 pages), and no-text (1 page) fixtures",
);
