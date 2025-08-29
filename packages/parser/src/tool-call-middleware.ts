import type {
  LanguageModelV2CallOptions,
  LanguageModelV2Middleware,
} from "@ai-sdk/provider";

import { wrapGenerate as wrapGenerateHandler } from "./generate-handler";
import { ToolCallProtocol } from "./protocols/tool-call-protocol";
import {
  toolChoiceStream,
  wrapStream as wrapStreamHandler,
} from "./stream-handler";
import { transformParams } from "./transform-handler";
import { extractOnErrorOption, isToolChoiceActive } from "./utils";
import { isProtocolFactory } from "./utils/protocol";

export function createToolMiddleware({
  protocol,
  toolSystemPromptTemplate,
}: {
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: string) => string;
}): LanguageModelV2Middleware {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

  return {
    middlewareVersion: "v2",
    wrapStream: async ({ doStream, doGenerate, params }) => {
      if (isToolChoiceActive(params)) {
        return toolChoiceStream({
          doGenerate,
          options: extractOnErrorOption(params.providerOptions),
        });
      } else {
        return wrapStreamHandler({
          protocol: resolvedProtocol,
          doStream,
          doGenerate,
          params,
        });
      }
    },
    wrapGenerate: async ({ doGenerate, params }) =>
      wrapGenerateHandler({
        protocol: resolvedProtocol,
        doGenerate,
        params,
      }),
    transformParams: async ({
      params,
    }): Promise<LanguageModelV2CallOptions> => {
      return transformParams({
        protocol: resolvedProtocol,
        toolSystemPromptTemplate,
        params,
      });
    },
  };
}
