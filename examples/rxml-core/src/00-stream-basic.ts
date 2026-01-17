import { parse } from "@ai-sdk-tool/rxml";

const xml = `<tool_call>
  <name>search</name>
  <parameters>
    <query>AI</query>
  </parameters>
</tool_call>`;

const schema = {
  type: "object",
  properties: {
    name: { type: "string" },
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
  },
};

const result = parse(xml, schema);
console.log("Parsed result:", result);
