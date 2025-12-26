#!/usr/bin/env node

const fs = require("node:fs");

/**
 * Classify failure types:
 * - PARSER_ISSUE: Parser failed to extract valid XML
 * - MODEL_WRONG_XML: Model generated wrong/invalid XML
 * - MODEL_WRONG_LOGIC: Model generated valid XML but wrong logic/parameters
 * - MODEL_NO_XML: Model didn't generate XML at all (text response)
 */

// Regex patterns at top level for performance
const TAG_PATTERN = /<\w+>/;
const OPEN_TAG_PATTERN = /<\w+[^>]*>/g;
const CLOSE_TAG_PATTERN = /<\/\w+>/g;

console.log("=".repeat(80));
console.log("FAILURE TYPE CLASSIFICATION: Parser vs Model Issues");
console.log("=".repeat(80));
console.log();

// This will need DEBUG_PARSER_OUTPUT=true logs to analyze properly
// For now, we'll create the analysis framework

const failureCategories = {
  parser_issues: {
    name: "🔧 Parser Issues",
    description: "Valid XML that parser failed to extract correctly",
    examples: [],
    count: 0,
  },
  model_malformed_xml: {
    name: "❌ Model: Malformed XML",
    description: "Model generated invalid/malformed XML",
    examples: [],
    count: 0,
  },
  model_wrong_logic: {
    name: "⚠️  Model: Wrong Logic",
    description: "Valid XML but incorrect parameters or tool selection",
    examples: [],
    count: 0,
  },
  model_no_xml: {
    name: "❌ Model: No XML Generated",
    description: "Model didn't generate XML (text response instead)",
    examples: [],
    count: 0,
  },
  model_incomplete: {
    name: "⚠️  Model: Incomplete Output",
    description: "Model stopped mid-generation (token limit or reasoning loop)",
    examples: [],
    count: 0,
  },
  unknown: {
    name: "❓ Unknown",
    description: "Needs manual investigation",
    examples: [],
    count: 0,
  },
};

function analyzeFailureType(
  _testCase,
  actualOutput,
  _expectedOutput,
  toolCalls
) {
  // If no tool calls were extracted
  if (!toolCalls || toolCalls.length === 0) {
    // Check if model generated any XML-like tags
    if (actualOutput?.includes("<") && actualOutput.includes(">")) {
      // Has XML-like content but parser didn't extract it
      if (actualOutput.match(TAG_PATTERN)) {
        // Check if it's malformed
        const openTags = (actualOutput.match(OPEN_TAG_PATTERN) || []).length;
        const closeTags = (actualOutput.match(CLOSE_TAG_PATTERN) || []).length;

        if (openTags !== closeTags) {
          return "model_malformed_xml";
        }

        // XML looks valid, might be parser issue
        return "parser_issues";
      }
      return "model_malformed_xml";
    }
    // No XML at all
    return "model_no_xml";
  }

  // Tool calls were extracted but wrong
  // This is model logic issue
  return "model_wrong_logic";
}

// For demonstration, show the classification framework
console.log("FAILURE CLASSIFICATION FRAMEWORK:\n");

for (const [_key, category] of Object.entries(failureCategories)) {
  console.log(`${category.name}`);
  console.log(`  ${category.description}`);
  console.log();
}

console.log("=".repeat(80));
console.log();

console.log("📋 ANALYSIS STATUS:\n");
console.log("  To perform detailed failure classification, we need:");
console.log("  1. ✅ Complete test runs (waiting...)");
console.log("  2. ⏳ DEBUG_PARSER_OUTPUT=true logs for failed cases");
console.log("  3. ⏳ Raw model outputs for each failure");
console.log();

console.log("  Once tests complete, we'll:");
console.log("  1. Extract all failed test case IDs");
console.log("  2. Re-run failed cases with DEBUG_PARSER_OUTPUT=true");
console.log("  3. Classify each failure using the framework above");
console.log("  4. Identify if fixes should target parser or model prompts");
console.log();

console.log("=".repeat(80));
console.log();

// Check if we have any logs yet
const bfclLogExists = fs.existsSync("bfcl-glm-full.log");
const cfbLogExists = fs.existsSync("complex-func-bench-glm-full.log");

if (bfclLogExists || cfbLogExists) {
  console.log("📊 PRELIMINARY COUNTS (from available logs):\n");

  // Count FAIL lines as placeholder
  if (bfclLogExists) {
    const bfclContent = fs.readFileSync("bfcl-glm-full.log", "utf-8");
    const failCount = (bfclContent.match(/\[FAIL\]/g) || []).length;
    const passCount = (bfclContent.match(/\[PASS\]/g) || []).length;
    console.log(`  BFCL: ${passCount} passed, ${failCount} failed`);
  }

  if (cfbLogExists) {
    const cfbContent = fs.readFileSync(
      "complex-func-bench-glm-full.log",
      "utf-8"
    );
    const failCount = (cfbContent.match(/\[FAIL\]/g) || []).length;
    const passCount = (cfbContent.match(/\[PASS\]/g) || []).length;
    console.log(`  ComplexFuncBench: ${passCount} passed, ${failCount} failed`);
  }

  console.log();
  console.log("  ⏳ Waiting for tests to complete for full analysis...");
  console.log();
} else {
  console.log("  ⏳ No logs available yet. Tests are starting...");
  console.log();
}

console.log("=".repeat(80));
console.log();

module.exports = { analyzeFailureType, failureCategories };
