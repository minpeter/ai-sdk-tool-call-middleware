import { ToolCallProtocol } from "@/protocols/tool-call-protocol";

export function isProtocolFactory(
  protocol: ToolCallProtocol | (() => ToolCallProtocol)
): protocol is () => ToolCallProtocol {
  return typeof protocol === "function";
}
