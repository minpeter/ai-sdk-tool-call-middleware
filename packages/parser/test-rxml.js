const exports = require("./dist/index.cjs");

console.log("Available exports:", Object.keys(exports));
console.log("RXML available:", !!exports.RXML);

if (exports.RXML) {
  console.log("RXML methods:", Object.keys(exports.RXML));

  try {
    const result = exports.RXML.parseWithoutSchema(
      '<value kind="n"> 10.5 </value>'
    );
    console.log("Parse result:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.log("Parse error:", error.message);
    console.log("Error cause:", error.cause?.message);
  }
} else {
  console.log("RXML not found in exports");
}
