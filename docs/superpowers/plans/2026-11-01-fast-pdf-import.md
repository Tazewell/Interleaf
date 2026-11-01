# Fast PDF Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make batch-imported PDFs readable and searchable before complete background layout analysis.

**Architecture:** Keep independent lightweight text and heavyweight layout lanes. Publish text availability dynamically; retain layout quality and use generation checks to prevent stale index publication.

**Tech Stack:** Go / SQLite, PDF.js processor, React / TypeScript, existing UI primitives.

**Spec:** `docs/superpowers/specs/2026-11-01-fast-pdf-import-design.md`

## Global Constraints

- Work on `dev` from independent snapshot `893e758`; author as Tazewell.
- Preserve user data, translation settings, original PDF reading and full layout quality.
- No extra inference concurrency, new dependencies, remote publishing or version changes.
- Use `Processing.textIndex?: {status: queued|running|ready|partial|unavailable|failed,totalPages:number,searchablePages:number}` across Go, core, schema and web.

## Review Focus

- Batch imports must gain text independently of a blocked layout worker.
- Parser publication during extraction must retry without saving stale provenance.
- A failed or textless PDF must not deadlock layout or claim search availability.
- Deleted documents and canceled background work must not recreate indexes/jobs.
- Existing translation, paused/failed/offline states must remain accurate.

### Task 1: Independent text queue, searchable fallback and availability contract

**Files:** `apps/server/internal/interleaf/{document_corpus.go,processing.go,cli_api.go,document_overview_generation.go}`, `apps/server/cmd/interleaf/{commands.go,fast_pdf_test.go}`, new import lifecycle tests, `packages/interleaf-core/src/index.ts`, `docs/openapi.yaml`, generated `packages/api-client/src/schema.d.ts`.

**Interfaces:** Produces the optional `Processing.textIndex` contract above. Queues retain existing status vocabulary; missing/failed text extraction must permit layout.

- [x] Add failing Go tests for batch indexing while layout remains queued/running, actual `/api/search` availability before layout, dynamic readiness including scanned PDFs, and publication retry/deletion lifecycle.
- [x] Run focused tests and confirm failures are the missing behavior.
- [x] Enable independent indexing, prioritize new documents, drain ready jobs, and gate only the same document's first layout on pending initial indexing.
- [x] Add cached corpus text fallback, generation-safe commit/requeue, and dynamic processing response fields; preserve semantic `parsed` meaning and precise page references.
- [x] Allow CLI source/both reads of cached native text with `parsed=false`; retain partial-book layout pages while supplementing missing-page text. Keep paid overviews waiting for fine layout.
- [x] Synchronize core/OpenAPI/generated types and run focused tests.

### Task 2: Show availability separately from background layout

**Files:** `apps/web/src/{ProcessingStatus.tsx,processing.test.ts}`, `apps/web/src/papers/{PaperLibrary.tsx,paper-library.test.tsx}` and existing processing UI tests as needed.

**Interfaces:** Consumes optional `Processing.textIndex`; historical responses without it retain existing behavior.

- [x] Add failing tests for ready/partial/unavailable/pending index plus running/queued/failed layout, old responses and unchanged translation controls.
- [x] Run focused Vitest tests; implement accurate concise Chinese labels and accessibility names with existing UI components.
- [x] Re-run focused tests, typecheck and formatting checks; no UI automation for visual acceptance.

### Task 3: Integrate, measure and review

- [x] Build processor before Go parser tests; run typecheck, full tests and build in suitable Windows/Linux environments, reporting platform limitations separately.
- [x] Run temporary-library batch import benchmark with repository fixtures and actual updated server/packaged processor; record time to searchable and full layout completion independently.
- [x] Request fresh review for lifecycle races and cross-layer behavior; address actionable findings and rerun affected checks.
- [x] Inspect scoped diff and staged checks, commit coherent change as Tazewell on `dev`; do not push.

## Verification results

- Clean baseline: Linux typecheck and complete tests passed (Go all; Vitest 1231 passed, 5 skipped).
- Updated exact source snapshot: Linux `pnpm typecheck`, `pnpm test` and `pnpm build` passed; Vitest 1245 passed, 5 skipped (175 files passed, 3 skipped). Windows native Go build plus the new `TestFastPDF` / `TestReadQuickPDF` tests passed. This is not a claim that the previously known unrelated Windows full-suite failures were fixed.
- Fresh review found one paid-overview boundary: learning failed/paused also needs to wait for fine layout. Confirmed RED, fixed, regression GREEN, included before full verification.
- Final error-path review separated permanent fingerprint I/O failures from retryable source changes. A real non-regular source-file regression confirmed RED then GREEN; permanent failures now terminate instead of requeueing forever. All checks were rerun after this change.
- Windows actual server + bundled processor, three unique originals of the 13-page Oze fixture: old search availability 30.206 / 58.512 / 85.934 seconds; new 2.051 / 2.268 / 2.704 seconds. New full-layout completion 28.285 / 54.401 / 81.876 seconds. This separates availability from inference speed; no Zotero runtime benchmark was performed.
- For all three originals, final page/block/model/source metadata matched; each paper's Markdown and 19 exported image files had identical SHA-256 digests before/after. No model, resolution or inference quality change.
- Manual UI acceptance remains user-operated, using a separately served preview of the temporary benchmark library. No real user library/configuration was read or changed.
