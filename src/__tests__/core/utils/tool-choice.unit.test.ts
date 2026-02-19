import { describe, expect, it, vi } from "vitest";

import { parseToolChoicePayload } from "../../../core/utils/tool-choice";

describe("tool-choice utils", () => {
  it("parses and coerces valid toolChoice payload", () => {
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":{"a":"10","b":"false"}}',
      tools: [
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
      ],
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({
      toolName: "calc",
      input: '{"a":10,"b":false}',
    });
  });

  it("returns unknown payload on invalid JSON", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: "not-json",
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "unknown", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns unknown payload when root payload is not an object", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: "[]",
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "unknown", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns empty arguments when arguments is not an object", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":"x"}',
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "calc", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
  });
});
