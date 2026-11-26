import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider";
import {
  isProtocolFactory,
  type TCMProtocol,
} from "./core/protocols/protocol-interface";
import { stripToolCallMiddlewareProviderOptions } from "./core/utils/transport/provider-options";
import { wrapGenerate as wrapGenerateHandler } from "./generate-handler";
import { wrapStream as wrapStreamHandler } from "./stream-handler";
import {
  type ToolHistoryStrategy,
  type ToolPromptStrategy,
  transformParams,
} from "./transform-handler";

export function createToolMiddleware({
  protocol,
  promptStrategy,
  historyStrategy = { mode: "converted-text" },
}: {
  protocol: TCMProtocol | (() => TCMProtocol);
  promptStrategy: ToolPromptStrategy;
  historyStrategy?: ToolHistoryStrategy;
}): LanguageModelV4Middleware {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

  return {
    specificationVersion: "v4",
    wrapStream: ({ doStream, doGenerate, params, model }) => {
      const providerParams = stripToolCallMiddlewareProviderOptions(params);
      // Only invoke `model` directly when stripping actually removed
      // `toolCallMiddleware` so callers passing an instrumented thunk without
      // middleware options are not bypassed. When stripping does occur,
      // `model.doStream`/`model.doGenerate` receives the sanitized params
      // directly (bypassing custom wrapper thunks; under `wrapLanguageModel`,
      // `model` already wraps any inner middlewares).
      const didStrip = providerParams !== params;
      return wrapStreamHandler({
        protocol: resolvedProtocol,
        doStream:
          didStrip && typeof model?.doStream === "function"
            ? () => model.doStream(providerParams)
            : doStream,
        doGenerate:
          didStrip && typeof model?.doGenerate === "function"
            ? () => model.doGenerate(providerParams)
            : doGenerate,
        params,
      });
    },
    wrapGenerate: ({ doGenerate, params, model }) => {
      const providerParams = stripToolCallMiddlewareProviderOptions(params);
      const didStrip = providerParams !== params;
      return wrapGenerateHandler({
        protocol: resolvedProtocol,
        doGenerate:
          didStrip && typeof model?.doGenerate === "function"
            ? () => model.doGenerate(providerParams)
            : doGenerate,
        params,
      });
    },
    transformParams: async ({ params }): Promise<LanguageModelV4CallOptions> =>
      transformParams({
        protocol: resolvedProtocol,
        promptStrategy,
        historyStrategy,
        params,
      }),
  };
}
