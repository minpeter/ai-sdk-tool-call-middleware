import type { JSONValue } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../core/protocols/hermes-protocol";
import type { TCMProtocol } from "../../../core/protocols/protocol-interface";

function parseOnlyToolCall(
  protocol: Pick<TCMProtocol, "parseGeneratedText">,
  text: string
): { readonly input: JSONValue; readonly toolName: string } {
  const toolCall = protocol
    .parseGeneratedText({ text, tools: [] })
    .find((part) => part.type === "tool-call");
  if (toolCall?.type !== "tool-call") {
    throw new TypeError("Expected a tool-call part");
  }
  return { input: JSON.parse(toolCall.input), toolName: toolCall.toolName };
}

const customDelimiterCases = [
  {
    name: "does not treat an unquoted RJSON key matching a custom start delimiter as nested",
    toolCallStart: "name",
    text: 'name{name:"ok",arguments:{}}END',
    expectedInput: {},
    checksSegments: true,
  },
  {
    name: "does not treat a nested RJSON property matching a custom start delimiter as nested",
    toolCallStart: "name:",
    text: 'name:{name:"ok",arguments:{name:{a:1}}}END',
    expectedInput: { name: { a: 1 } },
    checksSegments: true,
  },
  {
    name: "does not treat comma-delimited RJSON properties matching a custom delimiter as nested",
    toolCallStart: "name:",
    text: 'name:{name:"ok",arguments:{x:1,name:{a:1}}}END',
    expectedInput: { x: 1, name: { a: 1 } },
    checksSegments: false,
  },
  {
    name: "does not treat spaced RJSON properties matching a custom delimiter as nested",
    toolCallStart: "name:",
    text: 'name:{name:"ok",arguments:{x:1, name:{a:1}}}END',
    expectedInput: { x: 1, name: { a: 1 } },
    checksSegments: false,
  },
] as const;

describe("hermesProtocol options", () => {
  it.each(["toolCallStart", "toolCallEnd"] as const)(
    "rejects an empty %s delimiter",
    (optionName) => {
      expect(() => hermesProtocol({ [optionName]: "" })).toThrow(
        `hermesProtocol ${optionName} must not be empty`
      );
    }
  );

  it("still accepts non-empty custom delimiters", () => {
    const protocol = hermesProtocol({
      toolCallStart: "[[tool]]",
      toolCallEnd: "[[/tool]]",
    });

    const result = parseOnlyToolCall(
      protocol,
      'before [[tool]]{"name":"ok","arguments":{}}[[/tool]] after'
    );

    expect(result.toolName).toBe("ok");
    expect(result.input).toEqual({});
  });

  for (const testCase of customDelimiterCases) {
    it(testCase.name, () => {
      const protocol = hermesProtocol({
        toolCallStart: testCase.toolCallStart,
        toolCallEnd: "END",
      });

      const result = parseOnlyToolCall(protocol, testCase.text);

      expect(result.toolName).toBe("ok");
      expect(result.input).toEqual(testCase.expectedInput);
      if (testCase.checksSegments) {
        expect(
          protocol.extractToolCallSegments?.({ text: testCase.text, tools: [] })
        ).toEqual([testCase.text]);
      }
    });
  }
});
