import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { kExaone2Protocol } from "../../../core/protocols/k-exaone-2-protocol";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        options: { type: "object" },
      },
    },
  },
];

describe("kExaone2Protocol", () => {
  it("parses native tool calls while preserving surrounding text order", () => {
    const result = kExaone2Protocol().parseGeneratedText({
      text: "before <tool_call>\n<function=get_weather>\n<parameter=city>\nSeoul\n</parameter>\n</function>\n</tool_call> after",
      tools,
    });

    expect(result.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "text",
    ]);
    const [leadingText, call, trailingText] = result;
    expect(leadingText).toEqual({ type: "text", text: "before " });
    expect(trailingText).toEqual({ type: "text", text: " after" });
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool call");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });

  it("formats calls exactly in K-EXAONE-2.0 syntax and round-trips arguments", () => {
    const protocol = kExaone2Protocol();
    const formatted = protocol.formatToolCall({
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "get_weather",
      input: JSON.stringify({
        city: "서울",
        options: { units: "metric", days: 2 },
      }),
    });

    expect(formatted).toBe(
      '<tool_call>\n<function=get_weather>\n<parameter=city>\n서울\n</parameter>\n<parameter=options>\n{"units":"metric","days":2}\n</parameter>\n</function>\n</tool_call>'
    );

    const [call] = protocol
      .parseGeneratedText({ text: formatted, tools })
      .filter((part) => part.type === "tool-call");
    expect(call?.toolName).toBe("get_weather");
    expect(JSON.parse(call?.input ?? "{}")).toEqual({
      city: "서울",
      options: { units: "metric", days: 2 },
    });
  });

  it("converts complete think blocks to reasoning before parsing tool calls", () => {
    const result = kExaone2Protocol().parseGeneratedText({
      text: "<think>Need weather data.</think><tool_call><function=get_weather><parameter=city>Seoul</parameter></function></tool_call>",
      tools,
    });

    expect(result.map((part) => part.type)).toEqual(["reasoning", "tool-call"]);
    expect(result[0]).toEqual({
      type: "reasoning",
      text: "Need weather data.",
    });
  });
});
