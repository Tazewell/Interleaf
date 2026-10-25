// Owned synthetic originals. No downloaded papers or user library inputs.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(new URL('../../apps/processor/package.json', import.meta.url));
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { ZipFile } = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('yazl');
const out = process.argv[2];
await mkdir(join(out, 'fixtures'), { recursive: true });
const papers = {
  A: ['A: Uniform graph aggregation', 'Uniform aggregation improves calibration on sparse graphs.', 'Controlled synthetic experiment: error decreases from 8 to 4.'],
  B: ['B: Uniform graph aggregation', 'Uniform aggregation worsens calibration on sparse graphs.', 'Controlled synthetic experiment: error increases from 4 to 8.'],
  C: ['C: Uncertainty weighted propagation', 'We propose uncertainty weighted graph propagation with variance weights.', 'This mechanism is already described in the remote full-text B2 fixture.'],
  B2: ['B2: Variance weighting in graph propagation', 'We implement uncertainty weighted graph propagation with variance weights.', 'A fixed graph split compares uniform aggregation and variance weights.'],
  translated: ['A: Translation attachment', 'This attachment is a translation, not an independent research paper.', 'It must never increase the scope count.'],
};
for (const [id, lines] of Object.entries(papers)) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setTitle(lines[0]); pdf.setAuthor('Reader deterministic acceptance fixture');
  const page = pdf.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 730 - i * 45, size: i ? 11 : 16, font }));
  page.drawRectangle({ x: 70, y: 350, width: 100, height: 120, color: rgb(.25, .45, .65) });
  page.drawText('Figure 1: synthetic graph result', { x: 50, y: 320, size: 11, font });
  page.drawText('Synthetic data only. No scientific claim is established.', { x: 50, y: 65, size: 10, font });
  await writeFile(join(out, 'fixtures', `${id}.pdf`), await pdf.save());
}
const zip = new ZipFile();
const add = (name, data) => zip.addBuffer(Buffer.from(data), name, { compress: name !== 'mimetype' });
add('mimetype', 'application/epub+zip');
add('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
add('OPS/package.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader-task11-epub</dc:identifier><dc:title>D: Graph assumptions</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-22T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>');
add('OPS/chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Graph assumptions</title></head><body><h1 id="assumptions">Graph assumptions</h1><p>Graph comparisons require identical splits and sparse graph conditions. Conclusions do not establish behavior on dense graphs.</p></body></html>');
add('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Graph assumptions</a></li></ol></nav></body></html>');
await new Promise((resolve, reject) => { zip.outputStream.pipe(createWriteStream(join(out, 'fixtures', 'D.epub'))).on('close', resolve).on('error', reject); zip.end(); });
await writeFile(join(out, 'fixtures', 'expectations.json'), JSON.stringify({ defaultScope: 5, directScope: 4, fullCoverage: 40, conflict: ['A', 'B'], covered: ['C', 'B2'] }, null, 2));
console.log('Created five synthetic PDFs, EPUB and literal acceptance expectations');
