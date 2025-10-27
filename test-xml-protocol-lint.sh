#!/bin/bash
cd /data/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware
echo "Testing biome on xml-protocol.coercion.test.ts..."
npx @biomejs/biome check --max-diagnostics 50 \
  packages/parser/tests/protocols/xml-protocol.coercion.test.ts
