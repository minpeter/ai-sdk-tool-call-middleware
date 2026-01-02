import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Middleware,
} from "@ai-sdk/provider";
import {
  isProtocolFactory,
  type ToolCallProtocol,
} from "../core/protocols/tool-call-protocol";
import type { TCMToolDefinition } from "../core/types";
import { extractOnErrorOption } from "../core/utils/on-error";
import { isToolChoiceActive } from "../core/utils/provider-options";
import { wrapGenerate as wrapGenerateHandler } from "./generate-handler";
import {
  toolChoiceStream,
  wrapStream as wrapStreamHandler,
} from "./stream-handler";
import { transformParams } from "./transform-handler";

export function createToolMiddleware({
  protocol,
  toolSystemPromptTemplate,
  placement = "last",
}: {
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: TCMToolDefinition[]) => string;
  placement?: "first" | "last";
}): LanguageModelV3Middleware {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

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
        placement,
        params,
      }),
  };
}
