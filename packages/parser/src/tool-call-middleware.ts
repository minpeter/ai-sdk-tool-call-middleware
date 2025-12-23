import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Middleware,
} from "@ai-sdk/provider";

import { wrapGenerate as wrapGenerateHandler } from "./generate-handler";
import {
  isProtocolFactory,
  type ToolCallProtocol,
} from "./protocols/tool-call-protocol";
import {
  toolChoiceStream,
  wrapStream as wrapStreamHandler,
} from "./stream-handler";
import { transformParams } from "./transform-handler";
import { extractOnErrorOption } from "./utils/on-error";
import { isToolChoiceActive } from "./utils/provider-options";

export function createToolMiddleware({
  protocol,
  toolSystemPromptTemplate,
  placement = "last",
}: {
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: string) => string;
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
