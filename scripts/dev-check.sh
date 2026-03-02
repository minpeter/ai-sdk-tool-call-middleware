#!/usr/bin/env bash
# Run the standard fast-feedback suite: lint, typecheck, test.
set -euo pipefail

if command -v pnpm >/dev/null 2>&1; then
  pnpm check
  pnpm test
else
  echo "[dev-check] pnpm not found; using npm/npx fallback commands"
  npm run check:biome
  npm run typecheck
  npm test
fi
