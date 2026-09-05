import type { JSONSchema7 } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { toolCallTextHasPrototypeSensitiveKey } from "../../../core/utils/prototype-sensitive-keys";
import { coerceToolCallInput } from "../../../core/utils/tool-call-coercion";

function coerceUnsafePattern(
  additionalProperties: JSONSchema7["additionalProperties"]
): string | undefined {
  return coerceToolCallInput("metadata", { safe: "1", aaaa: "2" }, [
    {
      type: "function",
      name: "metadata",
      inputSchema: {
        type: "object",
        patternProperties: { "^(a+)+$": false },
        additionalProperties,
      },
    },
  ]);
}

function tupleStepsSchema(keyword: "items" | "prefixItems"): JSONSchema7 {
  const schema: JSONSchema7 = { type: "array" };
  Object.assign(schema, {
    [keyword]: [
      {
        type: "object",
        properties: { action: { type: "string" } },
      },
      {
        type: "object",
        properties: { label: { type: "string" } },
      },
    ],
  });
  return schema;
}

describe("tool-call coercion regression coverage", () => {
  it.each(["__proto__foo", "constructorName", "prototypeValue"])(
    "preserves a safe key that only begins with a sensitive label: %s",
    (key) => {
      expect(
        toolCallTextHasPrototypeSensitiveKey(
          JSON.stringify({
            name: "safe_key",
            arguments: { [key]: "kept" },
          })
        )
      ).toBe(false);
    }
  );

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
    expect(coerceUnsafePattern({ type: "number" })).toBe('{"safe":1}');
  });

  it("preserves strict key normalization before dropping schema-unknown keys", () => {
    const input = coerceToolCallInput(
      "translate",
      {
        text: "ship it",
        target_language: "ko",
        formality: "casual",
        extra: "drop",
      },
      [
        {
          type: "function",
          name: "translate",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              targetLanguage: { type: "string" },
              formality: { type: "string" },
            },
            required: ["text", "targetLanguage"],
            additionalProperties: false,
          },
        },
      ]
    );

    expect(JSON.parse(input ?? "null")).toEqual({
      text: "ship it",
      targetLanguage: "ko",
      formality: "casual",
    });
  });

  it("does not let a similar unknown key override an already-present declared key", () => {
    const input = coerceToolCallInput(
      "translate",
      {
        text: "ship it",
        targetLanguage: "ko",
        target_language: "ja",
      },
      [
        {
          type: "function",
          name: "translate",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              targetLanguage: { type: "string" },
            },
            required: ["text", "targetLanguage"],
            additionalProperties: false,
          },
        },
      ]
    );

    expect(input).toBe('{"text":"ship it","targetLanguage":"ko"}');
  });

  it("does not normalize optional-only similar keys into optional declared keys", () => {
    const input = coerceToolCallInput(
      "get_weather",
      {
        city: "Seoul",
        temperature_unit: "celsius",
      },
      [
        {
          type: "function",
          name: "get_weather",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string" },
              temperatureUnit: { type: "string" },
            },
            required: ["city"],
            additionalProperties: false,
          },
        },
      ]
    );

    expect(input).toBe('{"city":"Seoul"}');
  });

  it("preserves additionalProperties true keys with unsafe false patterns", () => {
    expect(coerceUnsafePattern(true)).toBe('{"safe":"1"}');
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

  for (const scenario of [
    {
      name: "drops unknown keys from tuple prefixItems object schemas",
      keyword: "prefixItems",
    },
    {
      name: "drops unknown keys from draft-07 tuple items object schemas",
      keyword: "items",
    },
  ] satisfies readonly { name: string; keyword: "items" | "prefixItems" }[]) {
    it(scenario.name, () => {
      const stepsSchema = tupleStepsSchema(scenario.keyword);
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
              properties: { steps: stepsSchema },
            },
          },
        ]
      );

      expect(input).toBe('{"steps":[{"action":"open"},{"label":"review"}]}');
    });
  }

  it("does not apply trailing items schemas to prefixItems entries", () => {
    const stepsSchema: JSONSchema7 = {
      type: "array",
      items: {
        type: "object",
        properties: {
          trailing: { type: "string" },
        },
      },
    };
    Object.assign(stepsSchema, {
      prefixItems: [
        {
          type: "object",
          properties: {
            action: { type: "string" },
          },
        },
      ],
    });

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
              steps: stepsSchema,
            },
          },
        },
      ]
    );

    expect(input).toBe('{"steps":[{"action":"open"},{"trailing":"rest"}]}');
  });
});
