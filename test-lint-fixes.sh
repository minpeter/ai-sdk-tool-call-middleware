#!/bin/bash
cd /data/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware
echo "Running biome check on modified files..."
./node_modules/.bin/biome check --write --max-diagnostics 50 \
  packages/eval/src/benchmarks/json-generation.ts \
  packages/rxml/src/core/tokenizer.ts \
  packages/rxml/tests/fixtures/test-data.ts
