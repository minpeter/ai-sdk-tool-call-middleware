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

  it("drops every key when additionalProperties is false without declared properties", () => {
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

    expect(input).toBe("{}");
  });

  it("preserves keys explicitly allowed by additionalProperties true", () => {
    const input = coerceToolCallInput(
      "shape_shift",
      { mood: "sunny", extra: "kept" },
      [
        {
          type: "function",
          name: "shape_shift",
          inputSchema: {
            type: "object",
            properties: {
              mood: { type: "string" },
            },
            additionalProperties: true,
          },
        },
      ]
    );

    expect(input).toBe('{"mood":"sunny","extra":"kept"}');
  });

  it("coerces keys explicitly allowed by additionalProperties schemas", () => {
    const input = coerceToolCallInput(
      "shape_shift",
      { mood: "sunny", count: "42" },
      [
        {
          type: "function",
          name: "shape_shift",
          inputSchema: {
            type: "object",
            properties: {
              mood: { type: "string" },
            },
            additionalProperties: { type: "number" },
          },
        },
      ]
    );

    expect(input).toBe('{"mood":"sunny","count":42}');
  });

  it("drops non-matching keys from implicit patternProperties-only schemas", () => {
    const input = coerceToolCallInput(
      "metadata",
      { "x-count": "3", other: "drop" },
      [
        {
          type: "function",
          name: "metadata",
          inputSchema: {
            type: "object",
            patternProperties: {
              "^x-": { type: "number" },
            },
          },
        },
      ]
    );

    expect(input).toBe('{"x-count":3}');
  });

  it("coerces additionalProperties schema keys with unsafe false patterns", () => {
    const input = coerceToolCallInput("metadata", { safe: "1", aaaa: "2" }, [
      {
        type: "function",
        name: "metadata",
        inputSchema: {
          type: "object",
          patternProperties: {
            "^(a+)+$": false,
          },
          additionalProperties: { type: "number" },
        },
      },
    ]);

    expect(input).toBe('{"safe":1}');
  });

  it("drops keys denied by safe false patterns before additionalProperties true", () => {
    const input = coerceToolCallInput(
      "metadata",
      { "x-secret": "blocked", note: "ok" },
      [
        {
          type: "function",
          name: "metadata",
          inputSchema: {
            type: "object",
            patternProperties: {
              "^x-": false,
            },
            additionalProperties: true,
          },
        },
      ]
    );

    expect(input).toBe('{"note":"ok"}');
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

  it("applies selected combinator property schemas to direct property schemas", () => {
    const input = coerceToolCallInput(
      "edit",
      {
        mode: "strict",
        payload: {
          keep: "yes",
          drop: "no",
        },
      },
      [
        {
          type: "function",
          name: "edit",
          inputSchema: {
            type: "object",
            properties: {
              mode: { type: "string" },
              payload: {
                type: "object",
                additionalProperties: true,
              },
            },
            oneOf: [
              {
                type: "object",
                properties: {
                  mode: { const: "strict" },
                  payload: {
                    type: "object",
                    properties: {
                      keep: { type: "string" },
                    },
                    additionalProperties: false,
                  },
                },
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"mode":"strict","payload":{"keep":"yes"}}');
  });

  it("drops direct properties forbidden by selected combinator branches", () => {
    const input = coerceToolCallInput("edit", { mode: "safe", admin: true }, [
      {
        type: "function",
        name: "edit",
        inputSchema: {
          type: "object",
          properties: {
            mode: { type: "string" },
            admin: { type: "boolean" },
          },
          oneOf: [
            {
              type: "object",
              properties: {
                mode: { const: "safe" },
                admin: false,
              },
              required: ["mode"],
              additionalProperties: false,
            },
          ],
        },
      },
    ]);

    expect(input).toBe('{"mode":"safe"}');
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

  it("drops unknown keys from draft-07 tuple items object schemas", () => {
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
                items: [
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

  it("does not apply trailing items schemas to prefixItems entries", () => {
    const input = coerceToolCallInput(
      "batch",
      {
        steps: [
          { action: "open", trailing: "not-for-prefix" },
          { trailing: "rest", extra: "drop-me" },
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
                ],
                items: {
                  type: "object",
                  properties: {
                    trailing: { type: "string" },
                  },
                },
              } as unknown as LanguageModelV4FunctionTool["inputSchema"],
            },
          },
        },
      ]
    );

    expect(input).toBe('{"steps":[{"action":"open"},{"trailing":"rest"}]}');
  });

  it("drops draft-07 tuple items rejected by additionalItems false", () => {
    const input = coerceToolCallInput(
      "batch",
      {
        steps: [
          { action: "open", extra: "drop-me" },
          { label: "should-not-remain", secret: true },
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
                items: [
                  {
                    type: "object",
                    properties: {
                      action: { type: "string" },
                    },
                  },
                ],
                additionalItems: false,
              } as unknown as LanguageModelV4FunctionTool["inputSchema"],
            },
          },
        },
      ]
    );

    expect(input).toBe('{"steps":[{"action":"open"}]}');
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

  it("does not re-admit allOf-denied names through sibling required schemas", () => {
    const input = coerceToolCallInput(
      "deny_admin",
      { query: "status:open", admin: true },
      [
        {
          type: "function",
          name: "deny_admin",
          inputSchema: {
            type: "object",
            allOf: [
              {
                properties: {
                  admin: false,
                },
              },
              {
                properties: {
                  query: { type: "string" },
                },
                required: ["query", "admin"],
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"query":"status:open"}');
  });

  it("keeps keys declared by strict allOf branches", () => {
    const input = coerceToolCallInput(
      "keep_strict",
      { foo: "ok", bar: "drop" },
      [
        {
          type: "function",
          name: "keep_strict",
          inputSchema: {
            type: "object",
            allOf: [
              {
                type: "object",
                properties: {
                  foo: { type: "string" },
                },
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  bar: { type: "string" },
                },
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"foo":"ok"}');
  });

  it("does not treat anyOf-denied names as globally denied", () => {
    const input = coerceToolCallInput(
      "allow_variant",
      { query: "status:open", admin: true },
      [
        {
          type: "function",
          name: "allow_variant",
          inputSchema: {
            type: "object",
            anyOf: [
              {
                properties: {
                  admin: false,
                },
              },
              {
                properties: {
                  query: { type: "string" },
                  admin: { type: "boolean" },
                },
                required: ["query", "admin"],
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"query":"status:open","admin":true}');
  });

  it("selects a single anyOf branch instead of merging mixed branch keys", () => {
    const input = coerceToolCallInput(
      "route",
      { city: "Seoul", latitude: 37.5, stray: "drop-me" },
      [
        {
          type: "function",
          name: "route",
          inputSchema: {
            type: "object",
            anyOf: [
              {
                properties: {
                  city: { type: "string" },
                },
                required: ["city"],
              },
              {
                properties: {
                  latitude: { type: "number" },
                  longitude: { type: "number" },
                },
                required: ["latitude", "longitude"],
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"city":"Seoul"}');
  });

  it("selects a single oneOf branch instead of merging mixed branch keys", () => {
    const input = coerceToolCallInput(
      "route",
      { city: "Seoul", latitude: 37.5, stray: "drop-me" },
      [
        {
          type: "function",
          name: "route",
          inputSchema: {
            type: "object",
            oneOf: [
              {
                properties: {
                  city: { type: "string" },
                },
                required: ["city"],
              },
              {
                properties: {
                  latitude: { type: "number" },
                  longitude: { type: "number" },
                },
                required: ["latitude", "longitude"],
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"city":"Seoul"}');
  });

  it("selects anyOf branches by const discriminators before dropping mixed keys", () => {
    const input = coerceToolCallInput(
      "route",
      { kind: "count", countOnly: 3, textOnly: "drop-me" },
      [
        {
          type: "function",
          name: "route",
          inputSchema: {
            type: "object",
            anyOf: [
              {
                properties: {
                  kind: { const: "text" },
                  textOnly: { type: "string" },
                },
                required: ["kind", "textOnly"],
                additionalProperties: false,
              },
              {
                properties: {
                  kind: { const: "count" },
                  countOnly: { type: "number" },
                },
                required: ["kind", "countOnly"],
                additionalProperties: false,
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"kind":"count","countOnly":3}');
  });

  it("selects oneOf branches by enum discriminators before dropping mixed keys", () => {
    const input = coerceToolCallInput(
      "route",
      { kind: "count", countOnly: 3, textOnly: "drop-me" },
      [
        {
          type: "function",
          name: "route",
          inputSchema: {
            type: "object",
            oneOf: [
              {
                properties: {
                  kind: { enum: ["text"] },
                  textOnly: { type: "string" },
                },
                required: ["kind", "textOnly"],
                additionalProperties: false,
              },
              {
                properties: {
                  kind: { enum: ["count"] },
                  countOnly: { type: "number" },
                },
                required: ["kind", "countOnly"],
                additionalProperties: false,
              },
            ],
          },
        },
      ]
    );

    expect(input).toBe('{"kind":"count","countOnly":3}');
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
      toolCallTextHasPrototypeSensitiveKey("<parameter=constructor/>")
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        '<parameter name="constructor">{}</parameter>'
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        '<parameter name="&#99;onstructor">{}</parameter>'
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        '<parameter name="&amp;#99;onstructor">{}</parameter>'
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<Parameter=constructor>{}</Parameter>"
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey('<PARAM name="prototype">{}</PARAM>')
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<unit>&amp;lt;prototype&amp;gt;x&amp;lt;/prototype&amp;gt;</unit>"
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<unit>&amp;amp;amp;amp;lt;prototype&amp;amp;amp;amp;gt;x&amp;amp;amp;amp;lt;/prototype&amp;amp;amp;amp;gt;</unit>"
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
