// Single SVG source for 纸间 / Interleaf. Rasterize and package icons with
// the processor's existing cross-platform canvas dependency.
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(
  new URL("../apps/processor/package.json", import.meta.url),
);
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const assets = join(root, "assets");
const website = join(root, "website/assets");

const ivory = "#F7F6F2";
const ink = "#1F1E1D";
const clay = "#C2643F";
// Filled paper silhouettes retain a clear gap when reduced to 16 px.
const leftPage =
  "M29 30H47L60 43V82H30C26.686 82 24 79.314 24 76V35C24 32.239 26.239 30 29 30Z";
const rightPage =
  "M44 18H68L80 30V68C80 70.761 77.761 73 75 73H66V40L50 24H44V18Z";
const mark = (foreground, cls = "") =>
  `<path${cls} d="${leftPage}" fill="${foreground}"/><path d="${rightPage}" fill="${clay}"/>`;
const svg = (viewBox, body, size = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${size}>${body}</svg>\n`;
// Full-bleed rounded tile on a 100-unit grid.
const logo = ({ tile = ivory, foreground = ink, rx = 22.5 } = {}) =>
  svg(
    "0 0 100 100",
    `<rect width="100" height="100" rx="${rx}" fill="${tile}"/>${mark(foreground)}`,
  );
// macOS grid: 824 px tile inset 100 px on a 1024 canvas, with the system-style drop shadow.
const macos = () =>
  svg(
    "0 0 1024 1024",
    `<defs><filter id="s" x="-10%" y="-10%" width="120%" height="125%"><feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/><feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect x="100" y="100" width="824" height="824" rx="185" fill="${ivory}" filter="url(#s)"/><g transform="translate(100 100) scale(8.24)">${mark(ink)}</g>`,
    ' width="1024" height="1024"',
  );
const favicon = svg(
  "0 0 100 100",
  `<style>@media (prefers-color-scheme: dark){.t{fill:${ink}}.i{fill:${ivory}}}</style><rect class="t" width="100" height="100" rx="22.5" fill="${ivory}"/>${mark(ink, ' class="i"')}`,
);

const png = async (source, target, size) => {
  const canvas = createCanvas(size, size);
  canvas
    .getContext("2d")
    .drawImage(await loadImage(await readFile(source)), 0, 0, size, size);
  await writeFile(target, canvas.toBuffer("image/png"));
};
async function writeICO(paths, target) {
  const frames = await Promise.all(paths.map((path) => readFile(path)));
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  for (const [i, bytes] of frames.entries()) {
    const size = bytes.readUInt32BE(16);
    const entry = 6 + i * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(bytes.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  }
  await writeFile(target, Buffer.concat([directory, ...frames]));
}
async function writeICNS(iconset, target) {
  const chunks = [];
  for (const [type, name] of [
    ["icp4", "16x16"],
    ["ic11", "16x16@2x"],
    ["icp5", "32x32"],
    ["ic12", "32x32@2x"],
    ["ic07", "128x128"],
    ["ic13", "128x128@2x"],
    ["ic08", "256x256"],
    ["ic14", "256x256@2x"],
    ["ic09", "512x512"],
    ["ic10", "512x512@2x"],
  ]) {
    const bytes = await readFile(join(iconset, `icon_${name}.png`));
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(8 + bytes.length, 4);
    chunks.push(header, bytes);
  }
  const header = Buffer.alloc(8);
  header.write("icns");
  header.writeUInt32BE(
    8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    4,
  );
  await writeFile(target, Buffer.concat([header, ...chunks]));
}

const tmp = await mkdtemp(join(tmpdir(), "interleaf-brand-"));
try {
  const write = async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return path;
  };
  const source = {
    large: await write(join(assets, "logo/interleaf-logo.svg"), logo()),
    medium: await write(join(tmp, "medium.svg"), logo()),
    small: await write(join(tmp, "small.svg"), logo()),
    dark: await write(
      join(assets, "logo/interleaf-logo-dark.svg"),
      logo({ tile: ink, foreground: ivory }),
    ),
    square: await write(join(tmp, "square.svg"), logo({ rx: 0 })),
    macos: await write(join(assets, "icons/macos/icon.svg"), macos()),
    macosMedium: await write(join(tmp, "macos-medium.svg"), macos()),
    macosSmall: await write(join(tmp, "macos-small.svg"), macos()),
  };
  // The bare mark, cropped to its bounds, for surfaces that supply their own background.
  await write(
    join(assets, "logo/interleaf-mark.svg"),
    svg("24 18 56 64", mark(ink)),
  );
  await write(
    join(assets, "logo/interleaf-mark-light.svg"),
    svg("24 18 56 64", mark(ivory)),
  );

  await mkdir(join(assets, "logo/png"), { recursive: true });
  for (const size of [256, 512, 1024])
    await png(
      source.large,
      join(assets, `logo/png/interleaf-logo-${size}.png`),
      size,
    );
  await png(
    source.dark,
    join(assets, "logo/png/interleaf-logo-dark-1024.png"),
    1024,
  );

  // macOS .icns contains both standard and Retina PNG representations.
  const iconset = join(tmp, "icon.iconset");
  await mkdir(iconset);
  for (const [name, size] of [
    ["16x16", 16],
    ["16x16@2x", 32],
    ["32x32", 32],
    ["32x32@2x", 64],
    ["128x128", 128],
    ["128x128@2x", 256],
    ["256x256", 256],
    ["256x256@2x", 512],
    ["512x512", 512],
    ["512x512@2x", 1024],
  ])
    await png(
      size <= 32
        ? source.macosSmall
        : size <= 64
          ? source.macosMedium
          : source.macos,
      join(iconset, `icon_${name}.png`),
      size,
    );
  await writeICNS(iconset, join(assets, "icons/macos/icon.icns"));

  // Windows .ico: full-bleed tile, which is how Windows 11 app icons sit in the taskbar.
  await mkdir(join(assets, "icons/windows"), { recursive: true });
  const frames = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const frame = join(tmp, `win-${size}.png`);
    await png(
      size <= 32 ? source.small : size <= 64 ? source.medium : source.large,
      frame,
      size,
    );
    frames.push(frame);
  }
  await writeICO(frames, join(assets, "icons/windows/icon.ico"));

  // Website favicons. Pages deploys only website/, so these are copies, not links.
  await write(join(website, "favicon.svg"), favicon);
  const ico = [];
  for (const size of [16, 32, 48]) {
    const frame = join(tmp, `fav-${size}.png`);
    await png(size <= 32 ? source.small : source.medium, frame, size);
    ico.push(frame);
  }
  await writeICO(ico, join(website, "favicon.ico"));
  // iOS masks its own corners, so the touch icon is a plain square.
  await png(source.square, join(website, "apple-touch-icon.png"), 180);
  const app = join(root, "apps/web/public/brand");
  await write(join(app, "logo.svg"), await readFile(source.large));
  await write(join(app, "logo-dark.svg"), await readFile(source.dark));
  await write(join(app, "favicon.svg"), favicon);
  await write(
    join(app, "favicon.ico"),
    await readFile(join(website, "favicon.ico")),
  );
  await png(source.large, join(root, "apps/connector/store/icon-128.png"), 128);
  const page = join(root, "website/index.html");
  const html = await readFile(page, "utf8");
  await writeFile(
    page,
    html.replace(
      /(<a class="brand"[^>]*>\s*)<svg\b[\s\S]*?<\/svg>/,
      `$1<svg viewBox="24 18 56 64" aria-hidden="true">${mark("currentColor")}</svg>`,
    ),
  );
  console.log("Generated 纸间 Interleaf SVG, PNG, ICO, ICNS and app icons.");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
