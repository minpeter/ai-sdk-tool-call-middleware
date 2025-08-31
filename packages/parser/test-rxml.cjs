const pkg = require("./dist/index.cjs");

console.log("Available exports:", Object.keys(pkg));
console.log("RXML available:", !!pkg.RXML);

if (pkg.RXML) {
  console.log("RXML methods:", Object.keys(pkg.RXML));

  try {
    console.log("\n=== Testing parseWithoutSchema ===");
    const result1 = pkg.RXML.parseWithoutSchema(
      '<value kind="n"> 10.5 </value>'
    );
    console.log("Parse result:", JSON.stringify(result1, null, 2));

    console.log("\n=== Testing wrapped XML ===");
    const result2 = pkg.RXML.parseWithoutSchema(
      '<root><value kind="n"> 10.5 </value></root>'
    );
    console.log("Wrapped result:", JSON.stringify(result2, null, 2));

    console.log("\n=== Testing schema parse ===");
    const schema = {
      type: "object",
      properties: { value: { type: "number" } },
      additionalProperties: false,
    };
    const result3 = pkg.RXML.parse('<value kind="n"> 10.5 </value>', schema);
    console.log("Schema parse result:", JSON.stringify(result3, null, 2));

    console.log("\n=== Testing mixed content ===");
    const xml = '<obj><name attr="x"> John Doe </name></obj>';
    const schema2 = {
      type: "object",
      properties: {
        obj: {
          type: "object",
          properties: { name: { type: "string" } },
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    };

    console.log("Input XML:", xml);
    const parseResult = pkg.RXML.parseWithoutSchema(xml);
    console.log("DOM parse result:", JSON.stringify(parseResult, null, 2));

    const domObject = pkg.RXML.domToObject(parseResult, schema2, "#text");
    console.log("DOM to object result:", JSON.stringify(domObject, null, 2));

    // Let's also test domToObject directly on the name node
    const nameNode = parseResult[0].children[0]; // The name element
    console.log("Name node:", JSON.stringify(nameNode, null, 2));
    const nameResult = pkg.RXML.domToObject([nameNode], {}, "#text");
    console.log(
      "Name node domToObject result:",
      JSON.stringify(nameResult, null, 2)
    );

    const finalResult = pkg.RXML.parse(xml, schema2);
    console.log(
      "Final schema parse result:",
      JSON.stringify(finalResult, null, 2)
    );
  } catch (error) {
    console.log("Parse error:", error.message);
    console.log("Error cause:", error.cause?.message);
    console.log("Stack:", error.stack);
  }
} else {
  console.log("RXML not found in exports");
}
