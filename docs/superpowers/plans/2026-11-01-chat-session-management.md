# Chat Session Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-session management and deletion in the document conversation sidebar.

**Architecture:** A document-scoped DELETE endpoint performs transactional cleanup under the existing chat lifecycle lock. SessionPicker provides a management dialog and destructive confirmation; Workspace owns selection, draft, registry and annotation reconciliation.

**Tech Stack:** React, Base UI, TypeScript, Go, SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-chat-session-management-design.md`

## Global Constraints

- Work only in the existing dev worktree; do not merge, push or publish.
- Preserve documents, source files, notes, annotation content and other sessions.
- Reject deletion during active/reserved generation with HTTP 409; never cancel accepted work implicitly.
- Reuse existing UI primitives, API transport and document-task lifecycle; add no dependencies.
- Author commits as Tazewell; verify and stage only the files belonging to each change.

## Review Focus

- Wrong-document IDs must not delete or expose a session.
- A database failure must roll back message, annotation and continuation cleanup together.
- An active request or reservation must prevent deleting a session that can still write.
- Deleting the last/current/noncurrent session must produce the correct selection while preserving unrelated drafts.
- Old poll or mutation responses must not resurrect deleted sessions or modify another document.

### Task 1: Transactional deletion API

**Files:** `apps/server/internal/interleaf/chat_sessions.go`, `server.go`, new `chat_session_deletion_test.go`, `packages/interleaf-core/src/index.ts`, `packages/api-client/src/index.ts`, `docs/openapi.yaml`, generated `packages/api-client/src/schema.d.ts`, API-client contract tests.

**Interfaces:** `DELETE /api/documents/{id}/chat-sessions/{session}` returns `ChatSessionDeletion { ok: boolean; unlinkedAnnotationIds: string[]; replacement?: DocumentChatSession }`; missing/wrong-document target is 404; active/reserved generation is 409.

- [x] Write failing handler tests for isolated cleanup, annotation unlinking, last-session replacement, cross-document/missing targets, active/reserved protection and transactional rollback.
- [x] Run them against the old server and observe the missing DELETE route fail.
- [x] Implement the locked transaction, register the route, add the typed client/schema, and regenerate API types.
- [x] Run focused Go and client tests; commit the complete API contract with its tests.

### Task 2: Management UI and frontend lifecycle

**Files:** `apps/web/src/chat/SessionPicker.tsx`, `session-picker.test.tsx`, `session-registry.ts`, registry tests, `apps/web/src/Workspace.tsx`, workspace lifecycle tests.

**Interfaces:** SessionPicker accepts `onDeleted(id: string, result: ChatSessionDeletion): void`. Workspace removes the cached session/draft, reconciles unlinked annotations and replacement metadata, and invalidates older list responses.

- [x] Write failing UI tests for per-row rename/delete, cancellation, retry, pending duplicate-click protection, running-state protection and stale document mutations.
- [x] Write failing lifecycle tests for current/noncurrent/last deletion, registry disposal and stale polling; assert unrelated draft content remains.
- [x] Implement management and confirmation with existing components; keep deletion targets independent from the selected session.
- [x] Run focused tests and typecheck; commit the cohesive UI/lifecycle change.

### Task 3: Verify and preview

- [x] Run full Go/Vitest tests, typecheck and production builds; inspect actual output.
- [x] Perform one final fresh-context branch review and resolve material findings.
- [x] Build a native Windows server and test the new endpoint against an isolated temporary library.
- [x] Update the owned preview only when no generation is active, preserving its token, library and saved provider configuration.
- [x] Confirm main remains unchanged and the dev worktree is clean; report commit hashes and manual preview steps.

## Verification results (2026-11-02)

- Exact source copied into the existing WSL verification checkout; `pnpm typecheck`, `pnpm test --maxWorkers=4`, and `pnpm build` exited 0. All Go packages passed; Vitest: 182 files / 1314 tests passed, 3 files / 5 tests skipped.
- Native Windows focused deletion/annotation undo tests and 33 focused renderer tests passed. Native Windows server build and isolated-library HTTP smoke passed: target deletion, last-session replacement, deleted-target 404 and document preservation.
- The full native Windows Go attempt failed on environment prerequisites: `TestNativeAIConfigMigrationAndKeyEdits/API_primary_migrates_roles_secrets_once_without_touching_documents` (Unix file-mode assertion), `TestResearchNetworkReadFailureAfterExplicitImport`, `TestResearchRemoteRealPDFAndAbstractFallback`, `TestResearchRemoteMIMEClassification` (missing processor build), `TestBookChapterParsesOnlyItsPagesThenTranslates` (local parser startup), and `TestBookChapterRetryReusesParsedBatches` (missing parsed manifest). The configured WSL full run passed these tests.
- Full Vitest initially exposed `task-models.test.tsx` selecting a closing popup retained for its exit transition. Its helper now checks the trigger's expanded state and reads the active model menu; the full rerun passed.
- Fresh review identified delayed annotation PATCH responses restoring deleted answer links in the renderer. Two tests reproduced this before the fix; deleted answer IDs now remain filtered from every annotation state update while keeping saved note content.
- Preview `http://127.0.0.1:65006/` runs the new native server and verified renderer. No active chat runs existed before startup. Provider configuration hash remained identical; user conversations were not deleted for smoke testing.
- API: `029abdd`; manager/lifecycle: `7716af1`; delayed answer fix: `489293a`; selector test stability: `2b1b22f`. Main remains `e30ffdb`; no merge, push or release.

Manual check: refresh the preview, open a paper, use the conversation toolbar's “会话管理” button, rename or switch a row, then open deletion confirmation and cancel or confirm. Running sessions require stopping first.
