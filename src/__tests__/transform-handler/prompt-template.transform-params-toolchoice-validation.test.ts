import type {
  JSONSchema7Definition,
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { requireTransformParams } from "../test-helpers";

const model = new MockLanguageModelV4();

function functionTool(
  name: string,
  description: string,
  properties: Record<string, JSONSchema7Definition> = {}
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    description,
    inputSchema: { type: "object", properties },
  };
}

function transform(params: LanguageModelV4CallOptions) {
  const middleware = createToolMiddleware({
    protocol: hermesProtocol,
    toolSystemPromptTemplate: () =>
      params.toolChoice?.type === "none" ? "TOOL PROMPT" : "",
  });
  return requireTransformParams(middleware.transformParams)({
    type: "generate",
    model,
    params,
  });
}

describe("transformParams toolChoice validation", () => {
  it("transformParams handles toolChoice type none without tool prompt injection", async () => {
    const tools = [functionTool("get_weather", "d", { a: { type: "string" } })];
    const result = await transform({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools,
      toolChoice: { type: "none" },
    });

    // No tool definitions are forwarded and no tool system prompt is added.
    expect(result.tools).toEqual([]);
    expect(result.toolChoice).toBeUndefined();
    expect(result.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(result.providerOptions?.toolCallMiddleware?.toolChoice).toEqual({
      type: "none",
    });
    expect(
      result.providerOptions?.toolCallMiddleware?.originalTools
    ).toBeUndefined();
  });

  it("transformParams validates specific tool selection and builds JSON schema", async () => {
    const tools = [functionTool("t1", "d", { a: { type: "string" } })];
    const result = await transform({
      prompt: [],
      tools,
      toolChoice: { type: "tool", toolName: "t1" },
    });

    expect(result.responseFormat).toMatchObject({ type: "json", name: "t1" });
    expect(result.providerOptions?.toolCallMiddleware?.toolChoice).toEqual({
      type: "tool",
      toolName: "t1",
    });
  });

  it("transformParams required builds if/then/else schema", async () => {
    const tools = [functionTool("a", ""), functionTool("b", "")];
    const result = await transform({
      prompt: [],
      tools,
      toolChoice: { type: "required" },
    });

    expect(result.responseFormat).toMatchObject({ type: "json" });
    expect(result.providerOptions?.toolCallMiddleware?.toolChoice).toEqual({
      type: "required",
    });
  });
});
