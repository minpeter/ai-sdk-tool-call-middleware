const { XMLTokenizer } = require("./dist/index.cjs").RXML;

console.log("=== Debugging XMLTokenizer ===");

try {
  const xml = '<value kind="n"> 10.5 </value>';
  console.log("Input XML:", xml);

  const tokenizer = new XMLTokenizer(xml);
  const result = tokenizer.parseNode();

  console.log("Parsed result:", JSON.stringify(result, null, 2));
  console.log("Final position:", tokenizer.getPosition());
  console.log("XML length:", xml.length);
} catch (error) {
  console.log("Error:", error.message);
  console.log("Stack:", error.stack);
}
