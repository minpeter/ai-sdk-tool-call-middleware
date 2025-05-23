// packages/parser/test/simple-test.js
const assert = require('assert');

function add(a, b) {
  return a + b;
}

assert.strictEqual(add(2, 3), 5, 'Test 1 Failed: 2 + 3 should be 5');
console.log('Simple test passed!');
