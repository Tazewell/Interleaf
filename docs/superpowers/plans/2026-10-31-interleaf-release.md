# Interleaf Independent Release Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline.

**Goal:** Publish and update the independent Interleaf application from Tazewell/Interleaf.
**Architecture:** Retain the existing Electron/Go/React release pipeline. Change public identity consistently across updater, installer, UI, protocol, data location and documentation. Internal workspace package names and API headers remain compatible.
**Tech Stack:** Electron, electron-builder, GitHub Actions, TypeScript, Go.
**Spec:** User requested Interleaf, repository Tazewell/Interleaf, removal of the previous repository owner's current information, and updates from their own repository.

## Constraints
- App ID io.github.tazewell.interleaf; product Interleaf; protocol interleaf; development data Interleaf Dev.
- Installer prefix Interleaf, matching update selection, CI and checksums.
- Origin https://github.com/Tazewell/Interleaf.git. Preserve Git history and third-party notices.
- Preserve the existing library; do not automatically copy or modify old application data.
- No remote creation, push, tag or public release in this task.

## Tasks
- [x] Add failing tests for independent update assets, old protocol rejection and old app ownership rejection.
- [x] Change application identity, public labels, download/update/feedback URLs and data defaults. Keep internal interfaces intact.
- [x] Update installer scripts, release validation, workflows and current project documentation. Remove stale owner references without inventing new issue/PR links.
- [ ] Run focused update/protocol/CLI/release tests and typecheck, inspect diff, commit and integrate into the main checkout preserving unrelated edits.
- [x] Document initial repository/CI signing setup and an installed-old-to-new manual upgrade check.

## Review focus
- New installations never fetch assets from the former release source.
- New app data and links do not claim the old application identity.
- Asset filenames match build output and checksum discovery on both platforms.
- Existing user library files are untouched.
- No former-owner URLs remain in current tracked files; third-party licenses stay intact.

## Execution ledger

- Ruling: preserve internal package names, API headers and CLI executable name; these are compatibility contracts, not former-owner information.
- Ruling: isolate Connector too; review found the old extension identity and port could route imports to the other application. New public key/ID and port 17842 now have a real-handler regression test.
- TDD: initial independent update/data/protocol tests failed (3) before implementation; Connector handshake failed (403) before its isolation fix.
- Verification: 92 related tests pass; desktop/connector/processor builds pass. Full Go run initially needed the worktree processor build; rebuilt and the complete Go suite now passes. Project typecheck passes. Whole-branch review found and fixed a search-fixture mismatch and Connector isolation.
