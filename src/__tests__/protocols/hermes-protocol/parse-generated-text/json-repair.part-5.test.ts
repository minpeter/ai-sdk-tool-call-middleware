import type { JSONValue } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  expectAcceptedGeneratedInput,
  expectRejectedGeneratedRepair,
  requireGeneratedToolCall,
  runGeneratedRepair,
} from "./json-repair-parts-5-6-harness";

const strictStringObject: JSONValue = {
  type: "object",
  properties: { content: { type: "string" } },
  required: ["content"],
  additionalProperties: false,
};

describe("json-repair.test split 5", () => {
  it("drops nested argument keys disallowed by false schemas", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"write","arguments":{"payload":{"value":"ok","secret":"blocked"}}}</tool_call>',
      "write",
      {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: {
              secret: false,
              value: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        required: ["payload"],
        additionalProperties: false,
      }
    );

    expectAcceptedGeneratedInput(result, { payload: { value: "ok" } });
  });

  it("rejects top-level boolean false input schemas", () => {
    const schemas: JSONValue[] = [false, { jsonSchema: false }];
    for (const schema of schemas) {
      expectRejectedGeneratedRepair(
        runGeneratedRepair(
          '<tool_call>{"name":"deny","arguments":{"content":"ok"}}</tool_call>',
          "deny",
          schema
        )
      );
    }
  });

  it("rejects non-object arguments for top-level boolean false input schemas", () => {
    const schemas: JSONValue[] = [false, { jsonSchema: false }];
    for (const schema of schemas) {
      for (const argument of ["[]", "null", '"x"']) {
        expectRejectedGeneratedRepair(
          runGeneratedRepair(
            `<tool_call>{"name":"deny","arguments":${argument}}</tool_call>`,
            "deny",
            schema
          )
        );
      }
    }
  });

  it("rejects non-object arguments for object input schemas", () => {
    const schemas: JSONValue[] = [
      {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
      strictStringObject,
    ];
    for (const schema of schemas) {
      for (const argument of ["[]", "null", '"x"']) {
        expectRejectedGeneratedRepair(
          runGeneratedRepair(
            `<tool_call>{"name":"write","arguments":${argument}}</tool_call>`,
            "write",
            schema
          )
        );
      }
    }
  });

  it("accepts omitted arguments for no-input tool calls", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"ping"}</tool_call>',
      "ping",
      { type: "object", properties: {}, additionalProperties: false }
    );

    expect(requireGeneratedToolCall(result).input).toBe("{}");
    expect(result.onError).not.toHaveBeenCalled();
  });

  it("accepts null arguments when the top-level schema allows null", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"write","arguments":null}</tool_call>',
      "write",
      {
        type: ["object", "null"],
        properties: { content: { type: "string" } },
        additionalProperties: false,
      }
    );

    expect(requireGeneratedToolCall(result).input).toBe("null");
    expect(result.onError).not.toHaveBeenCalled();
  });

  it("rejects null arguments without a matching nullable schema", () => {
    const text = '<tool_call>{"name":"write","arguments":null}</tool_call>';
    const result = runGeneratedRepair(text, "write", { type: "object" });

    expectRejectedGeneratedRepair(result);
    expect(result.output).toContainEqual({ type: "text", text });
  });

  it("drops args for schemas without declared properties when additionalProperties is false", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"write","arguments":{"x-":"ok"}}</tool_call>',
      "write",
      { type: "object", additionalProperties: false }
    );

    expectAcceptedGeneratedInput(result, {});
  });

  it("rejects null for non-nullable typed object properties", () => {
    expectRejectedGeneratedRepair(
      runGeneratedRepair(
        '<tool_call>{"name":"write","arguments":{"content":null}}</tool_call>',
        "write",
        strictStringObject
      )
    );
  });

  it("accepts null for nullable object and array properties", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"write","arguments":{"payload":null,"rows":null}}</tool_call>',
      "write",
      {
        type: "object",
        properties: {
          payload: {
            type: ["object", "null"],
            properties: { content: { type: "string" } },
            required: ["content"],
            additionalProperties: false,
          },
          rows: {
            type: ["array", "null"],
            items: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        },
        required: ["payload", "rows"],
        additionalProperties: false,
      }
    );

    expectAcceptedGeneratedInput(result, { payload: null, rows: null });
  });

  it("rejects non-object arguments for allOf-wrapped strict object input schemas", () => {
    for (const argument of ["[]", '"scalar"']) {
      expectRejectedGeneratedRepair(
        runGeneratedRepair(
          `<tool_call>{"name":"write","arguments":${argument}}</tool_call>`,
          "write",
          { allOf: [strictStringObject] }
        )
      );
    }
  });

  it("coerces keys before validating allOf-wrapped strict object schemas", () => {
    const result = runGeneratedRepair(
      '<tool_call>{"name":"translate","arguments":{"target_language":"ko"}}</tool_call>',
      "translate",
      {
        allOf: [
          {
            type: "object",
            properties: { targetLanguage: { type: "string" } },
            required: ["targetLanguage"],
            additionalProperties: false,
          },
        ],
      }
    );

    expectAcceptedGeneratedInput(result, { targetLanguage: "ko" });
  });
});
