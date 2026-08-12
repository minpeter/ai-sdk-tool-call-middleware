import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { requireTransformParams } from "../test-helpers";

const providerTool = {
  type: "provider" as const,
  id: "openai.web_search" as const,
  name: "web_search",
  args: {},
};

const functionTool = {
  type: "function" as const,
  name: "op",
  description: "desc",
  inputSchema: { type: "object" as const },
};

const middleware = createToolMiddleware({
  protocol: hermesProtocol,
  toolSystemPromptTemplate: (tools) => `SYS:${tools.length}`,
});
const transformParams = requireTransformParams(middleware.transformParams);
const prompt: LanguageModelV4CallOptions["prompt"] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];
const unsupportedError =
  "Provider-defined tools are not supported by this middleware. Please use custom function tools.";

describe("provider-defined tool rejection", () => {
  it.each([
    { id: "provider-only auto", tools: [providerTool], toolChoice: undefined },
    {
      id: "mixed auto",
      tools: [functionTool, providerTool],
      toolChoice: undefined,
    },
    {
      id: "provider-only none",
      tools: [providerTool],
      toolChoice: { type: "none" as const },
    },
    {
      id: "mixed none",
      tools: [functionTool, providerTool],
      toolChoice: { type: "none" as const },
    },
    {
      id: "provider-only required",
      tools: [providerTool],
      toolChoice: { type: "required" as const },
    },
    {
      id: "mixed required",
      tools: [functionTool, providerTool],
      toolChoice: { type: "required" as const },
    },
    {
      id: "provider-only selected",
      tools: [providerTool],
      toolChoice: { type: "tool" as const, toolName: "web_search" },
    },
    {
      id: "mixed function selected",
      tools: [functionTool, providerTool],
      toolChoice: { type: "tool" as const, toolName: "op" },
    },
  ])("rejects $id before transforming the request", async (scenario) => {
    await expect(
      transformParams({
        type: "generate",
        params: {
          prompt,
          tools: scenario.tools,
          toolChoice: scenario.toolChoice,
        } as LanguageModelV4CallOptions,
      } as Parameters<typeof transformParams>[0])
    ).rejects.toThrow(unsupportedError);
  });
});
