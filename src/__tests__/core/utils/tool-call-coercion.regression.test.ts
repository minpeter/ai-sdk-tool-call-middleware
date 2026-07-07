import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { toolCallTextHasPrototypeSensitiveKey } from "../../../core/utils/prototype-sensitive-keys";
import {
  coerceToolCallInput,
  coerceToolCallPart,
} from "../../../core/utils/tool-call-coercion";

describe("tool-call coercion regression coverage", () => {
  const weatherTools: LanguageModelV4FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
      },
    },
  ];

  it("drops every key when an object schema declares empty properties", () => {
    const input = coerceToolCallInput("ping", { mood: "sunny" }, [
      {
        type: "function",
        name: "ping",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ]);

    expect(input).toBe("{}");
  });

  it("keeps keys when an object schema has no declared properties policy", () => {
    const input = coerceToolCallInput("shape_shift", { mood: "sunny" }, [
      {
        type: "function",
        name: "shape_shift",
        inputSchema: {
          type: "object",
        },
      },
    ]);

    expect(input).toBe('{"mood":"sunny"}');
  });

  it("keeps keys when additionalProperties is false without declared properties", () => {
    const input = coerceToolCallInput("shape_shift", { mood: "sunny" }, [
      {
        type: "function",
        name: "shape_shift",
        inputSchema: {
          type: "object",
          additionalProperties: false,
        },
      },
    ]);

    expect(input).toBe('{"mood":"sunny"}');
  });

  it("drops nested object keys that are not declared in nested properties schemas", () => {
    const input = coerceToolCallInput(
      "plan_trip",
      {
        location: "Seoul",
        options: {
          unit: "celsius",
          mood: "sunny",
        },
        extra: "drop-me",
      },
      [
        {
          type: "function",
          name: "plan_trip",
          inputSchema: {
            type: "object",
            properties: {
              location: { type: "string" },
              options: {
                type: "object",
                properties: {
                  unit: { type: "string" },
                },
              },
            },
          },
        },
      ]
    );

    expect(input).toBe('{"location":"Seoul","options":{"unit":"celsius"}}');
  });

  it("drops nested object keys declared through combinator property schemas", () => {
    const input = coerceToolCallInput(
      "plan_trip",
      {
        options: {
          unit: "celsius",
          mood: "sunny",
        },
        extra: "drop-me",
      },
      [
        {
          type: "function",
          name: "plan_trip",
          inputSchema: {
            type: "object",
            allOf: [
              {
                properties: {
                  options: {
                    type: "object",
                    properties: {
                      unit: { type: "string" },
                    },
                  },
                },
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"options":{"unit":"celsius"}}');
  });

  it("drops unknown keys from array items declared through combinator schemas", () => {
    const input = coerceToolCallInput(
      "filter_issues",
      {
        filters: [
          { field: "status", value: "open", admin: true },
          { field: "priority", value: "high", extra: "drop-me" },
        ],
      },
      [
        {
          type: "function",
          name: "filter_issues",
          inputSchema: {
            type: "object",
            properties: {
              filters: {
                type: "array",
                allOf: [
                  {
                    items: {
                      type: "object",
                      properties: {
                        field: { type: "string" },
                        value: { type: "string" },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      ]
    );

    expect(input).toBe(
      '{"filters":[{"field":"status","value":"open"},{"field":"priority","value":"high"}]}'
    );
  });

  it("drops unknown keys from tuple prefixItems object schemas", () => {
    const input = coerceToolCallInput(
      "batch",
      {
        steps: [
          { action: "open", extra: "drop-me" },
          { label: "review", secret: true },
        ],
      },
      [
        {
          type: "function",
          name: "batch",
          inputSchema: {
            type: "object",
            properties: {
              steps: {
                type: "array",
                prefixItems: [
                  {
                    type: "object",
                    properties: {
                      action: { type: "string" },
                    },
                  },
                  {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                    },
                  },
                ],
              } as unknown as LanguageModelV4FunctionTool["inputSchema"],
            },
          },
        },
      ]
    );

    expect(input).toBe('{"steps":[{"action":"open"},{"label":"review"}]}');
  });

  it("does not keep required names whose property schema is false", () => {
    const input = coerceToolCallInput(
      "deny_admin",
      { query: "status:open", admin: true },
      [
        {
          type: "function",
          name: "deny_admin",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              admin: false,
            },
            required: ["query", "admin"],
          },
        },
      ]
    );

    expect(input).toBe('{"query":"status:open"}');
  });

  it("fails closed on cyclic provider-native object inputs", () => {
    const input: Record<string, unknown> = { city: "Seoul" };
    input.self = input;
    const permissiveTools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "shape_shift",
        inputSchema: { type: "object" },
      },
    ];

    expect(coerceToolCallInput("shape_shift", input, permissiveTools)).toBe(
      undefined
    );
  });

  it("coerceToolCallPart detects unicode-escaped prototype keys in relaxed JSON provider inputs", () => {
    const part = coerceToolCallPart(
      {
        type: "tool-call" as const,
        toolCallId: "id",
        toolName: "get_weather",
        input:
          "{'\\u005f\\u005fproto\\u005f\\u005f':{'polluted':true},'city':'Seoul'}",
      },
      weatherTools
    );

    expect(part.input).toBe("{}");
  });

  it("rejects prototype-sensitive XML child tags preserved inside string args", () => {
    const input = coerceToolCallInput(
      "echo",
      { payload: "<prototype>x</prototype>" },
      [
        {
          type: "function",
          name: "echo",
          inputSchema: {
            type: "object",
            properties: {
              payload: { type: "string" },
            },
          },
        },
      ]
    );

    expect(input).toBeUndefined();
  });

  it("rejects prototype-sensitive XML child strings before schema sanitization can drop them", () => {
    const input = coerceToolCallInput(
      "get_weather",
      { city: "Seoul", extra: "<prototype>x</prototype>" },
      weatherTools
    );

    expect(input).toBeUndefined();
  });

  it("keeps harmless string args that merely mention prototype-like labels", () => {
    const input = coerceToolCallInput(
      "echo",
      { payload: `{"name":"notes mention 'constructor': labels"}` },
      [
        {
          type: "function",
          name: "echo",
          inputSchema: {
            type: "object",
            properties: {
              payload: { type: "string" },
            },
          },
        },
      ]
    );

    expect(input).toBe(
      `{"payload":"{\\"name\\":\\"notes mention 'constructor': labels\\"}"}`
    );
  });

  it("detects prototype-sensitive text only in tool-argument-like syntax", () => {
    expect(
      toolCallTextHasPrototypeSensitiveKey("notes mention constructor safely")
    ).toBe(false);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "{'\\u005f\\u005fproto\\u005f\\u005f':{'polluted':true}}"
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        '{"arguments":"{\\"__proto__\\":{\\"polluted\\":true}}"}'
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        '{"arguments":"{\\"\\\\u0063onstructor\\":{\\"polluted\\":true}}"}'
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<parameter=constructor>{}</parameter>"
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        '<parameter name="constructor">{}</parameter>'
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<parameter>constructor</parameter>{}"
      )
    ).toBe(true);
    expect(toolCallTextHasPrototypeSensitiveKey("<arg>__proto__</arg>{}")).toBe(
      true
    );
    expect(
      toolCallTextHasPrototypeSensitiveKey('<param name="prototype">{}</param>')
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey("<arg=__proto__>{}</arg>")
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<__proto__><polluted>true</polluted></__proto__>"
      )
    ).toBe(true);
    expect(toolCallTextHasPrototypeSensitiveKey("<prototype")).toBe(true);
  });
});
