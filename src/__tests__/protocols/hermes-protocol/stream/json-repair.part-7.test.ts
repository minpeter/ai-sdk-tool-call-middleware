import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

function schemaTool(
  name: string,
  inputSchema: JSONSchema7
): LanguageModelV4FunctionTool {
  return { type: "function", name, inputSchema };
}

// These cases intentionally pass invalid top-level schemas to the runtime guard.
function malformedSchemaTool(
  name: string,
  inputSchema: JSONValue
): LanguageModelV4FunctionTool {
  const tool = schemaTool(name, {});
  Object.defineProperty(tool, "inputSchema", { value: inputSchema });
  return tool;
}

async function expectRejected(
  tool: LanguageModelV4FunctionTool,
  argumentBody: string
): Promise<void> {
  const onError = vi.fn();
  const parts = await runProtocolTextStream({
    chunks: [
      `<tool_call>{"name":"${tool.name}","arguments":${argumentBody}}</tool_call>`,
    ],
    id: "1",
    protocol: hermesProtocol(),
    tools: [tool],
    parserOptions: { onError },
  });

  expect(selectToolCalls(parts)).toEqual([]);
  const { starts, deltas, ends } = selectToolInputTimeline(parts);
  expect([starts.length, deltas.length, ends.length]).toEqual([0, 0, 0]);
  expect(onError).toHaveBeenCalled();
}

const nestedRepairCases = [
  {
    name: "drops nested schema-unknown argument keys",
    payloadSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "drops nested argument keys disallowed by false schemas",
    payloadSchema: {
      type: "object",
      properties: { secret: false, value: { type: "string" } },
      additionalProperties: true,
    },
  },
] as const satisfies readonly {
  readonly name: string;
  readonly payloadSchema: JSONSchema7;
}[];

const falseSchemas: readonly JSONValue[] = [false, { jsonSchema: false }];
const nonObjectArguments = ["[]", "null", '"x"'] as const;
const objectSchemas = [
  {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
  },
  {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
    additionalProperties: false,
  },
] as const satisfies readonly JSONSchema7[];

describe("json-repair.test split 7", () => {
  for (const testCase of nestedRepairCases) {
    it(testCase.name, async () => {
      const onError = vi.fn();
      const out = await runProtocolTextStream({
        chunks: [
          '<tool_call>{"name":"write","arguments":{"payload":{"value":"ok","secret":"blocked"}}}</tool_call>',
        ],
        id: "1",
        protocol: hermesProtocol(),
        tools: [
          schemaTool("write", {
            type: "object",
            properties: { payload: testCase.payloadSchema },
            required: ["payload"],
            additionalProperties: false,
          }),
        ],
        parserOptions: { onError },
      });

      expect(parseToolCallObject(requireToolCall(out))).toEqual({
        payload: { value: "ok" },
      });
      expect(onError).not.toHaveBeenCalled();
    });
  }

  it("rejects top-level boolean false input schemas", async () => {
    for (const inputSchema of falseSchemas) {
      await expectRejected(
        malformedSchemaTool("deny", inputSchema),
        '{"content":"ok"}'
      );
    }
  });

  it("rejects non-object arguments for top-level boolean false input schemas", async () => {
    for (const inputSchema of falseSchemas) {
      for (const argumentBody of nonObjectArguments) {
        await expectRejected(
          malformedSchemaTool("deny", inputSchema),
          argumentBody
        );
      }
    }
  });

  it("rejects non-object arguments for object input schemas", async () => {
    for (const inputSchema of objectSchemas) {
      for (const argumentBody of nonObjectArguments) {
        await expectRejected(schemaTool("write", inputSchema), argumentBody);
      }
    }
  });

  it("accepts omitted arguments for no-input tool calls", async () => {
    const onError = vi.fn();
    const out = await runProtocolTextStream({
      chunks: ['<tool_call>{"name":"ping"}</tool_call>'],
      id: "1",
      protocol: hermesProtocol(),
      tools: [
        schemaTool("ping", {
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
      ],
      parserOptions: { onError },
    });

    expect(requireToolCall(out).input).toBe("{}");
    expect(onError).not.toHaveBeenCalled();
  });
});
