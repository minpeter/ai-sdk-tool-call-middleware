import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { TCMCoreProtocol } from "../../../../core/protocols/protocol-interface";

const formatterCases: readonly (readonly [string, string, TCMCoreProtocol])[] =
  [
    [
      "hermesProtocol formatToolCall and formatTools",
      "<tool_call>",
      hermesProtocol(),
    ],
    [
      "morphXmlProtocol formatToolCall and formatTools",
      "<a",
      morphXmlProtocol(),
    ],
  ];

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "a",
    description: "desc",
    inputSchema: { type: "object" },
  },
];

const toolCall: LanguageModelV4ToolCall = {
  type: "tool-call",
  toolCallId: "id",
  toolName: "a",
  input: "{}",
};

describe("protocol formatters", () => {
  it.each(formatterCases)("%s", (_name, callMarker, protocol) => {
    const sys = protocol.formatTools({
      tools,
      toolSystemPromptTemplate: (formattedTools) => `tools:${formattedTools}`,
    });
    expect(sys).toContain("tools:");

    const call = protocol.formatToolCall(toolCall);
    expect(call).toContain(callMarker);
  });
});
