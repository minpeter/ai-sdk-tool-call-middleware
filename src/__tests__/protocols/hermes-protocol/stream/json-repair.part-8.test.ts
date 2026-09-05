import type {
  JSONObject,
  JSONSchema7,
  JSONSchema7Definition,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  parseToolCallObject,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

function schemaTool(
  name: string,
  inputSchema: LanguageModelV4FunctionTool["inputSchema"]
): LanguageModelV4FunctionTool {
  return { inputSchema, name, type: "function" };
}

function strictObject(
  properties: Record<string, JSONSchema7Definition>,
  required: string[] = []
): JSONSchema7 {
  return { additionalProperties: false, properties, required, type: "object" };
}

function streamRepair(
  chunks: readonly string[],
  tools: LanguageModelV4FunctionTool[],
  onError: (message: string) => void
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    chunks,
    id: "hermes-repair-part-8",
    parserOptions: { onError },
    protocol: hermesProtocol(),
    tools,
  });
}

function expectNoLifecycle(parts: readonly LanguageModelV4StreamPart[]): void {
  const timeline = selectToolInputTimeline(parts);
  expect(selectToolCalls(parts)).toHaveLength(0);
  expect(timeline.starts).toHaveLength(0);
  expect(timeline.deltas).toHaveLength(0);
  expect(timeline.ends).toHaveLength(0);
}

function expectCompletedLifecycle(
  parts: readonly LanguageModelV4StreamPart[]
): void {
  const timeline = selectToolInputTimeline(parts);
  expect(timeline.starts.length).toBeGreaterThan(0);
  expect(timeline.deltas.length).toBeGreaterThan(0);
  expect(timeline.ends.length).toBeGreaterThan(0);
}

describe("json-repair.test split 8", () => {
  it("rejects null for non-nullable typed object properties", async () => {
    const onError = vi.fn();
    const schema = strictObject({ content: { type: "string" } }, ["content"]);
    const out = await streamRepair(
      ['<tool_call>{"name":"write","arguments":{"content":null}}</tool_call>'],
      [schemaTool("write", schema)],
      onError
    );
    expectNoLifecycle(out);
    expect(onError).toHaveBeenCalled();
  });

  it("accepts null arguments when the top-level schema allows null", async () => {
    const onError = vi.fn();
    const nullable: JSONSchema7 = {
      additionalProperties: false,
      properties: { content: { type: "string" } },
      type: ["object", "null"],
    };
    const out = await streamRepair(
      ['<tool_call>{"name":"write","arguments":null}</tool_call>'],
      [schemaTool("write", nullable)],
      onError
    );
    expect(selectToolCalls(out)[0]?.input).toBe("null");
    expectCompletedLifecycle(out);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects null arguments without a matching nullable schema", async () => {
    const onError = vi.fn();
    const out = await streamRepair(
      ['<tool_call>{"name":"write","arguments":null}</tool_call>'],
      [],
      onError
    );
    expectNoLifecycle(out);
    expect(onError).toHaveBeenCalled();
  });

  it("accepts null for nullable object and array properties", async () => {
    const onError = vi.fn();
    const item = strictObject({ value: { type: "string" } }, ["value"]);
    const inputSchema = strictObject(
      {
        payload: {
          additionalProperties: false,
          properties: { content: { type: "string" } },
          required: ["content"],
          type: ["object", "null"],
        },
        rows: { items: item, type: ["array", "null"] },
      },
      ["payload", "rows"]
    );
    const out = await streamRepair(
      [
        '<tool_call>{"name":"write","arguments":{"payload":null,"rows":null}}</tool_call>',
      ],
      [schemaTool("write", inputSchema)],
      onError
    );
    const [tool] = selectToolCalls(out);
    expect(tool && parseToolCallObject(tool)).toEqual({
      payload: null,
      rows: null,
    } satisfies JSONObject);
    expectCompletedLifecycle(out);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects non-object arguments for allOf-wrapped strict object input schemas", async () => {
    const inputSchema: JSONSchema7 = {
      allOf: [strictObject({ content: { type: "string" } }, ["content"])],
    };
    for (const argumentBody of ["[]", '"scalar"']) {
      const onError = vi.fn();
      const out = await streamRepair(
        [`<tool_call>{"name":"write","arguments":${argumentBody}}</tool_call>`],
        [schemaTool("write", inputSchema)],
        onError
      );
      expectNoLifecycle(out);
      expect(onError).toHaveBeenCalled();
    }
  });

  it("coerces keys before validating allOf-wrapped strict object schemas", async () => {
    const onError = vi.fn();
    const inputSchema: JSONSchema7 = {
      allOf: [
        strictObject({ targetLanguage: { type: "string" } }, [
          "targetLanguage",
        ]),
      ],
    };
    const out = await streamRepair(
      [
        '<tool_call>{"name":"translate","arguments":{"target_language":"ko"}}</tool_call>',
      ],
      [schemaTool("translate", inputSchema)],
      onError
    );
    const [tool] = selectToolCalls(out);
    expect(tool && parseToolCallObject(tool)).toEqual({
      targetLanguage: "ko",
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
