#!/usr/bin/env bash
# Run from a dependency-complete Linux checkout after pnpm build.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd -P)
output=${1:?Usage: bash scripts/bilingual-pdf-acceptance/run.sh ABSOLUTE_OUTPUT_DIRECTORY}
[[ "$output" = /* ]] || { printf 'Output directory must be absolute\n' >&2; exit 2; }
mkdir -p "$output"
output=$(realpath "$output")
case "$output/" in
  "$root/"*) printf 'Output directory must be outside the repository\n' >&2; exit 2 ;;
esac
cd "$root"
node scripts/bilingual-pdf-acceptance/fixtures.mjs "$output"
pnpm --filter @interleaf/processor exec esbuild ../desktop/main/bilingual-pdf-export.ts \
  --bundle --platform=node --format=esm --packages=external --outfile="$output/native-save.mjs"
(cd apps/server && go build -o "$output/interleaf-server" ./cmd/interleaf-server)
python3 scripts/bilingual-pdf-acceptance/acceptance.py "$root" "$output"
node scripts/bilingual-pdf-acceptance/inspect.mjs "$output"
