import {
  isProtocolFactory,
  type ToolCallProtocol,
} from "../core/protocols/tool-call-protocol";
import { wrapGenerateV5 } from "./generate-handler";
import { wrapStreamV5 } from "./stream-handler";
import { transformParamsV5 } from "./transform-handler";

export function createToolMiddlewareV5({
  protocol,
  toolSystemPromptTemplate,
  placement = "last",
}: {
  protocol: ToolCallProtocol | (() => ToolCallProtocol);
  toolSystemPromptTemplate: (tools: string) => string;
  placement?: "first" | "last";
}): any {
  const resolvedProtocol = isProtocolFactory(protocol) ? protocol() : protocol;

  return {
    middlewareVersion: "v2",
    wrapStream: (args: any) =>
      wrapStreamV5({
        protocol: resolvedProtocol,
        doStream: args.doStream,
        params: args.params,
      }),
    wrapGenerate: (args: any) =>
      wrapGenerateV5({
        protocol: resolvedProtocol,
        doGenerate: args.doGenerate,
        params: args.params,
      }),
    transformParams: (args: any) =>
      transformParamsV5({
        params: args.params,
        protocol: resolvedProtocol,
        toolSystemPromptTemplate,
        placement,
      }),
  };
}
