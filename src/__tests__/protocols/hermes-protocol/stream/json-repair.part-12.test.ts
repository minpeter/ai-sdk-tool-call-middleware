import type * as AiProvider from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import {
  requireToolCall,
  runProtocolTextStream,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

type RepairError = NonNullable<ParserOptions["onError"]>;
type JSONSchema7 = AiProvider.JSONSchema7;
type JSONValue = AiProvider.JSONValue;
type LanguageModelV4FunctionTool = AiProvider.LanguageModelV4FunctionTool;
type LanguageModelV4StreamPart = AiProvider.LanguageModelV4StreamPart;

function tool(
  name: string,
  inputSchema: JSONSchema7
): LanguageModelV4FunctionTool {
  return { type: "function", inputSchema, name };
}

function runRepair(
  name: string,
  inputSchema: JSONSchema7,
  argumentsText: string,
  onError: RepairError
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    protocol: hermesProtocol(),
    tools: [tool(name, inputSchema)],
    id: "1",
    chunks: [
      `<tool_call>{"name":${JSON.stringify(name)},"arguments":${argumentsText}}</tool_call>`,
    ],
    parserOptions: { onError },
  });
}

function verifyRejected(
  output: LanguageModelV4StreamPart[],
  onError: RepairError
): void {
  const events = selectToolInputTimeline(output);
  expect(output.find((part) => part.type === "tool-call")).toBeUndefined();
  expect(events.starts).toHaveLength(0);
  expect(events.deltas).toHaveLength(0);
  expect(events.ends).toHaveLength(0);
  expect(onError).toHaveBeenCalled();
}

function verifyAccepted(
  output: LanguageModelV4StreamPart[],
  expected: JSONValue,
  onError: RepairError
): void {
  const call = output.find((part) => part.type === "tool-call");
  expect(call).toBeTruthy();
  expect(JSON.parse(requireToolCall(output).input)).toEqual(expected);
  const events = selectToolInputTimeline(output);
  expect(events.starts.length > 0).toBe(true);
  expect(events.deltas.length > 0).toBe(true);
  expect(events.ends.length > 0).toBe(true);
  expect(onError).not.toHaveBeenCalled();
}

const unsafePattern = "^(a+)+$";
const permissivePayload: JSONSchema7 = {
  type: "object",
  additionalProperties: true,
};
const requiredPayloadPattern: JSONSchema7 = {
  type: "object",
  properties: { must: { type: "string" } },
  required: ["must"],
  additionalProperties: false,
};

function strictBranch(
  property: string,
  definition: JSONSchema7,
  required: string
): JSONSchema7 {
  return {
    type: "object",
    properties: { [property]: definition },
    required: [required],
    additionalProperties: false,
  };
}

describe("json-repair.test split 12", () => {
  it("rejects top-level oneOf inputs with keys from multiple strict branches", async () => {
    const onError = vi.fn<RepairError>();
    const out = await runRepair(
      "edit",
      {
        oneOf: [
          strictBranch("city", { type: "string" }, "city"),
          strictBranch("latitude", { type: "number" }, "latitude"),
        ],
      },
      '{"city":"Seoul","latitude":37.5}',
      onError
    );

    verifyRejected(out, onError);
  });

  it("selects top-level oneOf branches by discriminator before dropping mixed keys", async () => {
    const onError = vi.fn<RepairError>();
    const out = await runRepair(
      "edit",
      {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { enum: ["text"] },
              textOnly: { type: "string" },
            },
            required: ["kind", "textOnly"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { enum: ["count"] },
              countOnly: { type: "number" },
            },
            required: ["kind", "countOnly"],
            additionalProperties: false,
          },
        ],
      },
      '{"kind":"count","countOnly":3,"textOnly":"drop-me"}',
      onError
    );

    const call = out.find((part) => part.type === "tool-call");
    expect(call?.type).toBe("tool-call");
    expect(JSON.parse(requireToolCall(out).input)).toEqual({
      kind: "count",
      countOnly: 3,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("applies every matching property and pattern schema", async () => {
    const onError = vi.fn<RepairError>();
    const out = await runRepair(
      "edit",
      {
        type: "object",
        properties: { payload: permissivePayload },
        patternProperties: { "^payload$": requiredPayloadPattern },
        additionalProperties: false,
      },
      '{"payload":{"other":"bad"}}',
      onError
    );

    verifyRejected(out, onError);
  });

  it("preserves safe additional keys when a denied pattern is unsafe", async () => {
    const onError = vi.fn<RepairError>();
    const out = await runRepair(
      "write",
      {
        type: "object",
        properties: { content: { type: "string" } },
        patternProperties: { [unsafePattern]: false },
        additionalProperties: true,
      },
      '{"content":"ok","note":"safe"}',
      onError
    );

    verifyAccepted(out, { content: "ok", note: "safe" }, onError);
  });

  it("rejects unsafe positive patternProperties that may match constrained keys", async () => {
    const onError = vi.fn<RepairError>();
    const out = await runRepair(
      "write",
      {
        type: "object",
        patternProperties: {
          [unsafePattern]: { type: "string", enum: ["allowed"] },
        },
        additionalProperties: true,
      },
      '{"aaaa":123}',
      onError
    );

    verifyRejected(out, onError);
  });
});
