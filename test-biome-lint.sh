#!/bin/bash
# Test biome lint on modified files
echo "Testing biome lint on modified files..."
npx @biomejs/biome check --max-diagnostics 20 packages/eval/src/benchmarks/bfcl.ts packages/rxml/src/schema/extraction.ts
