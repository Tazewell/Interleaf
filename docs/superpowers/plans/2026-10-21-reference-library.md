# Interleaf Reference Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved PDF-first independent reference library, stable citations, BibTeX/BibLaTeX interchange and managed local exports, with tests.

**Architecture:** Add a PaperItem above existing file-based Documents. Preserve document IDs and all reader state, and adapt legacy metadata writes to the item authority. Put bibliography parsing/serialization and export-file ownership into focused Go modules; React uses existing library components and Electron authorizes persistent file targets.

**Tech Stack:** Existing Go/SQLite, React/TypeScript, Electron, pnpm/Vitest; no new runtime dependency unless justified.

**Spec:** `docs/superpowers/specs/2026-10-21-reference-library-design.md`

## Global Constraints

- Chinese user-facing text; existing packages/ui primitives; loopback authenticated API only.
- Preserve Document IDs, original files, annotations, chat, translations, EPUB locators and existing CLI/Connector/import compatibility.
- PaperItem is metadata authority. No silent metadata overwrite, paper merge, citation-key change, or external .bib overwrite.
- No visual browser automation. Use temporary test libraries, accessible desktop preview and manual steps.
- Work on codex/reference-library-design; commit coherent validated tasks; do not push.
- User explicitly approved implementation and testing: proceed through all tasks without asking for another plan approval.

## Review Focus

1. Migration restart/failure and attachment reparenting must not lose reader state (Task 1 real SQLite tests).
2. Concurrent first citations, deleted keys and metadata changes must not reuse or rename existing keys (Task 1 transaction tests).
3. TeX braces/macros/unknown fields and dependency records must survive .bib interchange (Task 2 fixtures).
4. External file edits, symlinks and failed replacement must preserve existing export bytes (Task 3 filesystem tests).
5. Metadata-only papers and secondary attachments must remain editable without accidentally invoking a nonexistent reader (Task 4 interaction tests).

---

### Task 1: Paper item authority, attachments, migration and stable keys

**Files:** Create `apps/server/internal/interleaf/paper_items.go`, `paper_items_test.go`, `citation_keys.go`; modify `store.go`, `server.go` and focused integration points. Add shared types in `packages/interleaf-core/src/papers.ts`, exported by `index.ts`. Task 4 owns OpenAPI/client generation.

**Interfaces:**
- `PaperAttachment` JSON: `documentId`, `role` (original/translation/supplement/other), `title`, `type`, `size`; primary is recorded on item.
- `PaperItem` JSON: `id,title,author,metadata,tags,folders,favorite,createdAt,deletedAt?,primaryDocumentId,citationKey,attachments`.
- Store: `PaperItems() ([]PaperItem,error)`, `PaperItem(id string) (PaperItem,error)`, `EnsureCitationKeys(ids []string) ([]PaperItem,error)`.
- HTTP: GET/POST `/api/papers`; GET/PATCH/DELETE `/api/papers/{id}`; POST `/{id}/trash`, `/{id}/restore`, `/{id}/merge`; PUT/DELETE `/{id}/attachments/{documentId}` (role and primary); POST `/api/papers/citation-keys` accepts `{ids:string[]}` and returns PaperItem[].
- PATCH accepts title/author/metadata/tags/folders/favorite/primaryDocumentId/citationKey. Merge accepts `{ids:string[],citationKey?:string,confirmCitationChange?:boolean}` and must reject unresolved distinct-key merges.
- Legacy Document responses add optional `paperId`, `citationKey`; their IDs and file endpoints stay unchanged. Empty-paper DELETE is permanent; attached-document disposal uses existing lifecycle with correct cancellation. Paper trash/restore is distinct from detach.

- [ ] Write real-store/API tests: migration preserves annotations/progress/notes/files and is idempotent; creating metadata-only item; attachment roles/primary/reparent constraints; old metadata PATCH/lookup/import writes visible through PaperItem; merge retains both documents; item trash/restore; stable keys across metadata update/reopen/subset/order/collision/delete and concurrent allocation.
- [ ] Run `go test ./internal/interleaf -run 'TestPaper|TestCitationKey' -count=1` and observe the missing-feature failures before implementation.
- [ ] Implement transactional additive migration with a pre-migration SQLite snapshot, compatibility integration and focused routes. Retain tombstones for used keys. Reject invalid input and missing IDs atomically.
- [ ] Run the focused tests, then `go test ./internal/interleaf` and record pre-existing failures separately rather than weakening tests.
- [ ] Review/stage only this task; commit `feat(papers): add independent items and stable citation keys`.

### Task 2: Bibliography interchange and reference API

**Files:** Create `apps/server/internal/bibliography/{bib.go,bib_test.go}` and `apps/server/internal/interleaf/paper_bibliography{,_test}.go`. No unrelated store or UI changes.

**Interfaces:**
- Package bibliography: `Parse(text string) (Database,error)`, Database holds entry kinds/keys/raw field expressions/string macros/preambles; `Render(Database) (string,error)` preserves unedited data; semantic string lookup resolves macros/concatenation with cycle checks.
- Interleaf: `Bibliography(ids []string, mode string) (string,error)` on Store; uses Task 1 keys, emits BibTeX or BibLaTeX with preserved unknown expressions/dependencies.
- POST `/api/papers/bibliography/preview` accepts `{text:string}`, returns `{entries: [{index,key,title,matchedId?,warnings: string[]}],errors?:...}`.
- POST `/api/papers/bibliography/import` accepts `{text:string,decisions:[{index,action:'create'|'merge'|'skip',paperId?,citationKey?}],confirmCitationChange?:boolean}`; returns PaperItem[]. Validate all decisions before any writes, preserve manual fields/keys, reject ambiguous unresolved collisions. Register routes in a focused registration function invoked by Handler.
- POST `/api/papers/bibliography/export` accepts `{ids:string[],mode:'bibtex'|'biblatex'}` returns `{text:string}`. `Store.Bibliography` is also the single source for Task 3 managed exports.

