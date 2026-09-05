import type { JSONSchema7 } from "@ai-sdk/provider";
import { describe, it } from "vitest";
import {
  expectAcceptedStreamObject,
  expectRejectedStreamRepair,
  runWriteStreamRepair,
} from "./json-repair-parts-3-4-harness";

const rejectionCases = [
  {
    name: "rejects inherited tool call fields from __proto__ wrappers",
    schema: {
      type: "object",
      properties: { content: { type: "string" } },
    },
    text: '<tool_call>{"__proto__":{"name":"write","arguments":{"content":"ok"}}}</tool_call>',
  },
  {
    name: "rejects __proto__ keys in strict repair bookkeeping",
    schema: {
      type: "object",
      properties: { content: { type: "string" } },
      additionalProperties: false,
    },
    text: '<tool_call>{"name":"write","arguments":{"__proto__":{"content":"bypass"},"content":"He said "hi" there"}}</tool_call>',
  },
] as const satisfies readonly {
  readonly name: string;
  readonly schema: JSONSchema7;
  readonly text: string;
}[];

const acceptedCases = [
  {
    name: "keeps patternProperties keys when properties are declared",
    schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      patternProperties: {
        "^(x|y)-": { type: "string" },
        "^z-[0-9]+$": { type: "string" },
      },
      additionalProperties: false,
    },
    text: '<tool_call>{"name":"write","arguments":{"content":"ok","x-debug":"kept","y-trace":"yes","z-123":"num","path":"/tmp/a"}}</tool_call>',
    expected: {
      content: "ok",
      "x-debug": "kept",
      "y-trace": "yes",
      "z-123": "num",
      path: "/tmp/a",
    },
    timeline: false,
  },
  {
    name: "keeps non-capturing patternProperties-only keys for strict schemas",
    schema: {
      type: "object",
      patternProperties: { "^(?:x-)+$": { type: "string" } },
      additionalProperties: false,
    },
    text: '<tool_call>{"name":"write","arguments":{"x-":"ok"}}</tool_call>',
    expected: { "x-": "ok" },
    timeline: false,
  },
  {
    name: "drops args for schemas without declared properties when additionalProperties is false",
    schema: { type: "object", additionalProperties: false },
    text: '<tool_call>{"name":"write","arguments":{"x-":"ok"}}</tool_call>',
    expected: {},
    timeline: false,
  },
  {
    name: "drops patternProperties false matches for strict schemas",
    schema: {
      type: "object",
      properties: { content: { type: "string" } },
      patternProperties: { "^x-": false },
      additionalProperties: false,
    },
    text: '<tool_call>{"name":"write","arguments":{"content":"ok","x-secret":"blocked"}}</tool_call>',
    expected: { content: "ok" },
    timeline: true,
  },
  {
    name: "drops false property schemas for strict schemas",
    schema: {
      type: "object",
      properties: { content: { type: "string" }, secret: false },
      additionalProperties: false,
    },
    text: '<tool_call>{"name":"write","arguments":{"content":"ok","secret":"blocked"}}</tool_call>',
    expected: { content: "ok" },
    timeline: true,
  },
] as const satisfies readonly {
  readonly expected: object;
  readonly name: string;
  readonly schema: JSONSchema7;
  readonly text: string;
  readonly timeline: boolean;
}[];

describe("json-repair.test split 4", () => {
  for (const { name, schema, text } of rejectionCases) {
    it(name, async () => {
      expectRejectedStreamRepair(await runWriteStreamRepair(text, schema));
    });
  }

  for (const { expected, name, schema, text, timeline } of acceptedCases) {
    it(name, async () => {
      expectAcceptedStreamObject(
        await runWriteStreamRepair(text, schema),
        expected,
        timeline
      );
    });
  }
});
