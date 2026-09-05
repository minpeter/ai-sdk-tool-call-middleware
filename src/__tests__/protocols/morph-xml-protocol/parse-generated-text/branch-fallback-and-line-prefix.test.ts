import type {
  JSONObject,
  JSONSchema7,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

const basicTools: LanguageModelV4FunctionTool[] = [makeTool("a")];

vi.spyOn(console, "warn").mockImplementation(() => {
  // Intentionally empty - suppressing console warnings in tests
});

function makeTool(
  name: string,
  properties?: Record<string, JSONSchema7>
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    description: "",
    inputSchema:
      properties === undefined
        ? { type: "object" }
        : { type: "object", properties },
  };
}

function parse(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  repair?: boolean
): LanguageModelV4Content[] {
  return runGeneratedJsonRepair({
    protocol:
      repair === undefined
        ? morphXmlProtocol()
        : morphXmlProtocol({ parseOptions: { repair } }),
    text,
    tools,
  });
}

function requireParsedCall(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): Extract<LanguageModelV4Content, { type: "tool-call" }> {
  const toolCall = parse(text, tools).find((part) => part.type === "tool-call");
  expect(toolCall).toBeTruthy();
  if (toolCall?.type !== "tool-call") {
    throw new TypeError("Expected tool-call part");
  }
  return toolCall;
}

function parseInput(
  toolCall: Extract<LanguageModelV4Content, { type: "tool-call" }>
): JSONObject {
  return JSON.parse(toolCall.input);
}

function weatherTool(): LanguageModelV4FunctionTool {
  return makeTool("get_weather", {
    city: { type: "string" },
    unit: { type: "string" },
  });
}

function expectSeoulWeather(
  toolCall: Extract<LanguageModelV4Content, { type: "tool-call" }>
): void {
  const input = parseInput(toolCall);
  expect(input.city).toBe("Seoul");
  expect(input.unit).toBe("celsius");
}

describe("morphXmlProtocol parseGeneratedText branch fallback and line-prefix behavior", () => {
  it("returns original text when tools list is empty", () => {
    const out = parse("free text", []);
    expect(out).toEqual([{ type: "text", text: "free text" }]);
  });

  it("handles malformed inner XML gracefully (either falls back to text or parses)", () => {
    const out = parse("<a><x></y></a>", basicTools);
    const hasText = out.some((part) => part.type === "text");
    const hasTool = out.some((part) => part.type === "tool-call");
    expect(hasText || hasTool).toBe(true);
  });

  it("parses tool calls with whitespace in the closing tag name", () => {
    requireParsedCall("<a><x>ok</x></ a>", basicTools);
  });

  it("parses empty tool call bodies when repair is disabled", () => {
    const out = parse("<a></a>", basicTools, false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "tool-call",
      toolName: "a",
      input: "{}",
    });
  });

  it("treats HTML-void tag names like <input> as normal XML nodes", () => {
    const toolCall = requireParsedCall(
      "<with_input><input>hello</input></with_input>",
      [makeTool("with_input", { input: { type: "string" } })]
    );
    expect(parseInput(toolCall).input).toBe("hello");
  });

  it("parses line-prefixed tool name followed by XML body", () => {
    const toolCall = requireParsedCall(
      "get_weather\n<city>Seoul</city>\n<unit>celsius</unit>",
      [weatherTool()]
    );
    expectSeoulWeather(toolCall);
  });

  it("parses line-prefixed tool name with colon separator", () => {
    const toolCall = requireParsedCall("get_weather:\n<city>Busan</city>", [
      makeTool("get_weather", { city: { type: "string" } }),
    ]);
    expect(parseInput(toolCall)).toEqual({ city: "Busan" });
  });

  it("preserves trailing text after line-prefixed XML fallback payload", () => {
    const text = "get_weather\n<city>Seoul</city>\nThanks";
    const tools = [makeTool("get_weather", { city: { type: "string" } })];
    const out = parse(text, tools);
    const toolCall = out.find((part) => part.type === "tool-call");
    expect(toolCall).toBeTruthy();
    if (toolCall?.type !== "tool-call") {
      throw new TypeError("Expected tool-call part");
    }
    expect(parseInput(toolCall)).toEqual({ city: "Seoul" });
    const trailing = out
      .filter((part) => part.type === "text")
      .map((part) => part.text);
    expect(trailing.join("")).toContain("Thanks");
  });

  it("does not treat line-prefixed tool name without XML body as tool-call", () => {
    const text = "get_weather\nI can help with weather details.";
    expect(parse(text, [makeTool("get_weather")])).toEqual([
      { type: "text", text },
    ]);
  });

  it("repairs malformed self-closing root with body-style payload", () => {
    const toolCall = requireParsedCall(
      "<get_weather\n  <city>Seoul</city>\n  <unit>celsius</unit>\n/>",
      [weatherTool()]
    );
    expectSeoulWeather(toolCall);
  });
});
