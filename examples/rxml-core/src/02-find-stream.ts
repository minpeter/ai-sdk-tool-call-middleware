import { parse } from "@ai-sdk-tool/parser/rxml";

const xml = `<tool_call>
  <name>summarize</name>
  <parameters>
    <text>long text</text>
  </parameters>
</tool_call>`;

const schema = {
  type: "object",
  properties: {
    name: { type: "string" },
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
    },
  },
};

const result = parse(xml, schema);
console.log("Tool name:", result.name);
console.log("Text:", (result.parameters as { text: string }).text);
