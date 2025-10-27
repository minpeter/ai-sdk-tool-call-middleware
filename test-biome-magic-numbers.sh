#!/bin/bash
# Test script to verify biome doesn't complain about magic numbers in test files

echo "Testing biome configuration for magic numbers in test files..."
echo ""

# Run biome check on the specific test file that was failing
./node_modules/.bin/biome check packages/rxml/tests/coercion.heuristic-handling.legacy.test.ts --max-diagnostics 5

exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo ""
    echo "✅ Success! No magic number errors in test files."
else
    echo ""
    echo "❌ Still have errors. Exit code: $exit_code"
fi

exit $exit_code
