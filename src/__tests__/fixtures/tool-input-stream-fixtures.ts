import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";

const weatherTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get weather information",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      unit: { type: "string" },
    },
    required: ["location"],
  },
};

export const toolInputStreamFixtures = {
  json: {
    tools: [weatherTool],
    progressiveChunks: [
      "Before ",
      '<tool_call>{"na',
      'me":"get_weather","arg',
      'uments":{"location":"Seo',
      'ul","unit":"celsius"}}',
      "</tool_call>",
      " After",
    ],
    finishReconcileChunks: [
      '<tool_call>{"name":"get_weather","arguments":{"location":"Busan","unit":"celsius"}}',
    ],
    malformedChunks: [
      '<tool_call>{"name":"get_weather","arguments":{"location":"Seoul",}</tool_call>',
    ],
  },
  xml: {
    tools: [weatherTool],
    progressiveChunks: [
      "<get_weather>",
      "\n",
      "<location>Seo",
      "ul</location>\n<unit>ce",
      "lsius</unit>\n",
      "</get_weather>",
    ],
    expectedProgressDeltas: ['{"location":"Seoul', '","unit":"celsius', '"}'],
    finishReconcileChunks: [
      "<get_weather>\n<location>Bus",
      "an</location>\n<unit>celsius</unit>\n",
    ],
    expectedFinishInput: '{"location":"Busan","unit":"celsius"}',
    malformedChunks: ["<get_weather><location>Seoul<location></get_weather>"],
  },
  yaml: {
    tools: [weatherTool],
    progressiveChunks: [
      "<get_weather>",
      "\n",
      "location: Seoul\nu",
      "nit: celsius\n",
      "</get_weather>",
    ],
    expectedProgressDeltas: ['{"location":"Seoul","unit":"celsius', '"}'],
    finishReconcileChunks: ["<get_weather>\nlocation: Busan\nunit: celsius\n"],
    expectedFinishInput: '{"location":"Busan","unit":"celsius"}',
    malformedChunks: ["<get_weather>\n- invalid\n- yaml\n</get_weather>"],
  },
};
