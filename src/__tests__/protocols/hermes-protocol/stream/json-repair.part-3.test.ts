import type { JSONSchema7 } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  requireToolCall,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";
import {
  expectRejectedStreamRepair,
  runWriteStreamRepair,
} from "./json-repair-parts-3-4-harness";

const stringNoteSchema: JSONSchema7 = {
  type: "object",
  properties: { note: { type: "string" } },
  additionalProperties: false,
};

const rejectedRepairCases = [
  {
    name: "rejects unquoted strict RJSON with prototype-sensitive argument keys",
    additionalProperties: false,
    texts: [
      '<tool_call>{name:"write",arguments:{__proto__:{polluted:true},content:"ok"}}</tool_call>',
    ],
  },
  {
    name: "rejects unquoted prototype-sensitive RJSON keys after comments",
    additionalProperties: false,
    texts: [
      '<tool_call>{name:"write",arguments:{/* comment */__proto__:{polluted:true},content:"ok"}}</tool_call>',
      '<tool_call>{name:"write",arguments:{// comment\n__proto__:{polluted:true},content:"ok"}}</tool_call>',
    ],
  },
  {
    name: "rejects prototype-sensitive RJSON keys after leading comments",
    additionalProperties: true,
    texts: [
      '<tool_call>/*{}*/{name:"write",arguments:{__proto__:{polluted:true},content:"ok"}}</tool_call>',
    ],
  },
  {
    name: "rejects prototype-sensitive argument keys even when unknown keys are allowed",
    additionalProperties: true,
    texts: [
      '<tool_call>{"name":"write","arguments":{"content":"ok","constructor":{"polluted":true}}}</tool_call>',
    ],
  },
  {
    name: "rejects escaped single-quoted strict RJSON prototype-sensitive argument keys",
    additionalProperties: false,
    texts: [
      '<tool_call>{name:"write",arguments:{\'\\u005f\\u005fproto__\':{polluted:true},content:"ok"}}</tool_call>',
    ],
  },
] as const;

describe("json-repair.test split 3", () => {
  it.each([
    "constructor: ordinary prose",
    "prototype: ordinary prose",
    "constructor: true",
  ] as const)(
    "preserves schema-valid string argument value %s",
    async (note) => {
      const input = JSON.stringify({ note });
      const result = await runWriteStreamRepair(
        `<tool_call>${JSON.stringify({
          name: "write",
          arguments: { note },
        })}</tool_call>`,
        stringNoteSchema
      );
      const tool = requireToolCall(result.parts);
      const { deltas } = selectToolInputTimeline(result.parts);

      expect(tool.toolName).toBe("write");
      expect(tool.input).toBe(input);
      expect(deltas.map((part) => part.delta).join("")).toBe(input);
    }
  );

  for (const testCase of rejectedRepairCases) {
    it(testCase.name, async () => {
      for (const text of testCase.texts) {
        const result = await runWriteStreamRepair(text, {
          type: "object",
          properties: { content: { type: "string" } },
          additionalProperties: testCase.additionalProperties,
        });

        expectRejectedStreamRepair(result);
      }
    });
  }

  it("accepts coercible keys before strict schema validation", async () => {
    const result = await runWriteStreamRepair(
      '<tool_call>{"name":"translate","arguments":{"text":"Ship","target_language":"fr","formality":"casual"}}</tool_call>',
      {
        additionalProperties: false,
        required: ["text", "targetLanguage", "formality"],
        properties: {
          formality: { type: "string" },
          targetLanguage: { type: "string" },
          text: { type: "string" },
        },
        type: "object",
      },
      "translate"
    );

    expect(JSON.parse(requireToolCall(result.parts).input)).toEqual({
      text: "Ship",
      targetLanguage: "fr",
      formality: "casual",
    });
  });
});
