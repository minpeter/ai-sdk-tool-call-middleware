#!/usr/bin/env bash
set -o pipefail

while true; do
  echo "Running job -- --max-diagnostics 10..."
  if ! output=$(pnpm check:types 2>&1); then
    status=$?
    printf 'job failed with exit code %d. Forwarding output to cursor-agent.\n' "$status"
    cursor-agent --model sonnet-4.5 -p <<EOF
Please fix the biome typecheck, lint error below.

$output
EOF
  else
    echo "job completed successfully."

    # stop the loop
    exit 0
  fi
  git add .
  git commit -m "fmt mig by cursor-agent"
  git push
  sleep 1
done
