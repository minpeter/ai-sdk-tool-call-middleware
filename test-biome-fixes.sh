#!/bin/bash
cd /data/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware
./node_modules/.bin/biome check --max-diagnostics 20 \
  packages/parser/src/protocols/morph-xml-protocol.ts \
  packages/rxml/src/schema/base-coercion.ts \
  packages/rxml/src/builders/stringify.ts
