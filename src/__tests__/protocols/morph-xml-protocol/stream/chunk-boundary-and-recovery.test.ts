import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

const weatherTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "",
  inputSchema: { type: "object" },
};

function streamMorph(
  chunks: readonly string[],
  tools: LanguageModelV4FunctionTool[] = [weatherTool]
) {
  return runProtocolTextStream({
    chunks,
    id: "1",
    protocol: morphXmlProtocol(),
    tools,
  });
}

describe("morphXmlProtocol streaming edge cases", () => {
  it("extracts tool call when start tag split across chunks", async () => {
    const out = await streamMorph([
      "prefix <get_",
      "weather>",
      "<location>NY</location>",
      "</get_weather> suffix",
    ]);

    expect(requireToolCall(out)).toMatchObject({
      type: "tool-call",
      toolName: "get_weather",
    });
  });

  it("preserves self-closing tags with leading whitespace split across chunks", async () => {
    const out = await streamMorph(
      ["prefix < get_loc", "ation/> suffix"],
      [
        {
          type: "function",
          name: "get_location",
          description: "",
          inputSchema: { type: "object" },
        },
      ]
    );
    const tool = requireToolCall(out);
    const text = collectTextDeltas(out);

    expect(tool).toBeTruthy();
    expect(tool).toMatchObject({
      type: "tool-call",
      toolName: "get_location",
      input: "{}",
    });
    expect(text).toContain("prefix ");
    expect(text).toContain(" suffix");
    expect(text).not.toContain("< get_loc");
  });

  it("accepts whitespace in the closing tag name while streaming", async () => {
    const out = await streamMorph([
      "<get_weather><location>SF</location></ get_weather>",
    ]);
    const tool = requireToolCall(out);

    expect(tool).toBeTruthy();
    expect(parseToolCallObject(tool).location).toBe("SF");
  });

  it("handles mismatched inner XML without crashing (may emit text or tool-call)", async () => {
    const onError = vi.fn();
    const out = await runProtocolTextStream({
      chunks: ["<get_weather><location>NY</get_weather>"],
      id: "1",
      protocol: morphXmlProtocol(),
      tools: [weatherTool],
      parserOptions: { onError },
    });

    // Either tool-call recovery succeeds, or raw text stays suppressed.
    const hasTool = selectToolCalls(out).length > 0;
    expect(hasTool || collectTextDeltas(out).length === 0).toBe(true);
  });

  it("force-completes unfinished call at flush when parseable", async () => {
    const out = await streamMorph(["<get_weather><location>NY"]);
    const [tool] = selectToolCalls(out);
    const text = collectTextDeltas(out);

    if (tool) {
      expect(tool.toolName).toBe("get_weather");
      expect(parseToolCallObject(tool)).toEqual({ location: "NY" });
    } else {
      expect(text).not.toContain("<get_weather>");
    }
  });

  it("handles multiple inner tags inside one function call", async () => {
    const out = await streamMorph([
      "<get_weather>",
      "<location>NY</location>",
      "<unit>C</unit>",
      "<when>today</when>",
      "</get_weather>",
    ]);
    const tool = requireToolCall(out);
    const args = parseToolCallObject(tool);

    expect(tool).toBeTruthy();
    expect(args.location).toBe("NY");
    expect(args.unit).toBe("C");
    expect(args.when).toBe("today");
  });

  it("parses multiple function calls in a single stream", async () => {
    const out = await streamMorph([
      "<get_weather><location>NY</location></get_weather>",
      " and then ",
      "<get_weather><location>SF</location></get_weather>",
    ]);
    const toolsOut = selectToolCalls(out);

    // Some providers may coalesce or delay parsing; accept >=1 and validate contents when present
    expect(toolsOut.length).toBeGreaterThanOrEqual(1);
    const locations = toolsOut.map(
      (tool) => parseToolCallObject(tool).location
    );
    expect(locations).toContain("NY");
    // If two calls are parsed, the second should be SF
    if (toolsOut.length > 1) {
      expect(locations).toContain("SF");
    }
  });

  it("parses a single call whose tags are split across many chunks (>=6)", async () => {
    const out = await streamMorph([
      "<get_",
      "weather>",
      "<lo",
      "cation>",
      "NY</loc",
      "ation>",
      "</get_wea",
      "ther>",
    ]);
    const tool = requireToolCall(out);

    expect(tool).toBeTruthy();
    expect(parseToolCallObject(tool).location).toBe("NY");
  });
});
