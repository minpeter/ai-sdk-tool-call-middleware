import type {
  JSONObject,
  JSONSchema7,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { toolCallTextHasPrototypeSensitiveKey } from "../../../core/utils/prototype-sensitive-keys";
import {
  coerceToolCallInput,
  coerceToolCallPart,
} from "../../../core/utils/tool-call-coercion";

describe("tool-call coercion combinator and draft-07 regression coverage", () => {
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

  it("drops draft-07 tuple items rejected by additionalItems false", () => {
    const stepsSchema: JSONSchema7 = { type: "array" };
    Object.assign(stepsSchema, {
      items: [
        {
          type: "object",
          properties: {
            action: { type: "string" },
          },
        },
      ],
      additionalItems: false,
    });

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
              steps: stepsSchema,
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

  for (const scenario of [
    {
      name: "selects a single anyOf branch instead of merging mixed branch keys",
      keyword: "anyOf",
    },
    {
      name: "selects a single oneOf branch instead of merging mixed branch keys",
      keyword: "oneOf",
    },
  ] satisfies readonly { name: string; keyword: "anyOf" | "oneOf" }[]) {
    it(scenario.name, () => {
      const branches: JSONSchema7[] = [
        {
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        {
          properties: {
            latitude: { type: "number" },
            longitude: { type: "number" },
          },
          required: ["latitude", "longitude"],
        },
      ];
      const schema: JSONSchema7 = { type: "object" };
      schema[scenario.keyword] = branches;
      const input = coerceToolCallInput(
        "route",
        { city: "Seoul", latitude: 37.5, stray: "drop-me" },
        [{ type: "function", name: "route", inputSchema: schema }]
      );

      expect(input).toBe('{"city":"Seoul"}');
    });
  }

  const discriminatorScenarios: readonly {
    name: string;
    schema: JSONSchema7;
  }[] = [
    {
      name: "selects anyOf branches by const discriminators before dropping mixed keys",
      schema: {
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
      } satisfies JSONSchema7,
    },
    {
      name: "selects oneOf branches by enum discriminators before dropping mixed keys",
      schema: {
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
      } satisfies JSONSchema7,
    },
  ];
  for (const scenario of discriminatorScenarios) {
    it(scenario.name, () => {
      const input = coerceToolCallInput(
        "route",
        { kind: "count", countOnly: 3, textOnly: "drop-me" },
        [{ type: "function", name: "route", inputSchema: scenario.schema }]
      );

      expect(input).toBe('{"kind":"count","countOnly":3}');
    });
  }

  it("fails closed on cyclic provider-native object inputs", () => {
    const input: JSONObject = { city: "Seoul" };
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

  it.each([
    "constructor: ordinary prose",
    "prototype: ordinary prose",
    "constructor: true",
    "prototype: 1",
  ] as const)(
    "keeps schema-valid string args that start with prototype-like label %s",
    (payload) => {
      const input = coerceToolCallInput("echo", { payload }, [
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
      ]);

      expect(input).toBe(JSON.stringify({ payload }));
    }
  );

  it("detects prototype-sensitive text only in tool-argument-like syntax", () => {
    expect(
      toolCallTextHasPrototypeSensitiveKey("notes mention constructor safely")
    ).toBe(false);
    expect(
      toolCallTextHasPrototypeSensitiveKey("constructor: ordinary prose")
    ).toBe(false);
    expect(
      toolCallTextHasPrototypeSensitiveKey("prototype: ordinary prose")
    ).toBe(false);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<unit>constructor: ordinary prose</unit>"
      )
    ).toBe(false);
    expect(
      toolCallTextHasPrototypeSensitiveKey("<unit>constructor: true</unit>")
    ).toBe(false);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<unit>constructor: true\nsecret: [sentinel]</unit>"
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        '<unit>constructor: true\n"secret": [sentinel]</unit>'
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<unit>constructor: true\n1secret: [sentinel]</unit>"
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<unit><![CDATA[constructor: true\nsecret: [sentinel]]]></unit>"
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<unit>prototype:\n  polluted: true</unit>"
      )
    ).toBe(true);
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
        "<parameter name=constructor>{}</parameter>"
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        '<parameter name="&#99;onstructor">{}</parameter>'
      )
    ).toBe(true);
    expect(
      toolCallTextHasPrototypeSensitiveKey(
        "<parameter name=&#99;onstructor>{}</parameter>"
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
