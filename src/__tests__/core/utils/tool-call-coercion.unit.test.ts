import { describe, expect, it } from "vitest";

import {
  coerceToolCallInput,
  coerceToolCallPart,
} from "../../../core/utils/tool-call-coercion";

describe("tool-call coercion utils", () => {
  it("coerces stringified tool input by schema", () => {
    const input = coerceToolCallInput("calc", '{"a":"10","b":"false"}', [
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "boolean" },
          },
        },
      },
    ]);

    expect(input).toBe('{"a":10,"b":false}');
  });

  it("returns undefined when tool input is invalid JSON string", () => {
    const input = coerceToolCallInput("calc", "{", []);
    expect(input).toBeUndefined();
  });

  it("coerceToolCallPart updates tool-call input when coercion succeeds", () => {
    const part = coerceToolCallPart(
      {
        type: "tool-call" as const,
        toolCallId: "id",
        toolName: "calc",
        input: '{"a":"10"}',
      },
      [
        {
          type: "function",
          name: "calc",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" } },
          },
        },
      ]
    );

    expect(part.input).toBe('{"a":10}');
  });

  it("coerceToolCallPart leaves part unchanged when coercion fails", () => {
    const original = {
      type: "tool-call" as const,
      toolCallId: "id",
      toolName: "calc",
      input: "{",
    };
    const part = coerceToolCallPart(original, []);
    expect(part).toEqual(original);
  });
});
