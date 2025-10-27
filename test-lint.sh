#!/bin/bash
cd /data/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware
pnpm biome check --max-diagnostics 20 \
  packages/parser/src/generate-handler.ts \
  packages/parser/src/transform-handler.ts \
  packages/rxml/src/builders/stringify.ts \
  packages/rxml/tests/core/stream-analysis.test.ts \
  packages/parser/tests/protocols/xml-protocol.raw-string.stream.test.ts \
  packages/parser/tests/protocols/xml-protocol.stream.test.ts