- [ ] Write parser fixtures asserting literal values and round trips for nested braces/escaped quotes/UTF-8/institution authors/unknown fields/@string/#/crossref, with malformed input and macro cycles rejected. Write API tests for preserving imported keys, merging without overwriting manual edits, transactional conflicts, missing crossref dependencies and subset export.
- [ ] Run `go test ./internal/bibliography ./internal/interleaf -run 'TestBib|TestPaperBib' -count=1`; observe RED.
- [ ] Implement focused parser and serializer, shared semantic metadata mapping and preview/commit/export routes. Treat all fields as data; never execute TeX or follow file paths.
- [ ] Run parser/API tests and a local minimal BibTeX/BibLaTeX compile when runtime is available; otherwise install an isolated compiler or record the exact unavailable check, not a false pass.
- [ ] Inspect/stage task files and commit `feat(citations): import and export BibTeX and BibLaTeX`.

### Task 3: Managed exports and desktop authorization

**Files:** Create `apps/server/internal/interleaf/bibliography_exports{,_test}.go`, `apps/desktop/main/bibliography-export{,.test}.ts`; modify `main/index.ts`, `preload/index.ts`, renderer desktop declarations, server lifecycle registration.

**Interfaces:**
- `BibliographyExport` JSON: `id,folder,includeChildren,mode,path,lastExportedAt,error` with internal persisted fingerprint/authorization identity.
- GET `/api/papers/exports`, POST `/api/papers/exports/{id}/refresh`, DELETE `/api/papers/exports/{id}`; target registration is a server-to-desktop privileged path with a per-server capability passed only to Electron main, never exposed to renderer. Existing regular token alone cannot register arbitrary paths.
- Desktop `interleafDesktop.configureBibliographyExport({folder,includeChildren,mode})` chooses a destination natively, confirms backup/takeover of existing file, registers it with server and returns an export or null. Browser mode supports downloads only.
- Store.Bibliography from Task 2 supplies bytes. Exports use folder membership, optional descendants, stable sorted output, serial writes, atomic replacement and external-edit detection; run startup refresh and a bounded background reconciliation loop while server runs.
- Folder rename must update the bound export folder (including descendants) together with library labels; deleting a bound folder pauses its managed export and retains the last file until explicitly reconfigured. Removing individual papers from an existing folder still updates its membership normally.

- [ ] Write filesystem tests: initial creation, folder filtering, crossref inclusion, content change, external edit pause, missing parent, write failure preserving bytes, symlink refusal, conflicting paths/configs, restart recovery, folder rename/delete and unauthorized registration. Native-dialog tests mock Electron only at IPC/dialog boundary and assert actual target registration and cancellation behavior.
- [ ] Run the focused Go and Vitest cases, observing RED before implementation.
- [ ] Implement target authorization, ownership, backups and reconciliation; attach to existing context cancellation. Do not serve arbitrary filesystem writes through a renderer-controlled path.
- [ ] Run focused lifecycle/security tests and commit `feat(citations): add managed bibliography exports`.

### Task 4: Library integration, OpenAPI, workflow verification and preview

**Files:** Modify `apps/web/src/store.ts`, focused `papers` components/actions/citation modules; create `PaperAttachments.tsx`, `BibliographyImportDialog.tsx`, `BibliographyExportDialog.tsx` and interaction tests; modify `docs/openapi.yaml`, regenerate `packages/api-client/src/schema.d.ts`, add transport helpers in `packages/api-client/src`. Add user guide `docs/reference-library.md`.

**Interfaces:**
- Keep raw `documents` for reader/CLI state; load `paperItems` and project a paper-library Document view with `paperId`, stable key, attachment list and selected primary document. Preserve the raw Document ID when opening attachments.
- Route paper-level edits to `/api/papers/{paperId}` and file-level actions to existing Document routes. Metadata-only projection cannot open reader; its edit/cite/tag/folder/trash controls remain available.
- CitationDialog uses server export for .bib and persistent keys for other formats; add BibLaTeX and copy-key/LaTeX controls. New .bib import preview and folder export controls reuse packages/ui dialogs/buttons/selects.
- Include all new API types/operations in OpenAPI and generated transport; avoid hand-editing generated declarations.

- [ ] Add interaction tests showing metadata-only item editing/citation, opening secondary attachment, distinct paper/file delete actions, stable citation export across reordering, .bib import preview with explicit conflict decisions, and browser versus desktop managed export behavior.
- [ ] Run relevant Vitest tests first and observe RED, then implement library projection, dialogs, actions and IPC typing. Preserve UI restraint and existing library functions.
- [ ] Generate API types; run `pnpm typecheck`, `pnpm test`, `pnpm build`, investigate all failures; add meaningful regression cases for fixes rather than weakening checks.
- [ ] Test a temporary library with import/metadata edit/attach/merge/trash/restore/citation/auto-export over authenticated HTTP. Compile minimal LaTeX examples with the generated bibliographies. Provide a runnable desktop preview plus manual Overleaf upload steps; do not automate visual acceptance.
- [ ] Commit logical UI/API/docs changes separately where independently valid. Dispatch fresh whole-branch code review; resolve material findings with RED→GREEN tests and rerun affected checks.
- [ ] Deliver commit hashes, exact validation results, preview launch path, manual checks and any actual limitations. Leave branch ready for review; no merge or push without explicit request.
