<p align="center">
  <img src="assets/logo/interleaf-logo.svg" width="96" alt="Interleaf green page mark" />
</p>

<h1 align="center">Interleaf · 纸间</h1>

<p align="center">A local-first EPUB/PDF reader for papers and books, with bilingual translation, annotations, notes, and AI-assisted reading.</p>
<p align="center"><a href="README.md">简体中文</a> · <b>English</b> · <a href="https://github.com/Tazewell/Interleaf/releases">Releases</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/assets/screenshots/interleaf-pdf-dark.jpg" />
  <img src="website/assets/screenshots/interleaf-pdf-light.jpg" alt="Current Interleaf PDF reader with document outline and annotation panel" />
</picture>

Interleaf keeps books and papers in separate libraries, with original files, notes, and reading history on your computer. Connect your own OpenAI- or Anthropic-compatible API for questions, translation, and research across your documents.

## Features

- **Libraries for books and papers:** import EPUB/PDF, organize documents with categories, tags, reading states, and favorites; manage paper metadata, duplicates, related documents, and batch actions.
- **Reading and annotations:** contents, text search, bookmarks, highlights, underlines, questions, notes, reading-position restoration, filtering, undo, and exports. Light, dark, and paper appearances are available.
- **Bilingual reading:** original, side-by-side, and translated PDF views; chapter translation and linked source/translation reading for EPUB. Layout analysis runs locally; translation needs a configured API.
- **AI reading and research:** quote passages in questions, follow answer sources back to the original, keep document conversations, and synthesize comparisons or research ideas across a category. Online research requires separate authorization.
- **Import and citations:** DOI, arXiv, URL, or title import; Zotero migration, a browser connector, and GB/T 7714, APA, BibTeX, and RIS exports.
- **Desktop and terminal:** Electron desktop app, in-app updates, proxy settings, diagnostic exports, editable shortcuts, and the `interleaf` command for searching, reading, and importing library documents.

The browser extension is not published to a store yet. Build `apps/connector`, enable developer mode in Chrome, and load its generated `dist/` directory.

## Current screenshots

Captured from the current app on **2026-10-31**, using the bundled original sample documents in a separate demonstration library. These images contain no personal conversations, API keys, or real provider endpoints. Light/dark variants follow GitHub's appearance.

### Library

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="website/assets/screenshots/interleaf-library-dark.jpg" />
  <img src="website/assets/screenshots/interleaf-library-light.jpg" alt="Interleaf library with EPUB/PDF samples, filters, and reading records" />
</picture>

### AI settings

<img src="website/assets/screenshots/interleaf-ai-settings.jpg" alt="Current API settings with endpoint, protocol, and model roles" />

### Keyboard shortcuts

<img src="website/assets/screenshots/interleaf-shortcuts.jpg" alt="Current shortcut settings with search, editing, and reset controls" />

### Interleaf identity

<img src="website/assets/screenshots/interleaf-about.jpg" alt="About Interleaf with the new green page mark and app version" />

## Install or run from source

Published installers are available through [GitHub Releases](https://github.com/Tazewell/Interleaf/releases); check the release attachments for actual versions and platforms. The project builds Windows x64 EXE and Apple Silicon macOS DMG installers. Build installers on native Windows or macOS. If no installer is available yet, run from source.

Installers currently have no trusted developer signature or macOS notarization. Check the download source and checksums; your operating system may show a first-run security prompt.

### Run from source

Requires **Node.js 22+, pnpm 10.30.3, and Go 1.26.5+**:

```sh
git clone https://github.com/Tazewell/Interleaf.git
cd Interleaf
pnpm install --frozen-lockfile
pnpm desktop
```

Use `pnpm dev` for the browser development preview. Open the complete local URL printed in the terminal; it includes a temporary authentication token and must not be published. An empty book library offers bundled sample documents.

The first build downloads and verifies approximately 67 MB of local layout-model weights. End users of packaged builds do not need Node.js, Go, Python, or PaddlePaddle.

## AI configuration and data

Local reading, search, and annotations work without AI. In **Settings → AI**, enter your API endpoint, key, and protocol, then choose models for chat, translation, images, and research. The built-in Go runtime calls that service directly; no external Codex, Claude Code, or Kimi CLI installation or login is required.

The key is stored by the local backend; the UI only reports whether one is configured. Model requests send the required passages, excerpts, images, and conversation context to your chosen service. Online research also queries public scholarly sources. Billing and data policies depend on the configured provider.

- Packaged libraries default to `Interleaf/library/` under the application user-data directory. Development desktop data uses `Interleaf Dev`; browser development uses the project's ignored `.interleaf/` directory.
- Original files, SQLite data, reading history, annotations, and conversations stay local. No built-in cloud sync is provided.
- Quit the app before backing up a library. A complete library may contain API configuration; remove private information before sharing it.


## Development

```sh
pnpm typecheck     # TypeScript checks
pnpm test          # Go and frontend tests
pnpm build         # Server, processor, web, desktop main process, and connector
pnpm package       # Native Windows/macOS installer build
```

```text
apps/
├── web/                 React UI and EPUB/PDF engines
├── desktop/             Electron main process and native features
├── server/              Go local service, SQLite, and AI runtime
├── processor/           Local PDF layout analysis and model
└── connector/           Browser connector
packages/
├── interleaf-core/      Shared document, position, and annotation types
├── api-client/          API client and generated types
└── ui/                  shadcn/ui and Base UI components
website/                 Static website and current screenshots
assets/                  Interleaf identity and platform icons
```

Scanned-page OCR is not available. Fixed-layout EPUB, vertical text, RTL, and complex PDF layouts need more validation. Linux installers are not provided. Native installation, security prompts, and cross-version upgrades still require manual verification.

## Publishing and updates

Keep the root and `apps/desktop/package.json` versions in sync and add notes for that version to `docs/release-notes.json`. Run checks, then execute `pnpm package` on native Windows/macOS. Installers are written to `release/`.

The automated release workflow runs when a GitHub Release is **published**; pushing code or a tag alone does not publish installers. It currently builds Windows x64 and Apple Silicon macOS together. Tagged Mac builds require the repository secrets `MAC_SIGN_P12` and `MAC_SIGN_P12_PASSWORD`; a failed platform blocks the combined upload.

Before the first release, verify installation, imports, reading, note persistence, and reopening. Use two actual installed versions to check that updates preserve data. A stable Release must include installers and `SHA256SUMS.txt`; installed apps check `Tazewell/Interleaf` for updates.

## Feedback and acknowledgements

Report problems or suggest features through [GitHub Issues](https://github.com/Tazewell/Interleaf/issues).

Thanks to Readium, PDF.js, shadcn/ui, Base UI, and the other projects used by Interleaf. Their license, font, and model notices remain in the source tree.
