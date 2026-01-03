import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Middleware,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { formatToolResponseAsXml } from "./core/prompts/tool-response";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import { isTCMProtocolFactory } from "./core/protocols/protocol-interface";
import { extractOnErrorOption } from "./core/utils/on-error";
import { isToolChoiceActive } from "./core/utils/provider-options";
import { wrapGenerate as wrapGenerateHandler } from "./generate-handler";
import {
  toolChoiceStream,
  wrapStream as wrapStreamHandler,
} from "./stream-handler";
import { transformParams } from "./transform-handler";

export function createToolMiddleware({
  protocol,
  toolSystemPromptTemplate,
  toolResponsePromptTemplate = formatToolResponseAsXml,
  placement = "last",
}: {
  protocol: TCMCoreProtocol | (() => TCMCoreProtocol);
  toolSystemPromptTemplate: (tools: LanguageModelV3FunctionTool[]) => string;
  toolResponsePromptTemplate?: (toolResult: ToolResultPart) => string;
  placement?: "first" | "last";
}): LanguageModelV3Middleware {
  const resolvedProtocol = isTCMProtocolFactory(protocol)
    ? protocol()
    : protocol;

  return {
    specificationVersion: "v3",
    wrapStream: ({ doStream, doGenerate, params }) => {
      if (isToolChoiceActive(params)) {
        return toolChoiceStream({
          doGenerate,
          options: extractOnErrorOption(params.providerOptions),
        });
      }
      return wrapStreamHandler({
        protocol: resolvedProtocol,
        doStream,
        doGenerate,
        params,
      });
    },
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
