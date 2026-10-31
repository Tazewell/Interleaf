# PDF Import Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this focused repair; verify each task with RED/GREEN, then one fresh independent branch review. Steps use checkbox syntax.

**Goal:** An imported PDF must resume text translation after configuration becomes ready, preserve formula images when vision is unavailable, show honest stopped/waiting states, and finish metadata lookup attempts rather than retaining pending forever.

**Architecture:** Keep native Go model loops and existing processing/translation SSE. Configuration blocking is a waiting state before formula work; unsupported vision preserves the original formula without blocking text. Metadata lookup keeps its document owner until terminal status persistence; cancellation/deletion still wins. Reuse existing frontend primitives and retry actions.

**Tech Stack:** Go/SQLite/native API, React/TypeScript/Vitest.

**Spec:** User bug report and three screenshots, 2026-10-29; current `AGENTS.md` and `docs/agent-streaming-contract.md` native contract. Read-only reproduction found the matching document in `D:/work/myreader/interleaf-merge/.interleaf`: missing configuration at import created twelve failed formula rows before the later valid connection save; text never ran, PDF metadata Title/Author are empty, lookup remains pending. Current saved model is text-capable and not vision-verified. No user secrets belong in reports or commits.

## Global Constraints
- Work only in `codex/pdf-import-recovery`, base `3a813bd83ec3ba4f8e02b99fdb0baa6142a27bd6`; preserve unrelated main changes.
- No external Agent runtime/fallback provider, no successful partial outputs, no automatic paid replay of general model/protocol/network failures.
- Preserve successful translations, source files, reader history, manual metadata and existing privacy/SSRF/network checks. Real user library remains read-only during investigation; reproductions use temporary owned libraries and mock model endpoints.
- Do not use browser automation for visual acceptance. No dependency/version/release/push changes.

## Review Focus
- Missing connection with formula+text must wait once, not write repeated failed formulas; saving configuration wakes accepted waiting work without clobbering completed content.
- A text-only model translates text; unverified vision sends no image and keeps original formulas actionable.
- Existing failed jobs have explicit retry; do not silently replay uncertain paid work or relabel cached failure as active translation.
- Metadata HTTP errors/not-found persist failed/notFound before owner cleanup; cancellation/deletion must retain lifecycle barriers and not publish late success.
- Manual title/author/creators remain authoritative, and a failed lookup cannot starve all later documents.

### Task 1: Configuration waiting and text-only PDF translation
Files: `apps/server/internal/interleaf/formula.go`, covering formula/native/processing tests; existing processing helpers only as necessary.
- [x] Add processing regressions for missing configuration with text+formula, configuration-save wake and text-only API with formula originals; retain existing successful-content and explicit-retry coverage.
- [x] Run focused Go tests and confirm the expected behavior failures before implementing.
- [x] Apply the waiting/capability fix, keeping provider completion, source validation, cancellation and no-fallback rules.
- [x] Run covering formula/translation/native/lifecycle checks and commit a coherent fix.

### Task 2: Honest translation status in PDF/EPUB readers
Files: `apps/web/src/translation/TranslationText.tsx`, `PDFReadingView.tsx`, `EPUBReadingView.tsx`, matching tests.
- [x] Add regressions for pending paragraphs under failed, waiting, queued and paused global jobs, plus retained completed translations; run existing active-streaming controls.
- [x] Observe RED; pass actual processing state to shared translation rendering (including absent rows), show one actionable job message and existing retry behavior, preserve completed content and formula originals.
- [x] Run relevant renderer tests/typecheck and commit independently.

### Task 3: Metadata lookup lifecycle
Files: `apps/server/internal/interleaf/metadata_lookup.go`, `metadata_lookup_test.go` and related lifecycle tests.
- [x] Reproduce metadataWorker invalid HTTP response/not-found leaving pending, with a controlled HTTP endpoint and temporary parsed document; cover cancellation and later-document progress.
- [x] Observe RED; persist the terminal state while the document task still owns the operation, then release it, preserving user edits and cancellation.
- [x] Run metadata/paper/library/lifecycle checks and commit independently.

### Final verification and delivery
- [x] Run `pnpm typecheck`, `pnpm test`, `pnpm build` on settled product source; disclose actual warnings/skips.
- [x] One independent review of this repair range and a limited follow-up of its necessary fixes; no repeated old 40-paper/native research or bilingual PDF suites.
- [x] Provide a safe accessible preview/manual steps, concrete commits/results and exact remaining limitations; no claims of real paid-model success without a bounded authorized call.

## Review follow-up

Three Important findings and one Minor finding were accepted and fixed: serialize configuration readiness/wait publication without holding locks during network calls; distinguish pre-call unavailable vision from actual provider errors; retain pending for an unparsed PDF while allowing later papers to progress; respect paused state in the retry banner. Each has a regression observed failing before the fix. The same reviewer confirmed all four closed, with no deferred findings.

The original library remains read-only. A separate preview containing only the requested PDF and its parsed layout recovered the full title and twelve authors through the application's real arXiv client. Its translation correctly waits for configuration; no user key or paid model request was used. Preview interactions are for manual acceptance, with no browser automation.

Final validation passed: Go `go test ./...`, Vitest 1241 passed / 5 skipped (171 passed files / 3 skipped), typecheck and build. The fresh mirror first needed processor build output before its existing remote-parser tests could run. Full Vitest also exposed an unchanged test still expecting the old missing-attachment button label; synchronized that assertion with the existing UI in a separate test-only commit, then reran the full test command successfully. Build retains existing mixed-import/chunk-size warnings; the mirror has no Git metadata, so its build commit is unknown. Details and manual checks are in `../reports/2026-10-29-pdf-import-recovery.md`.
