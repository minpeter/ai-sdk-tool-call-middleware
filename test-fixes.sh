#!/bin/bash
cd /data/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware
echo "Running biome check..."
npx @biomejs/biome check --write --max-diagnostics 30 2>&1 | tee biome-output.txt
echo ""
echo "Exit code: $?"
