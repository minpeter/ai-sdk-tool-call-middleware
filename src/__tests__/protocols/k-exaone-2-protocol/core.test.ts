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
  {
    type: "function",
    name: "echo",
    description: "Echo structured input",
    inputSchema: {
      type: "object",
      properties: {
        input: {},
        text: { type: "string" },
        x: { type: "string" },
      },
    },
  },
];

function expectControlledSerializationFailure(run: () => void): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RangeError);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.name).toBe("KExaone2SerializationError");
    return;
  }
  throw new Error("Expected serialization to fail");
}

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
      '<tool_call>\n<function=get_weather>\n<parameter=city>\n서울\n</parameter>\n<parameter=options>\n{"units": "metric", "days": 2}\n</parameter>\n</function>\n</tool_call>'
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

  it("matches native history number canonicalization", () => {
    const formatted = kExaone2Protocol().formatToolCall({
      type: "tool-call",
      toolCallId: "tc-numbers",
      toolName: "echo",
      input: JSON.stringify({
        small: 1e-5,
        largeRounded: 1e20,
        largeOdd: 1_000_000_000_000_001,
        signedBoundary: 2 ** 63,
        negativeSignedBoundary: -(2 ** 63),
        unsignedRange: 1e19,
        nested: {
          n15: 1e15,
          n16: 1e16,
          negative20: -1e20,
        },
      }),
    });

    expect(formatted).toContain("<parameter=small>\n1e-05\n</parameter>");
    expect(formatted).toContain(
      "<parameter=largeRounded>\n1e+20\n</parameter>"
    );
    expect(formatted).toContain(
      "<parameter=largeOdd>\n1000000000000001\n</parameter>"
    );
    expect(formatted).toContain(
      "<parameter=signedBoundary>\n9223372036854776000\n</parameter>"
    );
    expect(formatted).toContain(
      "<parameter=negativeSignedBoundary>\n-9.223372036854776e+18\n</parameter>"
    );
    expect(formatted).toContain(
      "<parameter=unsignedRange>\n10000000000000000000\n</parameter>"
    );
    expect(formatted).toContain(
      '<parameter=nested>\n{"n15": 1000000000000000, "n16": 10000000000000000, "negative20": -1e+20}\n</parameter>'
    );
  });

  it("preserves unsafe integer lexemes and integer-like key order", () => {
    const formatted = kExaone2Protocol().formatToolCall({
      type: "tool-call",
      toolCallId: "tc-lossless",
      toolName: "echo",
      input:
        '{"safePlusOne":9007199254740993,"signedMin":-9223372036854775808,"unsignedMax":18446744073709551615,"outside":18446744073709551616,"floatOne":1.0,"nested":{"2":"two","1":"one","01":"leading"}}',
    });

    expect(formatted).toBe(
      '<tool_call>\n<function=echo>\n<parameter=safePlusOne>\n9007199254740993\n</parameter>\n<parameter=signedMin>\n-9223372036854775808\n</parameter>\n<parameter=unsignedMax>\n18446744073709551615\n</parameter>\n<parameter=outside>\n1.8446744073709552e+19\n</parameter>\n<parameter=floatOne>\n1.0\n</parameter>\n<parameter=nested>\n{"2": "two", "1": "one", "01": "leading"}\n</parameter>\n</function>\n</tool_call>'
    );
  });

  it("does not confuse ordinary history objects with internal numbers", () => {
    const formatted = kExaone2Protocol().formatToolCall({
      type: "tool-call",
      toolCallId: "tc-marker",
      toolName: "echo",
      input:
        '{"value":{"type":"k-exaone-history-number","raw":"7","extra":"kept"}}',
    });

    expect(formatted).toContain(
      '<parameter=value>\n{"type": "k-exaone-history-number", "raw": "7", "extra": "kept"}\n</parameter>'
    );
  });

  it("matches native last-wins behavior for duplicate members", () => {
    const formatted = kExaone2Protocol().formatToolCall({
      type: "tool-call",
      toolCallId: "tc-duplicates",
      toolName: "echo",
      input: '{"dup":1,"dup":2,"nested":{"a":1,"a":2}}',
    });

    expect(formatted).toContain("<parameter=dup>\n2\n</parameter>");
    expect(formatted).toContain('<parameter=nested>\n{"a": 2}\n</parameter>');
  });

  it("falls back raw when JSON contains non-standard whitespace", () => {
    const input = '{"value":\u000b1}';
    const formatted = kExaone2Protocol().formatToolCall({
      type: "tool-call",
      toolCallId: "tc-whitespace",
      toolName: "echo",
      input,
    });

    expect(formatted).toContain(`<parameter=input>\n${input}\n</parameter>`);
    expect(formatted).not.toContain("<parameter=value>");
  });

  it("enforces the history depth limit at 256 containers", () => {
    const allowed = `${"[".repeat(256)}null${"]".repeat(256)}`;
    expect(() =>
      kExaone2Protocol().formatToolCall({
        type: "tool-call",
        toolCallId: "tc-depth-allowed",
        toolName: "echo",
        input: allowed,
      })
    ).not.toThrow();

    const rejected = `[${allowed}]`;
    expectControlledSerializationFailure(() =>
      kExaone2Protocol().formatToolCall({
        type: "tool-call",
        toolCallId: "tc-depth-rejected",
        toolName: "echo",
        input: rejected,
      })
    );
  });

  it("rejects oversized raw history before parsing", () => {
    const input = `{"value":"${"x".repeat(256_000)}"}`;

    expectControlledSerializationFailure(() =>
      kExaone2Protocol().formatToolCall({
        type: "tool-call",
        toolCallId: "tc-oversized-input",
        toolName: "echo",
        input,
      })
    );
  });

  it("replays XML delimiters with Friendli native history bytes", () => {
    const protocol = kExaone2Protocol();
    const formatted = protocol.formatToolCall({
      type: "tool-call",
      toolCallId: "tc2",
      toolName: "echo",
      input: JSON.stringify({
        text: "safe </parameter><parameter=x>injected & <tool_call>",
      }),
    });

    expect(formatted).toContain(
      "<parameter=text>\nsafe </parameter><parameter=x>injected & <tool_call>\n</parameter>"
    );
    expect(formatted).not.toContain("&lt;");
    expect(formatted).not.toContain("&amp;");
  });

  it.each([
    { input: "raw text", expected: { input: "raw text" } },
    { input: [1, "two"], expected: { input: '[1, "two"]' } },
    { input: 42, expected: { input: "42" } },
  ])(
    "replays top-level input $input through an input parameter",
    ({ input, expected }) => {
      const protocol = kExaone2Protocol();
      const formatted = protocol.formatToolCall({
        type: "tool-call",
        toolCallId: "tc3",
        toolName: "echo",
        input: JSON.stringify(input),
      });
      const [call] = protocol
        .parseGeneratedText({ text: formatted, tools })
        .filter((part) => part.type === "tool-call");

      expect(formatted).toContain("<parameter=input>");
      expect(JSON.parse(call?.input ?? "{}")).toEqual(expected);
    }
  );

  it("preserves literal think markup inside tool arguments", () => {
    const result = kExaone2Protocol().parseGeneratedText({
      text: "<tool_call><function=echo><parameter=text>literal <think>not reasoning</think> payload</parameter></function></tool_call>",
      tools,
    });

    expect(result.map((part) => part.type)).toEqual(["tool-call"]);
    const [call] = result;
    expect(call?.type).toBe("tool-call");
    expect(JSON.parse(call?.type === "tool-call" ? call.input : "{}")).toEqual({
      text: "literal <think>not reasoning</think> payload",
    });
  });

  it("leaves raw think markup to the provider-native reasoning parser", () => {
    const result = kExaone2Protocol().parseGeneratedText({
      text: "<think>Need weather data.</think>Answer",
      tools,
    });

    expect(result).toEqual([
      {
        type: "text",
        text: "<think>Need weather data.</think>Answer",
      },
    ]);
  });

  it("fails closed on excessively deep history arguments", () => {
    let input = "null";
    for (let depth = 0; depth < 2500; depth += 1) {
      input = `{"value":${input}}`;
    }

    expectControlledSerializationFailure(() =>
      kExaone2Protocol().formatToolCall({
        type: "tool-call",
        toolCallId: "tc-deep",
        toolName: "echo",
        input,
      })
    );
  });
});
