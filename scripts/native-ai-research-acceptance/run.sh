#!/usr/bin/env bash
# Execute against a built Linux checkout; all state belongs to OUT.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd -P)
output=${1:?Usage: run.sh ABSOLUTE_OUTSIDE_REPOSITORY_DIRECTORY [--checks-only]}
[[ $# -le 2 && ( $# -eq 1 || "$2" = --checks-only ) ]] || { echo 'Unknown arguments' >&2; exit 2; }
[[ "$output" = /* ]] || { echo 'Output directory must be absolute' >&2; exit 2; }
output=$(realpath -m "$output")
case "$output/" in "$root/"*) echo 'Output must be outside repository' >&2; exit 2;; esac
mkdir -p "$output"
cd "$root"
if [[ "${2:-}" != --checks-only ]]; then
  node scripts/native-ai-research-acceptance/fixtures.mjs "$output"
  python3 scripts/native-ai-research-acceptance/acceptance.py "$root" "$output"
  node scripts/native-ai-research-acceptance/report.mjs "$output"
  (cd apps/server && go test -c -o "$output/interleaf-tests" ./internal/interleaf)
  pnpm --filter @interleaf/processor exec esbuild ../desktop/main/library-location.ts \
    --bundle --platform=node --format=esm --outfile="$output/library-location.mjs"
  node scripts/native-ai-research-acceptance/desktop-join.mjs "$output" "$root/apps/desktop/bin/interleaf-server"
fi
node scripts/native-ai-research-acceptance/inspect.mjs "$output"
