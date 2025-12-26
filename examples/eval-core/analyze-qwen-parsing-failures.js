#!/usr/bin/env node

const fs = require("node:fs");

const logFile = "qwen-glm-full-debug.log";
const content = fs.readFileSync(logFile, "utf-8");

// Extract all test case debug sections
const sections = content.split("========== BFCL CASE DEBUG ==========");

const qwenParsingFailures = [];

for (let i = 1; i < sections.length; i++) {
  const section = sections[i];

  // Extract test case ID
  const testCaseMatch = section.match(/Test Case: (\w+_\d+)/);
  if (!testCaseMatch) {
    continue;
  }
  const testCase = testCaseMatch[1];

  // Check if this is Qwen (no <think> tag)
  const hasThinkTag = section.includes("<think>");
  if (hasThinkTag) {
    continue; // Skip GLM
  }

  // Extract parsed tool calls count
  const parsedCountMatch = section.match(
    /--- PARSED TOOL CALLS \(count: (\d+)\)/
  );
  if (!parsedCountMatch) {
    continue;
  }
  const parsedCount = Number.parseInt(parsedCountMatch[1], 10);

  // Only look at complete parsing failures
  if (parsedCount !== 0) {
    continue;
  }

  // Extract expected output
  const expectedMatch = section.match(
    /--- EXPECTED OUTPUT \(morphXML format\) ---\n([\s\S]*?)\n\n--- ACTUAL MODEL OUTPUT/
  );
  const expectedOutput = expectedMatch ? expectedMatch[1].trim() : "";

  // Extract actual output
  const actualMatch = section.match(
    /--- ACTUAL MODEL OUTPUT \(raw, with whitespace\) ---\n([\s\S]*?)\n\n--- PARSED TOOL CALLS/
  );
  const actualOutput = actualMatch ? actualMatch[1].trim() : "";

  qwenParsingFailures.push({
    testCase,
    expectedOutput,
    actualOutput,
  });
}

console.log("=".repeat(80));
console.log(
  `QWEN3-30B-A3B PARSING FAILURE ANALYSIS (${qwenParsingFailures.length} cases)`
);
console.log("=".repeat(80));
console.log();

// Analyze patterns
const patterns = {
  noXmlAtAll: [],
  hasTextOnly: [],
  incompleteXml: [],
  wrongFormat: [],
};

for (const failure of qwenParsingFailures) {
  const output = failure.actualOutput;

  // Check if output contains any XML-like tags
  const hasAnyXmlTag = /<\w+/.test(output);

  if (hasAnyXmlTag) {
    // Check if XML is incomplete or malformed
    const expectedToolName = failure.expectedOutput.match(/<(\w+)>/)?.[1];
    if (expectedToolName) {
      const hasExpectedTag = output.includes(`<${expectedToolName}`);
      if (hasExpectedTag) {
        patterns.incompleteXml.push(failure);
      } else {
        patterns.wrongFormat.push(failure);
      }
    }
  } else {
    patterns.noXmlAtAll.push(failure);
  }
}

console.log("PATTERN BREAKDOWN:\n");
console.log(
  `1. No XML tags at all (pure text response): ${patterns.noXmlAtAll.length}`
);
console.log(`2. Incomplete/malformed XML: ${patterns.incompleteXml.length}`);
console.log(
  `3. Wrong XML format (different tool name): ${patterns.wrongFormat.length}`
);
console.log();

// Show examples of each pattern
console.log("=".repeat(80));
console.log("PATTERN 1: NO XML TAGS (Pure Text Response)");
console.log("=".repeat(80));
console.log();

for (let i = 0; i < Math.min(5, patterns.noXmlAtAll.length); i++) {
  const failure = patterns.noXmlAtAll[i];
  console.log(`[${failure.testCase}]`);
  console.log(
    `Expected:\n${failure.expectedOutput
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n")}`
  );
  console.log(
    `\nActual Output (first 500 chars):\n${failure.actualOutput
      .slice(0, 500)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n")}`
  );
  console.log(`\n${"-".repeat(80)}\n`);
}

// Analyze why Qwen is not generating XML
console.log(`\n${"=".repeat(80)}`);
console.log("WHY IS QWEN NOT GENERATING XML?");
console.log("=".repeat(80));
console.log();

// Check if the model is reasoning but not calling tools
let reasoningWithoutToolCall = 0;
let directAnswer = 0;
let confusedAboutToolUse = 0;

for (const failure of patterns.noXmlAtAll) {
  const output = failure.actualOutput.toLowerCase();

  if (
    output.includes("let me think") ||
    output.includes("okay") ||
    output.includes("first") ||
    output.includes("so the")
  ) {
    reasoningWithoutToolCall++;
  }

  if (
    output.includes("the answer is") ||
    output.includes("therefore") ||
    output.includes("so,")
  ) {
    directAnswer++;
  }

  if (
    output.includes("tool") ||
    output.includes("function") ||
    output.includes("parameter")
  ) {
    confusedAboutToolUse++;
  }
}

console.log("Behavior Patterns:");
console.log(
  `  - Reasoning but not calling tool: ${reasoningWithoutToolCall}/${patterns.noXmlAtAll.length}`
);
console.log(
  `  - Attempting direct answer: ${directAnswer}/${patterns.noXmlAtAll.length}`
);
console.log(
  `  - Confused about tool usage: ${confusedAboutToolUse}/${patterns.noXmlAtAll.length}`
);
console.log();

// Check if there are specific tool names that fail more
console.log(`\n${"=".repeat(80)}`);
console.log("TOOL NAMES WITH HIGH FAILURE RATE");
console.log("=".repeat(80));
console.log();

const toolFailures = {};
for (const failure of qwenParsingFailures) {
  const toolName = failure.expectedOutput.match(/<(\w+)>/)?.[1];
  if (toolName) {
    toolFailures[toolName] = (toolFailures[toolName] || 0) + 1;
  }
}

const sortedToolFailures = Object.entries(toolFailures)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15);

for (const [tool, count] of sortedToolFailures) {
  console.log(`  ${tool}: ${count} failures`);
}

console.log();
