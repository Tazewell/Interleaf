# Interleaf Project Identity Implementation Plan

> Execute inline with executing-plans. User explicitly requested renaming ./reader and its project identities to Interleaf; proceed without another design approval.

**Goal:** Rename the current checkout to Interleaf and remove legacy project identity from active source/build/distribution. Preserve actual user data and API settings.
**Architecture:** Existing Go/Electron/React architecture, no UI redesign or dependency upgrades. Lowercase interleaf for package, CLI and filesystem identifiers; Interleaf for display names.

## Global Constraints
- Only D:/work/myreader/reader; sibling projects and Git history remain intact.
- Generic Reader interfaces and external Readium/standard-library names retain their technical meanings.
- No secret values in logs, commits or reports. Local .reader is moved to .interleaf after clean shutdown.
- Database/lock filenames use interleaf; preserve legacy database recognition and migration for existing libraries.
- Full source rename is one coupled commit; directory move occurs only after validation and merge.

## Review Focus
- Backend auth headers, IPC and frontend bridges use matching names.
- Existing databases, backups and AI settings survive migration, and locks still prevent two writers.
- CLI discovery and packaged binary paths match build outputs on Windows/macOS.
- Workflow artifacts and updater checksums retain matching Interleaf names.
- No replacements inside third-party APIs or public dependency names.

### Task 1: Rename internal identity and retain data compatibility
1. Update existing distribution assertions to expect @interleaf, interleaf-server and interleaf CLI; run and observe failure.
2. Rename workspace namespaces, Go module/package/commands, env vars, IPC, HTTP headers, source paths and documentation consistently. Update lockfile links without dependency upgrades.
3. Add data compatibility coverage before implementing database fallback: existing reader.sqlite libraries remain readable; fresh libraries use interleaf.sqlite; never overwrite an existing database.
4. Run typecheck, Go tests, scoped desktop/CLI/link tests, build and secret/source checks. Review then commit.

### Task 2: Apply checkout/data move
1. Stop only the preview processes recorded for this checkout; checkpoint SQLite and record row counts and credential hashes privately.
2. Merge task into main; rename checkout reader to Interleaf and ignored library .reader to .interleaf. Preserve all files.
3. Repair Git worktree metadata and workspace links; build/start Interleaf from the final path.
4. Verify library counts, credential hashes, HTTP auth, document listing, current sources and release-source validation. Remove only the temporary worktree. Report final path, validation and remaining release prerequisites.

## Execution findings
- Typecheck and full production build passed; the first JS suite exposed an EPUB CSS class mismatch, fixed and verified by its 26 tests.
- The final reviewer found old settings and chat protocol compatibility gaps. Real legacy fixtures failed first; startup now copies settings without replacing newer values, legacy image JSON decodes, and the opaque persisted conversation-key namespace stays unchanged.
- Review also found CLI copy and storage consumers; both now use Interleaf names. A legacy shortcut fixture exposed custom binding loss, addressed with read compatibility.
- Deliberate retained names: standard-library/third-party Reader APIs, generic reading interfaces, old-data compatibility constants/fixtures, and Git history. Removing these would break integrations or data continuity.
- Native worktree creation rejected the nested repository sourceRoot; Git worktree fallback at /home/admin/interleaf-project-rename was used. ONNX postinstall download failed; workspace dependency installation reused cached packages with scripts disabled, followed by explicit asset preparation and processor build. No dependency versions changed.

## Verified before merge
- pnpm typecheck: passed.
- Full Vitest suite: 174 files / 1,259 tests passed; 3 files / 5 tests skipped by their existing platform/integration conditions.
- Full Go suite: passed, including legacy settings/image/locking compatibility.
- Production processor, web, desktop and connector builds passed; backend rebuilt after compatibility fixes.
- Renamed source secret scan: 938 files; the same four known public-key/demo/test matches, no new findings.
