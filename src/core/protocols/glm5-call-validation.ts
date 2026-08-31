import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import type { ResolvedGlm5ProtocolOptions } from "./glm5-call-types";
import { resolveGlm5ToolName } from "./glm5-name-resolution";

const NESTED_TOOL_CALL_OPEN_RE = /<\s*tool_call\s*>/gi;
const NESTED_TOOL_CALL_CLOSE_RE = /<\s*\/\s*tool_call\s*>/gi;
const NESTED_TOOL_NAME_BOUNDARY_RE = /[\r\n]|<\s*arg_key\s*>/i;

export function hasNestedDeclaredGlm5ToolCall(options: {
  body: string;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}): boolean {
  let cursor = 0;
  NESTED_TOOL_CALL_OPEN_RE.lastIndex = 0;
  NESTED_TOOL_CALL_CLOSE_RE.lastIndex = 0;
  while (cursor < options.body.length) {
    NESTED_TOOL_CALL_OPEN_RE.lastIndex = cursor;
    const open = NESTED_TOOL_CALL_OPEN_RE.exec(options.body);
    if (!open) {
      break;
    }
    const openEnd = open.index + open[0].length;
    NESTED_TOOL_CALL_CLOSE_RE.lastIndex = openEnd;
    const close = NESTED_TOOL_CALL_CLOSE_RE.exec(options.body);
    if (!close) {
      break;
    }
    const innerBody = options.body.slice(openEnd, close.index);
    const boundary = innerBody.search(NESTED_TOOL_NAME_BOUNDARY_RE);
    const rawName = innerBody
      .slice(0, boundary < 0 ? innerBody.length : boundary)
      .trim();
    if (
      rawName &&
      resolveGlm5ToolName(rawName, options.tools, options.protocolOptions)
    ) {
      NESTED_TOOL_CALL_OPEN_RE.lastIndex = 0;
      NESTED_TOOL_CALL_CLOSE_RE.lastIndex = 0;
      return true;
    }
    cursor = close.index + close[0].length;
  }
  NESTED_TOOL_CALL_OPEN_RE.lastIndex = 0;
  NESTED_TOOL_CALL_CLOSE_RE.lastIndex = 0;
  return false;
}
