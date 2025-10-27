// Simple syntax check for extraction.ts
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'packages/rxml/src/schema/extraction.ts');
const content = fs.readFileSync(filePath, 'utf8');

// Basic syntax checks
const issues = [];

// Check for single-line if/while without braces
const singleLineIfPattern = /\n\s+(if|while)\s*\([^)]+\)\s+[^{;\n]/g;
const matches = content.match(singleLineIfPattern);
if (matches) {
  issues.push(`Found ${matches.length} potential single-line if/while statements without braces`);
}

// Check for proper function structure
const functionCount = (content.match(/^export function /gm) || []).length;
const helperCount = (content.match(/^function /gm) || []).length;

console.log('Syntax Check Results:');
console.log('=====================');
console.log(`Exported functions: ${functionCount}`);
console.log(`Helper functions: ${helperCount}`);
console.log(`Total lines: ${content.split('\n').length}`);

if (issues.length > 0) {
  console.log('\nIssues found:');
  issues.forEach(issue => console.log(`  - ${issue}`));
  process.exit(1);
} else {
  console.log('\n✓ No obvious syntax issues found');
  console.log('✓ All if/while statements appear to have braces');
  process.exit(0);
}
