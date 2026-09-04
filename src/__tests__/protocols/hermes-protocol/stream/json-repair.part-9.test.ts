import type {
  JSONSchema7,
  JSONSchema7Definition,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

function toolWithSchema(
  name: string,
  inputSchema: LanguageModelV4FunctionTool["inputSchema"]
): LanguageModelV4FunctionTool {
  return { name, type: "function", inputSchema };
}

function closedObject(
  properties: Record<string, JSONSchema7Definition>,
  required?: string[]
): JSONSchema7 {
  return { type: "object", required, properties, additionalProperties: false };
}

function executeRepair(
  text: string,
  tool: LanguageModelV4FunctionTool,
  onError: (message: string) => void
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    tools: [tool],
    protocol: hermesProtocol(),
    parserOptions: { onError },
    id: "hermes-repair-part-9",
    chunks: [text],
  });
}

function expectLifecycle(parts: readonly LanguageModelV4StreamPart[]): void {
  const { starts, deltas, ends } = selectToolInputTimeline(parts);
  expect(starts.length > 0).toBe(true);
  expect(deltas.length > 0).toBe(true);
  expect(ends.length > 0).toBe(true);
}

function expectRejected(parts: readonly LanguageModelV4StreamPart[]): void {
  const { starts, deltas, ends } = selectToolInputTimeline(parts);
  expect(selectToolCalls(parts)).toHaveLength(0);
  expect([...starts, ...deltas, ...ends]).toHaveLength(0);
}

describe("json-repair.test split 9", () => {
  it("rejects strict primitive property values that cannot be coerced", async () => {
    const onError = vi.fn();
    const out = await executeRepair(
      '<tool_call>{"name":"count","arguments":{"count":"abc"}}</tool_call>',
      toolWithSchema(
        "count",
        closedObject({ count: { type: "integer" } }, ["count"])
      ),
      onError
    );
    expectRejected(out);
    expect(onError).toHaveBeenCalled();
  });

  it("drops unknown keys through strict allOf schemas", async () => {
    const onError = vi.fn();
    const schema: JSONSchema7 = {
      allOf: [closedObject({ safe: { type: "string" } }, ["safe"])],
    };
    const out = await executeRepair(
      '<tool_call>{"name":"write","arguments":{"safe":"ok","secret":"leak"}}</tool_call>',
      toolWithSchema("write", schema),
      onError
    );
    expect(selectToolCalls(out)[0]?.input).toBe('{"safe":"ok"}');
    expectLifecycle(out);
    expect(onError).not.toHaveBeenCalled();
  });

  it("sanitizes nested array item keys through allOf schemas", async () => {
    const onError = vi.fn();
    const item = closedObject({ value: { type: "string" } });
    const schema = closedObject({
      payload: { allOf: [{ items: item, type: "array" }] },
    });
    const out = await executeRepair(
      '<tool_call>{"name":"write","arguments":{"payload":[{"value":"ok","secret":"leak"}]}}</tool_call>',
      toolWithSchema("write", schema),
      onError
    );
    expect(selectToolCalls(out)[0]).toMatchObject({
      type: "tool-call",
      toolName: "write",
      input: '{"payload":[{"value":"ok"}]}',
    });
    expectLifecycle(out);
    expect(onError).not.toHaveBeenCalled();
  });

  it("sanitizes nested tuple item keys through draft-07 items arrays", async () => {
    const onError = vi.fn();
    const row = closedObject({ value: { type: "string" } }, ["value"]);
    const schema = closedObject(
      { rows: { additionalItems: false, items: [row], type: "array" } },
      ["rows"]
    );
    const out = await executeRepair(
      '<tool_call>{"name":"write","arguments":{"rows":[{"value":"ok","secret":"leak"}]}}</tool_call>',
      toolWithSchema("write", schema),
      onError
    );
    expect(selectToolCalls(out)[0]).toMatchObject({
      type: "tool-call",
      toolName: "write",
      input: '{"rows":[{"value":"ok"}]}',
    });
    expectLifecycle(out);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects values that match multiple oneOf schemas", async () => {
    const onError = vi.fn();
    const branch = closedObject({ a: { type: "string" } }, ["a"]);
    const schema = closedObject({ payload: { oneOf: [branch, branch] } });
    const out = await executeRepair(
      '<tool_call>{"name":"write","arguments":{"payload":{"a":"ok"}}}</tool_call>',
      toolWithSchema("write", schema),
      onError
    );
    expectRejected(out);
    expect(onError).toHaveBeenCalled();
  });
});
