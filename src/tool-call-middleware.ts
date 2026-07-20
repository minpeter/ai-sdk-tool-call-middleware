import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import type { ToolResponsePromptTemplateResult } from "./core/prompts/shared/tool-role-to-user-message";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import { isTCMProtocolFactory } from "./core/protocols/protocol-interface";
import { wrapGenerate as wrapGenerateHandler } from "./generate-handler";
import { wrapStream as wrapStreamHandler } from "./stream-handler";
import {
  type ToolCallHistoryMode,
  type ToolSystemPromptPlacement,
  transformParams,
} from "./transform-handler";

export function createToolMiddleware({
  protocol,
  toolSystemPromptTemplate,
  toolResponsePromptTemplate,
  placement = "last",
  historyMode = "converted-text",
  suppressToolSystemPromptForForcedChoice = false,
}: {
  protocol: TCMCoreProtocol | (() => TCMCoreProtocol);
  toolSystemPromptTemplate: (tools: LanguageModelV4FunctionTool[]) => string;
  toolResponsePromptTemplate?: (
    toolResult: ToolResultPart
  ) => ToolResponsePromptTemplateResult;
  placement?: ToolSystemPromptPlacement;
  historyMode?: ToolCallHistoryMode;
  /**
   * Omit the protocol-specific tool catalog when `toolChoice` is `required` or
   * selects a fixed tool. The forced-choice handlers request JSON through
   * `responseFormat`, so protocols that instruct a different output grammar
   * can opt out of issuing contradictory system instructions.
   */
  suppressToolSystemPromptForForcedChoice?: boolean;
}): LanguageModelV4Middleware {
  const resolvedProtocol = isTCMProtocolFactory(protocol)
    ? protocol()
    : protocol;

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
