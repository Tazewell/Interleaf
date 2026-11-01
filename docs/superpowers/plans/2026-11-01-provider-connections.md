# Provider Connections Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans; follow TDD and keep edits within the assigned files.

**Goal:** Add domestic provider presets, reliable live catalogs, and conservative Bailian compatibility.

**Architecture:** Presets remain a UI draft over existing connection configuration. Server catalog refresh is scoped to connection identity. Vendor wire rules only apply to verified official origins.

**Tech Stack:** Existing React/Base UI, TypeScript API client, Go HTTP and provider profiles.

**Spec:** `docs/superpowers/specs/2026-11-01-provider-connections-design.md`

## Tasks

- [x] Catalog: add RED tests for upstream refresh, race protection, successful listings excluding historical IDs and failed listings retaining manual input. Implement server/cache/API-client/TaskModels contract and synchronize OpenAPI.
- [x] Presets: verify official endpoints, add RED tests for provider selection/custom fields and credential/model boundaries, then implement using existing Select/Input primitives.
- [x] Bailian: reproduce actual payloads with fake transport, add official-origin isolation and conservative/verified effort mapping, parse top-level safe errors, and run provider regressions.
- [x] Review exact scoped diffs; run typecheck, Go+Vitest tests and build. Fix actual failures and protect user data.
- [x] Commit independent coherent changes as Tazewell on dev; do not push, tag or publish a release. Refresh temporary preview for manual verification.

## Verification notes

- TDD reproduced the successful-catalog historical merge, five-minute refresh cache, late-discovery cache restoration, stale UI options, missing provider picker, credential/model draft boundaries and unverified Bailian effort payload. Each was observed failing before implementation.
- Cross-review caught a Bailian date-suffix heuristic that could promote an unverified future model ID into an official rule. Added a failing future-ID regression and changed Bailian to exact model-ID matching. Review also confirmed cache generation, strict configuration identity and secret-safe error handling.
- Provider draft changes disable model selection, saving and checks until connection save succeeds. Tests cover the real component controls.
- Exact-source Linux typecheck, complete Go tests, Vitest (1291 passed, 5 skipped) and production build passed. Native Windows provider/catalog protocol regression tests and Go server build passed. The existing Windows POSIX file-mode migration assertion remains outside this change.
- Tests use local fake endpoints/keys and captured HTTP payloads. No live provider paid readiness call or actual API key read was performed; the supplied safe diagnostic trace proves the sent effort and HTTP400, not the exact upstream rejection reason.
