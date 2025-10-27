#!/bin/bash
cd /data/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware
echo "Testing biome on modified files..."
npx @biomejs/biome check --max-diagnostics 20 \
  packages/parser/src/index.ts \
  packages/rxml/src/core/types.ts \
  packages/rxml/src/errors/types.ts \
  packages/rxml/src/index.ts
