#!/usr/bin/env bash
set -o pipefail

# Infinite loop to run pnpm fmt and delegate failures to cursor-agent.
while true; do
  echo "Running pnpm fmt -- --max-diagnostics 10..."
  if ! output=$(pnpm fmt -- --max-diagnostics 10 2>&1); then
    status=$?
    printf 'pnpm fmt failed with exit code %d. Forwarding output to cursor-agent.\n' "$status"
    cursor-agent --model sonnet-4.5 <<EOF
Please fix the biome lint error below.

$output
EOF
  else
    echo "pnpm fmt completed successfully."

    # stop the loop
    exit 0
  fi
  git add .
  git commit -m "fmt mig by cursor-agent"
  git push
  sleep 1
done
