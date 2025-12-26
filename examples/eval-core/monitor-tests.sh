#!/bin/bash

echo "====================================="
echo "Test Progress Monitor"
echo "====================================="
echo ""

# Check BFCL
echo "📊 BFCL Status:"
if [ -f bfcl-glm-full.log ]; then
    tail -5 bfcl-glm-full.log | grep -E "(Running|Finished|Score|SUCCESS|FAILURE)" || echo "  Running..."
    lines=$(wc -l < bfcl-glm-full.log)
    echo "  Log lines: $lines"
else
    echo "  Not started yet"
fi

echo ""

# Check ComplexFuncBench
echo "🔥 ComplexFuncBench Status:"
if [ -f complex-func-bench-glm-full.log ]; then
    tail -5 complex-func-bench-glm-full.log | grep -E "(Running|Finished|Score|SUCCESS|FAILURE|cases)" || echo "  Running..."
    lines=$(wc -l < complex-func-bench-glm-full.log)
    echo "  Log lines: $lines"
else
    echo "  Not started yet"
fi

echo ""
echo "====================================="
