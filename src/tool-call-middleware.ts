import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import { isProtocolFactory } from "./core/protocols/protocol-interface";
import { wrapGenerate as wrapGenerateHandler } from "./generate-handler";
import { wrapStream as wrapStreamHandler } from "./stream-handler";
import {
  type ToolCallTransformSettings,
  transformParams,
} from "./transform-handler";

export function createToolMiddleware({
  protocol,
  toolSystemPromptTemplate,
  toolResponsePromptTemplate,
  placement = "last",
  historyMode = "converted-text",
  suppressToolSystemPromptForForcedChoice = false,
}: ToolCallTransformSettings): LanguageModelV4Middleware {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

  return {
    specificationVersion: "v4",
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
    transformParams: async ({ params }): Promise<LanguageModelV4CallOptions> =>
      transformParams({
        protocol: resolvedProtocol,
        toolSystemPromptTemplate,
        toolResponsePromptTemplate,
        placement,
        historyMode,
        suppressToolSystemPromptForForcedChoice,
        params,
      }),
  };
}
