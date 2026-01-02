import {
  isProtocolFactory,
  type ToolCallProtocol,
} from "../core/protocols/tool-call-protocol";
import type { TCMToolDefinition } from "../core/types";
import { wrapGenerateV5 } from "./generate-handler";
import { wrapStreamV5 } from "./stream-handler";
import { transformParamsV5 } from "./transform-handler";

// biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 middleware interface requires dynamic types
type V5MiddlewareArgs = any;

// biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 middleware interface requires dynamic return type
type V5Middleware = any;

export function createToolMiddlewareV5({
  protocol,
  toolSystemPromptTemplate,
  placement = "last",
}: {
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: TCMToolDefinition[]) => string;
  placement?: "first" | "last";
}): V5Middleware {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

  return {
    middlewareVersion: "v2",
    wrapStream: (args: V5MiddlewareArgs) =>
      wrapStreamV5({
        protocol: resolvedProtocol,
        doStream: args.doStream,
        params: args.params,
      }),
    wrapGenerate: (args: V5MiddlewareArgs) =>
      wrapGenerateV5({
        protocol: resolvedProtocol,
        doGenerate: args.doGenerate,
        params: args.params,
      }),
    transformParams: (args: V5MiddlewareArgs) =>
      transformParamsV5({
        params: args.params,
        protocol: resolvedProtocol,
        toolSystemPromptTemplate,
        placement,
      }),
  };
}
