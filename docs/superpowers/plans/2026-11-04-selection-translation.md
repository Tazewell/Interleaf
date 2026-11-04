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

- [ ] Inspect the referenced LobeChat repository via its primary source.
- [ ] Update assistant identity, management entry and labeled manager actions; keep existing confirmations and lifecycle.
- [ ] Run conversation suites and commit scoped changes.

### 2. Cancellable inline translation card

- [ ] Add RED regressions for inline rendering, debouncing, replacement/cancellation and retry.
- [ ] Extend SelectionTranslation with `inline?: boolean` and `delayMs?: number`, retaining standalone compatibility.
- [ ] Match rounded/green-neutral reading surfaces and prove focused tests GREEN.

### 3. Selection surface and integration

- [ ] Test a toolbar content slot, outside/Escape/scroll dismissal and interaction within its card/portaled menus.
- [ ] Integrate the card below actions, preserving the active source snapshot and all existing quote/annotation paths.
- [ ] Add the opt-in preference and menu/settings controls; test automatic/manual/off/replacement and document boundaries.
- [ ] Commit the coupled selection change after focused checks.

### 4. Review and preview

- [ ] Review pointer/menu/native-selection lifecycle and stale-request boundaries independently.
- [ ] Run typecheck, tests and build against the final source tree.
- [ ] Update the owned preview and verify current assets; report user-facing behavior and dev commits.
