import type {
  JSONObject,
  JSONSchema7,
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type { ProtocolMetadata } from "../../../../core/protocols/protocol-interface";
import { isStrictJSONObject } from "../../../test-helpers";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

const weatherProperties: Record<string, JSONSchema7> = {
  city: { type: "string" },
  unit: { type: "string" },
};

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: weatherProperties,
    },
  },
];

function parseToolInput(input: string): JSONObject {
  const parsed: JSONValue = JSON.parse(input);
  if (!isStrictJSONObject(parsed)) {
    throw new TypeError("Expected tool-call input to be a JSON object");
  }
  return parsed;
}

function generatedCalls(text: string) {
  return hermesProtocol()
    .parseGeneratedText({ text, tools })
    .filter(
      (part): part is Extract<LanguageModelV4Content, { type: "tool-call" }> =>
        part.type === "tool-call"
    );
}

function runStream(
  text: string,
  onError?: (message: string, metadata?: ProtocolMetadata) => void
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    protocol: hermesProtocol(),
    tools,
    chunks: [text],
    id: "1",
    parserOptions: { onError },
  });
}

function cityValues(inputs: readonly { readonly input: string }[]) {
  return inputs.map((call) => parseToolInput(call.input).city);
}

describe("hermes streaming mismatched-close salvage", () => {
  it("salvages a call closed with a wrong tag (e.g. </think>) at finish", async () => {
    const out = await runStream(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</think>'
    );
    const [toolCall] = selectToolCalls(out);
    expect(toolCall).toBeDefined();
    if (toolCall === undefined) {
      throw new TypeError("Expected tool-call part");
    }
    expect(toolCall.toolName).toBe("get_weather");
    expect(parseToolInput(toolCall.input)).toEqual({ city: "Seoul" });
    expect(collectTextDeltas(out)).toBe("");
  });

  it("salvages a call missing its close tag entirely", async () => {
    const out = await runStream(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}'
    );
    const [toolCall] = selectToolCalls(out);
    expect(toolCall).toBeDefined();
    expect(parseToolInput(toolCall?.input ?? "{}")).toEqual({ city: "Seoul" });
  });

  it("salvages consecutive calls separated by orphan <tool_call> tags", async () => {
    const out = await runStream(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}'
    );
    const calls = selectToolCalls(out);
    expect(calls).toHaveLength(2);
    expect(cityValues(calls)).toEqual(["Seoul", "Tokyo"]);
    expect(collectTextDeltas(out)).toBe("");
  });

  it("does not salvage genuinely truncated JSON", async () => {
    const onError = vi.fn();
    const out = await runStream(
      '<tool_call>{"name":"get_weather","argu',
      onError
    );
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Could not complete streaming JSON tool call"),
      expect.objectContaining({ dropReason: "unfinished-tool-call" })
    );
  });

  it("does not salvage bodies with trailing non-markup prose", async () => {
    const onError = vi.fn();
    const out = await runStream(
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}} and then some prose',
      onError
    );
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(onError).toHaveBeenCalled();
  });
});

describe("hermes parseGeneratedText mismatched-close salvage", () => {
  it("salvages a wrong close tag inside a well-formed tool_call span", () => {
    const out = hermesProtocol().parseGeneratedText({
      text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}</think></tool_call>',
      tools,
    });
    expect(out.find((part) => part.type === "tool-call")).toMatchObject({
      toolName: "get_weather",
    });
    expect(out.some((part) => part.type === "text")).toBe(false);
  });

  it("keeps the text fallback for spans with trailing prose", () => {
    const onError = vi.fn();
    const out = hermesProtocol().parseGeneratedText({
      text: '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}} definitely prose</tool_call>',
      tools,
      options: { onError },
    });
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Could not process JSON tool call"),
      expect.objectContaining({ dropReason: "malformed-tool-call-body" })
    );
  });
});

const doubleEncoded =
  '<tool_call>\n{"name": "get_weather", "arguments": "{\\n  \\"city\\": \\"Seoul\\",\\n  \\"unit\\": \\"celsius\\"\\n}"}\n</tool_call>';
const arrayWrapped =
  '<tool_call>\n[{"name": "get_weather", "arguments": {"city": "Seoul"}},\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}]\n</tool_call>';

describe("hermes double-encoded and array-wrapped salvage", () => {
  it("parses string-typed arguments in parseGeneratedText", () => {
    const [toolCall] = generatedCalls(doubleEncoded);
    if (toolCall === undefined) {
      throw new Error("Expected tool-call part");
    }
    expect(toolCall.toolName).toBe("get_weather");
    expect(parseToolInput(toolCall.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("parses string-typed arguments in streaming", async () => {
    const out = await runStream(doubleEncoded);
    const [toolCall] = selectToolCalls(out);
    expect(toolCall).toBeDefined();
    expect(parseToolInput(toolCall?.input ?? "{}")).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
    expect(collectTextDeltas(out)).toBe("");
  });

  const arrayCases = [
    { name: "salvages an array of calls in parseGeneratedText", stream: false },
    { name: "salvages an array of calls in streaming", stream: true },
  ];
  for (const testCase of arrayCases) {
    it(testCase.name, async () => {
      const calls = testCase.stream
        ? selectToolCalls(await runStream(arrayWrapped))
        : generatedCalls(arrayWrapped);
      expect(calls).toHaveLength(2);
      expect(cityValues(calls)).toEqual(["Seoul", "Tokyo"]);
      if (testCase.stream) {
        expect(collectTextDeltas(await runStream(arrayWrapped))).toBe("");
      } else {
        const out = hermesProtocol().parseGeneratedText({
          text: arrayWrapped,
          tools,
        });
        expect(out.some((part) => part.type === "text")).toBe(false);
      }
    });
  }
});

describe("hermes invalid JSON escape normalization", () => {
  const cases = [
    {
      name: "drops invalid escapes and parses the call (generate)",
      stream: false,
      text: '<tool_call>{"name":"get_weather","arguments":{"city":"a\\$b"}}</tool_call>',
      city: "a$b",
    },
    {
      name: "drops invalid escapes and parses the call (stream)",
      stream: true,
      text: '<tool_call>{"name":"get_weather","arguments":{"city":"a\\$b"}}</tool_call>',
      city: "a$b",
    },
    {
      name: "keeps valid escapes intact",
      stream: false,
      text: '<tool_call>{"name":"get_weather","arguments":{"city":"line1\\nline2 \\"q\\""}}</tool_call>',
      city: 'line1\nline2 "q"',
    },
    {
      name: "drops apostrophe escapes inside double-quoted JSON strings",
      stream: false,
      text: `<tool_call>{"name":"get_weather","arguments":{"city":"it\\'s Seoul"}}</tool_call>`,
      city: "it's Seoul",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const calls = testCase.stream
        ? selectToolCalls(await runStream(testCase.text))
        : generatedCalls(testCase.text);
      const [toolCall] = calls;
      expect(toolCall).toBeDefined();
      expect(parseToolInput(toolCall?.input ?? "{}")).toEqual({
        city: testCase.city,
      });
    });
  }
});
