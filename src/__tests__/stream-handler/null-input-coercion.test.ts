import type {
  JSONSchema7,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import type { TCMCoreProtocol } from "../../core/protocols/protocol-interface";
import { originalToolsSchema } from "../../core/utils/provider-options";
import { wrapStream } from "../../stream-handler";

const passthroughProtocol: TCMCoreProtocol = {
  formatTools: ({ toolSystemPromptTemplate }) => toolSystemPromptTemplate([]),
  formatToolCall: () => "",
  parseGeneratedText: () => [],
  createStreamParser: () => new TransformStream(),
};

function calcTool(inputSchema: JSONSchema7): LanguageModelV4FunctionTool {
  return { type: "function", name: "calc", inputSchema };
}

function nullCall() {
  return {
    type: "tool-call",
    toolCallId: "id",
    toolName: "calc",
    input: null,
  };
}

async function coerceNull(
  inputSchema: JSONSchema7,
  call: ReturnType<typeof nullCall>
) {
  const source = new ReadableStream({
    pull(controller) {
      controller.enqueue(call);
      controller.close();
    },
  });
  const result = await wrapStream({
    protocol: passthroughProtocol,
    doStream: vi.fn().mockResolvedValue({ stream: source }),
    doGenerate: vi.fn(),
    params: {
      providerOptions: {
        toolCallMiddleware: {
          originalTools: originalToolsSchema.encode([calcTool(inputSchema)]),
        },
      },
    },
  });
  return convertReadableStreamToArray(result.stream);
}

describe("wrapStream null input coercion", () => {
  it("leaves streamed null tool-call input unchanged for non-nullable schemas", async () => {
    const malformedToolCall = nullCall();
    const parts = await coerceNull(
      { type: "object", properties: { a: { type: "number" } } },
      malformedToolCall
    );
    expect(parts[0]).toBe(malformedToolCall);
  });

  it("preserves streamed null tool-call input for nullable schemas", async () => {
    const parts = await coerceNull(
      {
        type: ["object", "null"],
        properties: { a: { type: "number" } },
      },
      nullCall()
    );
    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "calc",
      input: "null",
    });
  });
});
