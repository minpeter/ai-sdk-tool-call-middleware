import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

const protocol = hermesProtocol();

function runHermes(chunks: readonly string[]) {
  return runProtocolTextStream({
    chunks,
    id: "t",
    protocol,
    tools: [],
  });
}

function eventTypes(parts: readonly LanguageModelV4StreamPart[]) {
  return parts.map((part) => part.type);
}

describe("hermesProtocol content isolation and lifecycle", () => {
  it("does not expose JSON content inside tool_call tags in text output", async () => {
    const out = await runHermes([
      "Let me check the weather.\n\n",
      '<tool_call>{"name":"get_weather","arguments":{"city":"New York"}}</tool_call>',
      "\n\nThe weather looks good!",
    ]);
    const tool = requireToolCall(out);
    const fullText = collectTextDeltas(out);

    expect(tool.toolName).toBe("get_weather");
    expect(parseToolCallObject(tool)).toEqual({ city: "New York" });
    expect(fullText).not.toContain("<tool_call>");
    expect(fullText).not.toContain("</tool_call>");
    expect(fullText).not.toContain('"name":"get_weather"');
    expect(fullText).not.toContain('"city":"New York"');
    expect(fullText).toContain("Let me check the weather.");
    expect(fullText).toContain("The weather looks good!");
  });

  it("handles multiple consecutive tool calls without exposing JSON content", async () => {
    const out = await runHermes([
      "First, ",
      '<tool_call>{"name":"get_location","arguments":{}}</tool_call>',
      " then ",
      '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>',
      " done!",
    ]);
    const toolCalls = selectToolCalls(out);
    const fullText = collectTextDeltas(out);

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("get_location");
    expect(toolCalls[1].toolName).toBe("get_weather");
    expect(fullText).not.toContain("<tool_call>");
    expect(fullText).not.toContain("</tool_call>");
    expect(fullText).not.toContain('"name":');
    expect(fullText).not.toContain('"arguments":');
    expect(fullText).not.toContain("get_location");
    expect(fullText).not.toContain("get_weather");
    expect(fullText).not.toContain("Tokyo");
    expect(fullText).toContain("First,");
    expect(fullText).toContain(" then ");
    expect(fullText).toContain(" done!");
  });

  it("properly emits text-start and text-end events around tool calls", async () => {
    const out = await runHermes([
      "Before tool call ",
      '<tool_call>{"name":"test_tool","arguments":{"value":"test"}}</tool_call>',
      " After tool call",
    ]);

    const types = eventTypes(out);
    const textStarts = out.filter((event) => event.type === "text-start");
    const textEnds = out.filter((event) => event.type === "text-end");
    const toolCalls = selectToolCalls(out);

    expect(toolCalls).toHaveLength(1);
    expect(textStarts.length).toBeGreaterThan(0);
    expect(textEnds.length).toBeGreaterThan(0);

    const toolCallIndex = types.indexOf("tool-call");
    const textEndBeforeTool = types.lastIndexOf("text-end", toolCallIndex);
    expect(textEndBeforeTool).toBeGreaterThanOrEqual(0);
    expect(textEndBeforeTool).toBeLessThan(toolCallIndex);

    const textDeltaAfterTool = types.indexOf("text-delta", toolCallIndex + 1);
    if (textDeltaAfterTool !== -1) {
      const textStartAfterTool = types.indexOf("text-start", toolCallIndex + 1);
      expect(textStartAfterTool).toBeGreaterThanOrEqual(0);
      expect(textStartAfterTool).toBeLessThan(textDeltaAfterTool);
    }
  });

  it("handles tool call split across chunks without exposing JSON in text", async () => {
    const out = await runHermes([
      "Computing: ",
      "<tool_call>",
      '{"name":"calc"',
      ',"arguments":{"x":10',
      ',"y":20}}',
      "</tool_call>",
      "\nResult ready!",
    ]);
    const tool = requireToolCall(out);
    const fullText = collectTextDeltas(out);

    expect(tool.toolName).toBe("calc");
    expect(parseToolCallObject(tool)).toEqual({ x: 10, y: 20 });
    expect(fullText).not.toContain("<tool_call>");
    expect(fullText).not.toContain("</tool_call>");
    expect(fullText).not.toContain('"name":"calc"');
    expect(fullText).not.toContain('"arguments"');
    expect(fullText).toContain("Computing:");
    expect(fullText).toContain("Result ready!");
  });
});
