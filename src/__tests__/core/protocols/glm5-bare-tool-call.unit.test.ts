import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { parseGlm5AnchoredBareToolCall } from "../../../core/protocols/glm5-bare-tool-call";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "corporate_innovation_culture",
    description: "Assess corporate innovation culture",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        industry: { type: "string" },
        total_employees: { type: "integer" },
      },
      required: ["industry", "total_employees"],
    },
  },
  {
    type: "function",
    name: "inspect_payload",
    description: "Inspect structured values",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        count: { type: "integer" },
        enabled: { type: "boolean" },
        label: { type: "string" },
        metadata: {
          type: "object",
          additionalProperties: false,
          properties: {
            note: { type: "string" },
            ready: { type: "boolean" },
          },
        },
        optional: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    name: "ping",
    description: "No-argument health check",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: "function",
    name: "permissive_schema",
    description: "A schema whose extras are permitted outside this fallback",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: { known: { type: "string" } },
    },
  },
];

function parse(text: string) {
  return parseGlm5AnchoredBareToolCall({ text, tools });
}

describe("GLM 5 anchored bare text fallback", () => {
  it("parses the ACE corporate innovation fixture", () => {
    const result = parse(
      'corporate_innovation_culture(industry="金融科技", total_employees=500)'
    );

    expect(result?.toolName).toBe("corporate_innovation_culture");
    expect(JSON.parse(result?.input ?? "null")).toEqual({
      industry: "金融科技",
      total_employees: 500,
    });
  });

  it("accepts outer whitespace, spacing before the call, and one trailing semicolon", () => {
    expect(
      parse(
        ' \n corporate_innovation_culture  ( industry = "金融科技" , total_employees = 500 ) ; \t'
      )
    ).toEqual({
      input: '{"industry":"金融科技","total_employees":500}',
      toolName: "corporate_innovation_culture",
    });
  });

  it("keeps commas, equals signs, and delimiters inside quoted values", () => {
    const result = parse(
      'inspect_payload(label="left,right=[x](y)=done", count="2")'
    );

    expect(JSON.parse(result?.input ?? "null")).toEqual({
      label: "left,right=[x](y)=done",
      count: 2,
    });
  });

  it("parses RJSON structures and Python literals without rewriting quoted text", () => {
    const result = parse(
      "inspect_payload(enabled=True, metadata={'ready': False, note: 'True story, None'}, tags=['alpha', 'beta'], optional=None)"
    );

    expect(JSON.parse(result?.input ?? "null")).toEqual({
      enabled: true,
      metadata: { ready: false, note: "True story, None" },
      tags: ["alpha", "beta"],
      optional: null,
    });
  });

  it("accepts a complete exact no-argument call", () => {
    expect(parse("ping()")).toEqual({ input: "{}", toolName: "ping" });
  });

  it.each([
    'I will call corporate_innovation_culture(industry="金融科技", total_employees=500)',
    'corporate_innovation_culture(industry="金融科技", total_employees=500) done',
    '```corporate_innovation_culture(industry="金融科技", total_employees=500)```',
    'Corporate_innovation_culture(industry="金融科技", total_employees=500)',
    'unknown(industry="金融科技", total_employees=500)',
    'corporate_innovation_culture(industry="金融科技", total_employees=500);;',
  ])("rejects an unanchored or unknown tool call: %s", (text) => {
    expect(parse(text)).toBeNull();
  });

  it.each([
    'corporate_innovation_culture("金融科技", 500)',
    'corporate_innovation_culture(industry="金融科技", 500)',
    'corporate_innovation_culture(industry="金融科技", total_employees)',
    'corporate_innovation_culture(industry="金融科技", total_employees=500=501)',
    'corporate_innovation_culture(industry="金融科技", unknown=500)',
    'permissive_schema(unknown="still not declared")',
    'corporate_innovation_culture(industry="金融科技", industry="银行", total_employees=500)',
    'corporate_innovation_culture(industry="金融科技", total_employees=500,)',
    'corporate_innovation_culture(,industry="金融科技", total_employees=500)',
  ])(
    "rejects non-named, duplicate, empty, or unknown arguments: %s",
    (text) => {
      expect(parse(text)).toBeNull();
    }
  );

  it.each([
    "inspect_payload(label=bare_text)",
    'inspect_payload(label="unterminated)',
    'inspect_payload(label="dangling\\")',
    "inspect_payload(tags=['alpha', 'beta')",
    "inspect_payload(tags=['alpha', 'beta']])",
    "inspect_payload(metadata={'ready': True)",
    "inspect_payload(metadata={'ready': True}) trailing",
  ])("rejects unsupported or truncated value syntax: %s", (text) => {
    expect(parse(text)).toBeNull();
  });

  it.each([
    'inspect_payload(__proto__={"polluted": true})',
    'inspect_payload(constructor={"polluted": true})',
    'inspect_payload(prototype={"polluted": true})',
    'inspect_payload(metadata={"__proto__": {"polluted": true}})',
    'inspect_payload(metadata={"safe": {"constructor": {"polluted": true}}})',
    'inspect_payload(label="{\\"__proto__\\": {\\"polluted\\": true}}")',
  ])("rejects prototype-sensitive argument structure: %s", (text) => {
    expect(parse(text)).toBeNull();
    expect(
      (Object.prototype as Record<string, unknown>).polluted
    ).toBeUndefined();
  });

  it("does not emit a call from any proper streamed prefix", () => {
    const text =
      'corporate_innovation_culture(industry="金融科技", total_employees=500)';
    for (let end = 0; end < text.length; end += 1) {
      expect(parse(text.slice(0, end))).toBeNull();
    }
    expect(parse(text)).not.toBeNull();
  });

  it("is independent of how a completed response is chunked", () => {
    const text =
      'corporate_innovation_culture(industry="金融科技", total_employees=500)';
    const expected = parse(text);

    for (let first = 0; first <= text.length; first += 7) {
      for (let second = first; second <= text.length; second += 11) {
        const chunks = [
          text.slice(0, first),
          text.slice(first, second),
          text.slice(second),
        ];
        expect(parse(chunks.join(""))).toEqual(expected);
      }
    }
  });

  it("fails closed above the bounded input and nesting limits", () => {
    expect(parse(`inspect_payload(label="${"x".repeat(102_400)}")`)).toBeNull();
    expect(
      parse(`inspect_payload(tags=${"[".repeat(257)}${"]".repeat(257)})`)
    ).toBeNull();
  });
});
