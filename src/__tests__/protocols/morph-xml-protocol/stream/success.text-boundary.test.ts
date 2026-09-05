import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

function emptyTool(
  name: string,
  description: string
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    description,
    inputSchema: { type: "object", properties: {} },
  };
}

function runBoundary(
  chunks: readonly string[],
  tools: LanguageModelV4FunctionTool[]
) {
  return runProtocolTextStream({
    chunks,
    id: "morph-text-boundary",
    protocol: morphXmlProtocol(),
    tools,
  });
}

const pairedTools = [
  emptyTool("tool_a", "Tool A"),
  emptyTool("tool_b", "Tool B"),
];

const adjacentCases = [
  {
    name: "handles consecutive tool calls with no text between them",
    text: "<tool_a></tool_a><tool_b></tool_b>",
  },
  {
    name: "handles tool calls separated only by whitespace",
    text: "<tool_a></tool_a>\n  \n<tool_b></tool_b>",
  },
];

describe("morphXmlProtocol streaming text boundary behavior", () => {
  it("properly emits text-start and text-end events around tool calls", async () => {
    const testTool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "test_tool",
      description: "Test tool",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    };
    const out = await runBoundary(
      [
        "Before tool call ",
        "<test_tool><value>test</value></test_tool>",
        " After tool call",
      ],
      [testTool]
    );
    const eventTypes = out.map((event) => event.type);
    const textStarts = out.filter((event) => event.type === "text-start");
    const textEnds = out.filter((event) => event.type === "text-end");
    expect(selectToolCalls(out)).toHaveLength(1);
    expect(textStarts.length).toBeGreaterThan(0);
    expect(textEnds.length).toBeGreaterThan(0);
    const toolCallIndex = eventTypes.indexOf("tool-call");
    const textEndBeforeTool = eventTypes.lastIndexOf("text-end", toolCallIndex);
    expect(textEndBeforeTool).toBeGreaterThanOrEqual(0);
    expect(textEndBeforeTool).toBeLessThan(toolCallIndex);
    const textDeltaAfterTool = eventTypes.indexOf(
      "text-delta",
      toolCallIndex + 1
    );
    if (textDeltaAfterTool !== -1) {
      const textStartAfterTool = eventTypes.indexOf(
        "text-start",
        toolCallIndex + 1
      );
      expect(textStartAfterTool).toBeGreaterThanOrEqual(0);
      expect(textStartAfterTool).toBeLessThan(textDeltaAfterTool);
    }
    expect(textStarts.length).toBeLessThanOrEqual(textEnds.length + 1);
  });

  it("handles text-end correctly when multiple tool calls are present", async () => {
    const out = await runBoundary(
      ["Start ", "<tool_a></tool_a>", " Middle ", "<tool_b></tool_b>", " End"],
      pairedTools
    );
    expect(selectToolCalls(out)).toHaveLength(2);
    expect(
      out.filter((event) => event.type === "text-start").length
    ).toBeGreaterThan(0);
    const fullText = collectTextDeltas(out);
    expect(fullText).toContain("Start");
    expect(fullText).toContain("Middle");
    expect(fullText).toContain("End");
    expect(fullText).not.toContain("<tool_a>");
    expect(fullText).not.toContain("<tool_b>");
  });

  for (const scenario of adjacentCases) {
    it(scenario.name, async () => {
      const out = await runBoundary([scenario.text], pairedTools);
      expect(selectToolCalls(out)).toHaveLength(2);
      const fullText = collectTextDeltas(out);
      expect(fullText).not.toContain("<tool_a>");
      expect(fullText).not.toContain("<tool_b>");
      if (
        scenario.name.includes("whitespace") &&
        fullText.trim().length === 0
      ) {
        expect(fullText.length).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it("handles empty tool call parameters", async () => {
    const out = await runBoundary(
      ["Calling <empty_tool></empty_tool> now"],
      [emptyTool("empty_tool", "Tool with no parameters")]
    );
    const toolCall = requireToolCall(out);
    const fullText = collectTextDeltas(out);
    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe("empty_tool");
    expect(parseToolCallObject(toolCall)).toEqual({});
    expect(fullText).toContain("Calling");
    expect(fullText).toContain("now");
    expect(fullText).not.toContain("<empty_tool>");
  });
});
