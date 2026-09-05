import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "a",
    description: "",
    inputSchema: { type: "object" },
  },
];

describe("morphXmlProtocol streaming with malformed XML", () => {
  it("gracefully recovers malformed XML by parsing available content", async () => {
    const onError = vi.fn();
    const out = await runProtocolTextStream({
      protocol: morphXmlProtocol(),
      tools,
      id: "1",
      chunks: ["<a><x>1</x><unclosed>tag</a>"],
      parserOptions: { onError },
    });
    expect(selectToolCalls(out)).toHaveLength(1);
    const toolCall = requireToolCall(out);
    expect(toolCall).toMatchObject({ type: "tool-call", toolName: "a" });
    const input = parseToolCallObject(toolCall);
    expect(input).toHaveProperty("x", 1);
    expect(input).toHaveProperty("unclosed", "tag");
  });
});
