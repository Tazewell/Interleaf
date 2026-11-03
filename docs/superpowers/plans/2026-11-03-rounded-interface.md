# Rounded Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement the approved library, reader, import and settings sketches using existing real app flows.

**Architecture:** A shared Base UI TabsList wrapper adds optional drag-to-snap interaction while retaining native tab semantics. Scoped styles load after the existing stylesheet; feature owners modify separate components/styles so backend and data flows stay unchanged.

**Tech Stack:** React 19, TypeScript, Base UI/shadcn, CSS, Vitest; existing Go API.

**Spec:** `docs/superpowers/specs/2026-11-03-rounded-interface-design.md`

## Global Constraints

- Existing dev worktree only; no merge, push, release, new dependencies or user-data changes.
- Preserve all real APIs, credentials semantics, annotation/session data and existing import safeguards.
- Use existing UI primitives and semantic appearance tokens; reduced motion, keyboard controls and native desktop chrome remain supported.
- Styling changes do not need implementation-mirroring tests; new gesture/navigation boundaries require meaningful regressions.
- Each owner writes separate feature CSS. Root wires CSS imports in `main.tsx` after `style.css` and owns global tokens/library files.

## Review Focus

- Drag cancel, rapid switching, disabled tabs, resize and externally changed selection must never commit an unintended mode.
- Library selection/search/sort/resizers, metadata edits and research entrances must remain reachable.
- An import error or in-flight operation must not discard input, switch providers or bypass merge confirmation.
- Inactive settings content must not save hidden drafts or erase keys; model choices must come only from refreshed catalogs.
- Narrow windows, dark/sepia appearance, text scaling and macOS drag regions must keep essential controls visible and legible.

### Task 1: Shared segmented interaction and library shell (root)

**Files:** new `apps/web/src/controls/SlidingTabsList.tsx`, tests; `App.tsx`, `LibraryModeSwitcher.tsx` if used, `papers/PaperDetail.tsx`, library-related markup; new `rounded-interface.css`, `main.tsx`.

**Interfaces:** `SlidingTabsList` accepts the same props as `TabsList` and is used inside existing `Tabs` with ordinary `TabsTrigger` children. It commits by activating the target native tab only at pointer release; click and keyboard stay owned by Base UI. CSS class `sliding-tabs-list` is shared by all consumers.

- [x] Write RED regressions for drag release/cancel/disabled targets/external selection; implement wrapper and prove GREEN.
- [x] Replace top library mode buttons with controlled Tabs using the wrapper and existing switchMode callback; adapt meaningful existing app navigation tests.
- [x] Apply shared semantic colors, rounded library surfaces and detail overview/info tabs without removing actions/fields.
- [x] Run focused tests/typecheck; inspect and commit scoped changes.

### Task 2: Reading toolbar and conversation (reader agent)

**Files:** `Workspace.tsx`, `translation/PDFReadingView.tsx`, `translation/EPUBReadingView.tsx`, chat presentation files, new `reader-rounded.css`, relevant tests.

**Interfaces:** consume `SlidingTabsList` from `../controls/SlidingTabsList` in translation modules (adjust relative paths elsewhere); do not change the wrapper or shared CSS/global library files.

- [x] Retain adapter/translation/session lifecycles; use the shared sliding list for embedded mode controls and appropriate panel tabs.
- [x] Refine chat hierarchy, real pending states, quote/image cards and compact composer to the approved sketch; no fabricated progress.
- [x] Add a behavioral regression only when presentation changes alter pending-state or reference behavior; run reader/chat/composer tests.
- [x] Report exact files, verification and limitations; leave changes uncommitted for root integration.

### Task 3: Settings surfaces (settings agent)

**Files:** `Settings.tsx`, `ai/AISettings.tsx`, optional tightly coupled settings presentation components, new `settings-rounded.css`, relevant tests.

**Interfaces:** consume shared `SlidingTabsList` from `./controls/SlidingTabsList` or `../controls/SlidingTabsList`. Root imports CSS. Preserve all six categories and real config save/probe/catalog flows; reorganize AI connection/models/translation prompt as real sub-tabs.

- [x] Update Base UI navigation/layout and appearance controls to the approved rounded design.
- [x] Group AI content without replacing real fields, API key persistence rules, models or tests with mock data.
- [x] Test tab switching retains drafts, provider/catalog guards still work, and current settings tests pass.
- [x] Report changes and tests; no commit or other owner's files.

### Task 4: Import surfaces (import agent)

**Files:** `papers/ImportPaperDialog.tsx`, `BibliographyImportDialog.tsx`, `ZoteroImportDialog.tsx` presentation if necessary, new `imports-rounded.css`, relevant tests.

**Interfaces:** consume shared `SlidingTabsList`; retain `ImportPaperDialog {open,onOpenChange,onChooseFiles(folder)}` public props. Reuse true BibTeX content in an embedded form or controlled child dialog, preserving standalone import support and all confirmations. Do not modify App/global styles.

- [x] Use four meaningful entry tabs and existing classified reference/native-file/migration/BibTeX flows.
- [x] Preserve busy/close/error/merge-confirmation boundaries; no fake queue or progress, no new import API.
- [x] Add regressions for tab/input retention and classification/embedded BibTeX as appropriate; run import suites.
- [x] Report files and checks; leave scoped changes uncommitted.

### Task 5: Integration, review and preview (root)

- [x] Review each feature diff against the approved spec; resolve material interaction issues with regressions.
- [x] Wire all styles, run `pnpm typecheck`, `pnpm test`, `pnpm build` against the exact tree in the configured environment.
- [x] Perform fresh-context final review; keep existing users' data/config untouched.
- [x] Update owned preview, verify assets and readiness without paid model calls or browser automation.
- [x] Commit coherent changes as Tazewell, ensure clean dev/main unchanged, report preview and manual verification steps.

## Verification record — 2026-11-03

- Independent review found nested tab orientation leakage and pointer-click focus handoff; both were fixed. Release/focus regressions were observed failing before the fix and passed afterward, including focus-activated tabs without duplicate selection.
- Final `pnpm typecheck`, `pnpm test --maxWorkers=4`, and `pnpm build` passed against an exact copy of the final 893 source files in the existing WSL verification environment. Go packages passed; Vitest reported 184 files passed, 3 skipped, with 1,338 tests passed and 5 skipped.
- Updated the owned loopback preview using verified web assets. HTTP readiness confirmed the new entry assets and the generated own-orientation horizontal segment rule; no user library or API configuration was changed.
- Browser visual acceptance was not automated, following AGENTS.md. The user can check the library/detail tabs, drag and keyboard mode switching, import draft retention and settings in light/dark/sepia appearances. Native touch feel, macOS chrome and display scaling still require manual inspection on the corresponding devices.
- Implementation remains on `dev`; no merge, push or release was performed.
