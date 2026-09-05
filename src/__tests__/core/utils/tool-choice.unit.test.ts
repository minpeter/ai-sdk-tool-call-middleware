import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import {
  parseToolChoicePayload,
  resolveToolChoiceSelection,
} from "../../../core/utils/tool-choice";

interface RedactionCase {
  readonly expected: { readonly input: string; readonly toolName: string };
  readonly hidden: readonly string[];
  readonly name: string;
  readonly text: string;
  readonly withSchema?: boolean;
}

const calcTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "calc",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" } },
  },
};

const redactionCases: readonly RedactionCase[] = [
  {
    name: "redacts metadata when invalid JSON contains prototype-sensitive text",
    text: '{"name":"calc","arguments":{"constructor":{"polluted":true},"a":"10"',
    expected: { toolName: "unknown", input: "{}" },
    hidden: ["constructor", "polluted"],
  },
  {
    name: "redacts metadata when string arguments contain prototype-sensitive input",
    text: '{"name":"calc","arguments":"{\\"constructor\\":{\\"polluted\\":true}}"}',
    expected: { toolName: "calc", input: "{}" },
    hidden: ["constructor", "polluted"],
  },
  {
    name: "redacts metadata when array arguments contain prototype-sensitive input",
    text: '{"name":"calc","arguments":[{"prototype":{"polluted":true}}]}',
    expected: { toolName: "calc", input: "{}" },
    hidden: ["prototype", "polluted"],
  },
  {
    name: "returns empty arguments when arguments contains prototype-sensitive keys",
    text: '{"name":"calc","arguments":{"__proto__":{"polluted":true},"a":"10"}}',
    expected: { toolName: "calc", input: "{}" },
    hidden: [],
    withSchema: true,
  },
  {
    name: "redacts metadata when toolChoice arguments contain prototype-sensitive keys",
    text: '{"name":"calc","arguments":{"constructor":{"polluted":true},"a":"10"}}',
    expected: { toolName: "calc", input: "{}" },
    hidden: ["constructor", "polluted"],
  },
  {
    name: "returns empty arguments when toolChoice arguments contain prototype-sensitive string leaves",
    text: '{"name":"calc","arguments":{"body":"<prototype>x</prototype>","a":"10"}}',
    expected: { toolName: "calc", input: "{}" },
    hidden: ["<prototype>"],
  },
];

function verifyRedactionCase(scenario: RedactionCase): void {
  const onError = vi.fn();
  const parsed = parseToolChoicePayload({
    text: scenario.text,
    tools: scenario.withSchema ? [calcTool] : [],
    onError,
    errorMessage: "parse error",
  });
  expect(parsed).toEqual(scenario.expected);
  expect(onError).toHaveBeenCalledOnce();
  if (scenario.hidden.length > 0) {
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    for (const hidden of scenario.hidden) {
      expect(metadataText).not.toContain(hidden);
    }
  }
}

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

  for (const scenario of redactionCases) {
    it(scenario.name, () => verifyRedactionCase(scenario));
  }

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

  it("returns empty arguments when toolChoice payload envelope contains prototype-sensitive keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"] as const) {
      const onError = vi.fn();
      const parsed = parseToolChoicePayload({
        text: `{"name":"calc","${key}":{"polluted":true},"arguments":{"a":"10"}}`,
        tools: [
          {
            type: "function",
            name: "calc",
            inputSchema: {
              type: "object",
              properties: {
                a: { type: "number" },
              },
            },
          },
        ],
        onError,
        errorMessage: "parse error",
      });

      expect(parsed).toEqual({ toolName: "calc", input: "{}" });
      expect(onError).toHaveBeenCalledOnce();
      const metadataText = JSON.stringify(onError.mock.calls);
      expect(metadataText).toContain("[redacted sensitive tool call]");
      expect(metadataText).not.toContain(key);
      expect(metadataText).not.toContain("polluted");
    }
  });

  it("redacts resolved originText for prototype-sensitive forced toolChoice payloads", () => {
    const resolved = resolveToolChoiceSelection({
      text: '{"name":"calc","arguments":{"constructor":{"polluted":true},"a":"10"}}',
      tools: [],
      errorMessage: "parse error",
    });

    expect(resolved).toEqual({
      toolName: "calc",
      input: "{}",
      originText: "[redacted sensitive tool call]",
    });
  });

  it("enforces the selected tool name", () => {
    const resolved = resolveToolChoiceSelection({
      text: '{"name":"other","arguments":{"value":1}}',
      tools: [
        {
          type: "function",
          name: "safe",
          inputSchema: {
            type: "object",
            properties: { value: { type: "number" } },
          },
        },
      ],
      expectedToolName: "safe",
      errorMessage: "parse error",
    });

    expect(resolved).toMatchObject({
      toolName: "safe",
      input: '{"value":1}',
    });
  });

  it("coerces mismatched tool arguments with the selected tool schema", () => {
    const resolved = resolveToolChoiceSelection({
      text: '{"name":"other","arguments":{"selectedValue":"kept","otherValue":"drop"}}',
      tools: [
        {
          type: "function",
          name: "safe",
          inputSchema: {
            type: "object",
            properties: { selectedValue: { type: "string" } },
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "other",
          inputSchema: {
            type: "object",
            properties: { otherValue: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      expectedToolName: "safe",
      errorMessage: "parse error",
    });

    expect(resolved).toEqual({
      toolName: "safe",
      input: '{"selectedValue":"kept"}',
      originText:
        '{"name":"other","arguments":{"selectedValue":"kept","otherValue":"drop"}}',
    });
  });

  it.each([
    ['{"name":"other","arguments":"bad"}', "{}"],
    ['{"name":"other","arguments":{"__proto__":{"polluted":true}}}', "{}"],
  ])("rejects malformed mismatched arguments: %s", (text, input) => {
    expect(
      resolveToolChoiceSelection({
        text,
        tools: [
          {
            type: "function",
            name: "safe",
            inputSchema: { type: "object" },
          },
          {
            type: "function",
            name: "other",
            inputSchema: { type: "object" },
          },
        ],
        expectedToolName: "safe",
        errorMessage: "parse error",
      })
    ).toMatchObject({ toolName: "safe", input });
  });

  it.each(["", "not JSON"])(
    "preserves the forced tool name for invalid output: %j",
    (text) => {
      expect(
        resolveToolChoiceSelection({
          text,
          tools: [
            {
              type: "function",
              name: "safe",
              inputSchema: { type: "object" },
            },
          ],
          expectedToolName: "safe",
          errorMessage: "parse error",
        })
      ).toMatchObject({ toolName: "safe", input: "{}" });
    }
  );
});
