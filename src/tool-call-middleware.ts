import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Middleware,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import type { ToolResponsePromptTemplateResult } from "./core/prompts/shared/tool-role-to-user-message";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import { isTCMProtocolFactory } from "./core/protocols/protocol-interface";
import { wrapGenerate as wrapGenerateHandler } from "./generate-handler";
import { wrapStream as wrapStreamHandler } from "./stream-handler";
import { transformParams } from "./transform-handler";

export function createToolMiddleware({
  protocol,
  toolSystemPromptTemplate,
  toolResponsePromptTemplate,
  placement = "last",
}: {
  protocol: TCMCoreProtocol | (() => TCMCoreProtocol);
  toolSystemPromptTemplate: (tools: LanguageModelV3FunctionTool[]) => string;
  toolResponsePromptTemplate?: (
    toolResult: ToolResultPart
  ) => ToolResponsePromptTemplateResult;
  placement?: "first" | "last";
}): LanguageModelV3Middleware {
  const resolvedProtocol = isTCMProtocolFactory(protocol)
    ? protocol()
    : protocol;

  return {
    specificationVersion: "v3",
    wrapStream: ({ doStream, doGenerate, params }) =>
      wrapStreamHandler({
        protocol: resolvedProtocol,
        doStream,
        doGenerate,
        params,
      }),
    wrapGenerate: async ({ doGenerate, params }) =>
      wrapGenerateHandler({
        protocol: resolvedProtocol,
        doGenerate,
        params,
      }),
    transformParams: async ({ params }): Promise<LanguageModelV3CallOptions> =>
      transformParams({
        protocol: resolvedProtocol,
        toolSystemPromptTemplate,
        toolResponsePromptTemplate,
        placement,
        params,
      }),
  };
}
