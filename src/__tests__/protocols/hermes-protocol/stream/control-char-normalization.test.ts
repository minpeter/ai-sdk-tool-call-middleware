import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
} from "../../shared/duplicate-harness";

const protocol = hermesProtocol();

async function parseStreamedEdit(text: string) {
  const parts = await runProtocolTextStream({
    chunks: [text],
    id: "1",
    protocol,
    tools: [],
  });
  const toolCall = requireToolCall(parts);
  return { input: parseToolCallObject(toolCall), toolCall };
}

describe("hermesProtocol streaming control character normalization", () => {
  it("parses streaming tool call with raw newline in argument", async () => {
    const { input, toolCall } = await parseStreamedEdit(
      `<tool_call>{"name":"edit","arguments":{"content":"line1
line2"}}</tool_call>`
    );

    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe("edit");
    expect(input.content).toBe("line1\nline2");
  });

  it("parses incomplete tool call with raw newline at finish", async () => {
    const { input, toolCall } = await parseStreamedEdit(
      `<tool_call>{"name":"edit","arguments":{"content":"a
b"}}`
    );

    expect(toolCall).toBeTruthy();
    expect(toolCall.toolName).toBe("edit");
    expect(input.content).toBe("a\nb");
  });
});
