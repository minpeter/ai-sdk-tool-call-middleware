const { XMLTokenizer } = require("./dist/index.cjs").RXML;

console.log("=== Detailed Tokenizer Debug ===");

const xml = '<value kind="n"> 10.5 </value>';
console.log("Input XML:", xml);
console.log("Character by character:");
for (let i = 0; i < xml.length; i++) {
  const char = xml[i];
  const code = xml.charCodeAt(i);
  console.log(
    `${i}: '${char}' (${code}) ${code === 62 ? "<-- CLOSE_BRACKET" : ""}`
  );
}

// Let's manually step through what the tokenizer should do
console.log("\n=== Expected parsing steps ===");
console.log("1. Skip < at position 0");
console.log('2. Parse tag name "value" from position 1-5');
console.log('3. Parse attribute "kind" from position 6-9');
console.log("4. Skip = at position 10");
console.log('5. Parse quoted value "n" from position 11-13');
console.log("6. Should encounter > at position 14 and stop attribute parsing");
console.log('7. Should parse text content " 10.5 " from position 15-20');
console.log("8. Should encounter </ at position 21 and stop children parsing");

console.log("\n=== Actual tokenizer result ===");
try {
  const tokenizer = new XMLTokenizer(xml);
  const result = tokenizer.parseNode();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log("Error:", error.message);
}
