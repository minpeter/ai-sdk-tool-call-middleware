#!/bin/bash
cd /data/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware/packages/parser
echo "Running TypeScript compiler check..."
npx tsc --noEmit
echo "TypeScript check completed with exit code: $?"
