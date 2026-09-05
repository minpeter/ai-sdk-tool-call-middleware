import type { JSONValue } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  expectAcceptedGeneratedInput,
  expectRejectedGeneratedRepair,
  requireGeneratedToolCall,
  runGeneratedRepair,
} from "./json-repair-parts-5-6-harness";

function payloadValueSchema(secondType: "number" | "integer"): JSONValue {
  return {
    type: "object",
    properties: {
      payload: {
        oneOf: [
          {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { value: { type: secondType } },
            required: ["value"],
            additionalProperties: false,
          },
        ],
      },
    },
    additionalProperties: false,
  };
}

describe("json-repair.test split 6", () => {
  it("rejects strict primitive property values that cannot be coerced", () => {
    expectRejectedGeneratedRepair(
      runGeneratedRepair(
        '<tool_call>{"name":"count","arguments":{"count":"abc"}}</tool_call>',
        "count",
        {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
          additionalProperties: false,
        }
      )
    );
  });

  it("drops unknown keys through strict allOf schemas", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"write","arguments":{"safe":"ok","secret":"leak"}}</tool_call>',
      "write",
      {
        allOf: [
          {
            type: "object",
            properties: { safe: { type: "string" } },
            required: ["safe"],
            additionalProperties: false,
          },
        ],
      }
    );

    expectAcceptedGeneratedInput(result, { safe: "ok" });
  });

  it("sanitizes nested array item keys through allOf schemas", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"write","arguments":{"payload":[{"value":"ok","secret":"leak"}]}}</tool_call>',
      "write",
      {
        type: "object",
        properties: {
          payload: {
            allOf: [
              {
                type: "array",
                items: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  additionalProperties: false,
                },
              },
            ],
          },
        },
        additionalProperties: false,
      }
    );

    expect(requireGeneratedToolCall(result)).toMatchObject({
      type: "tool-call",
      toolName: "write",
      input: '{"payload":[{"value":"ok"}]}',
    });
    expect(result.onError).not.toHaveBeenCalled();
  });

  it("sanitizes nested tuple item keys through draft-07 items arrays", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"write","arguments":{"rows":[{"value":"ok","secret":"leak"}]}}</tool_call>',
      "write",
      {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: [
              {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            ],
            additionalItems: false,
          },
        },
        required: ["rows"],
        additionalProperties: false,
      }
    );

    expect(requireGeneratedToolCall(result)).toMatchObject({
      type: "tool-call",
      toolName: "write",
      input: '{"rows":[{"value":"ok"}]}',
    });
    expect(result.onError).not.toHaveBeenCalled();
  });

  it("rejects values that match multiple oneOf schemas", () => {
    const duplicateBranch: JSONValue = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expectRejectedGeneratedRepair(
      runGeneratedRepair(
        '<tool_call>{"name":"write","arguments":{"payload":{"a":"ok"}}}</tool_call>',
        "write",
        {
          type: "object",
          properties: {
            payload: { oneOf: [duplicateBranch, duplicateBranch] },
          },
          additionalProperties: false,
        }
      )
    );
  });

  it("accepts values that match a primitive oneOf branch", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"edit","arguments":{"payload":"abc"}}</tool_call>',
      "edit",
      {
        type: "object",
        properties: {
          payload: {
            oneOf: [
              {
                type: "object",
                properties: { content: { type: "string" } },
                required: ["content"],
                additionalProperties: false,
              },
              { type: "string" },
            ],
          },
        },
        additionalProperties: false,
      }
    );

    expectAcceptedGeneratedInput(result, { payload: "abc" });
  });

  it("accepts oneOf object branches distinguished by nested primitive value types", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"edit","arguments":{"payload":{"value":"abc"}}}</tool_call>',
      "edit",
      payloadValueSchema("number")
    );

    expectAcceptedGeneratedInput(result, { payload: { value: "abc" } });
  });

  it("does not count numeric strings as numeric oneOf matches", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"edit","arguments":{"payload":{"value":"123"}}}</tool_call>',
      "edit",
      payloadValueSchema("integer")
    );

    expectAcceptedGeneratedInput(result, { payload: { value: "123" } });
  });

  it("rejects non-finite numeric strings for number and integer schemas", () => {
    const cases = [
      { schemaType: "number", value: "1e999" },
      { schemaType: "integer", value: "9".repeat(400) },
    ];
    for (const { schemaType, value } of cases) {
      expectRejectedGeneratedRepair(
        runGeneratedRepair(
          `<tool_call>{"name":"edit","arguments":{"value":${JSON.stringify(value)}}}</tool_call>`,
          "edit",
          {
            type: "object",
            properties: { value: { type: schemaType } },
            required: ["value"],
            additionalProperties: false,
          }
        )
      );
    }
  });
});
