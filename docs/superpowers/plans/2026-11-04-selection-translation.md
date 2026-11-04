# Inline Selection Translation Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans; keep independent chat and selection files disjoint.

**Goal:** Make conversation management discoverable and offer optional automatic AI translation directly below selected-text actions.

**Architecture:** Reuse the authenticated selection translation endpoint and the existing reader settings persistence. Place a cancellable, debounced translation card in the selection toolbar surface; keep the source selection snapshot for all existing annotation and quote actions.

**Tech Stack:** React, TypeScript, Base UI, existing Go API, Vitest.

**Spec:** User browser comments on 2026-11-04; rounded visual baseline in `docs/superpowers/specs/2026-11-03-rounded-interface-design.md`.

## Requirements and constraints

- Assistant display name becomes Interleaf. Conversation management uses an always-visible icon and text; rename/delete remain explicit, with existing running-session and confirmation safeguards.
- Selection translation appears immediately below the selected-text action row in the same rounded surface. Manual translation keeps the original selection available.
- Add persisted `autoTranslateSelection`, default false. Expose it in the selected-text menu and reading settings. Enabling it translates settled selections after 350ms; disabling it cancels automatically started translation.
- Replaced, dismissed and unmounted selections cancel timers/requests; late responses cannot overwrite newer text. Retry is explicit. Do not add history messages or alter document-wide translation.
- Preserve source anchors/context, PDF/EPUB distinctions, note/highlight/quote actions, keyboard interaction, theme and narrow-pane containment.
- Stay in existing dev worktree, no merge/push/release or dependencies. Do not access real keys or make paid model calls. No browser automation for visual acceptance.

## Tasks

### 1. Conversation identity and discoverability

- [x] Inspect the referenced LobeChat repository via its primary source.
- [x] Update assistant identity, management entry and labeled manager actions; keep existing confirmations and lifecycle.
- [x] Run conversation suites and commit scoped changes.

### 2. Cancellable inline translation card

- [x] Add RED regressions for inline rendering, debouncing, replacement/cancellation and retry.
- [x] Extend SelectionTranslation with `inline?: boolean` and `delayMs?: number`, retaining standalone compatibility.
- [x] Match rounded/green-neutral reading surfaces and prove focused tests GREEN.

### 3. Selection surface and integration

- [x] Test a toolbar content slot, outside/Escape/scroll dismissal and interaction within its card/portaled menus.
- [x] Integrate the card below actions, preserving the active source snapshot and all existing quote/annotation paths.
- [x] Add the opt-in preference and menu/settings controls; test automatic/manual/off/replacement and document boundaries.
- [x] Commit the coupled selection change after focused checks.

### 4. Review and preview

- [x] Review pointer/menu/native-selection lifecycle and stale-request boundaries independently.
- [x] Run typecheck, tests and build against the final source tree.
- [x] Update the owned preview and verify current assets; report user-facing behavior and dev commits.

## Verification record

- Conversation management follows the icon-plus-named-actions pattern verified in [LobeHub's topic menu](https://github.com/lobehub/lobehub/blob/canary/src/features/AgentSidebar/Topic/List/Item/useDropdownMenu.tsx). Existing session confirmation and running-session tests passed.
- Independent review identified EPUB selection/location event ordering and native selection clearing on a nonvisual preference change. Both received RED-to-GREEN regressions; changing only the automatic-selection preference now preserves the PDF/EPUB adapter selection, while actual rendering changes still apply.
- Final typecheck, full Go/Vitest tests and production build passed in the existing WSL verification environment against the exact 899-file source snapshot: 1,366 tests passed, 5 skipped.
- Verified source hashes before updating the owned preview. Current assets include the inline card, preference and manager entry; an authenticated empty-input probe confirms the native endpoint returns validation HTTP 400 before generation. No paid model call or real user configuration mutation was performed.
- Visual acceptance remains manual under AGENTS.md. Automatic translation is opt-in, stored with reading preferences, and does not create chat messages. Dev was preserved without merge, push or release.
