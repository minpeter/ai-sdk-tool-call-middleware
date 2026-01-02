import type { TCMCoreToolResult } from "../types";

/**
 * Common tool response to text conversion utilities
 * Used by all protocols to format tool responses consistently
 */

/**
 * Unwraps tool result if it has a { type: 'json', value: ... } wrapper
 * This is common across all protocols
 */
export function unwrapToolResult(result: unknown): unknown {
  if (
    result &&
    typeof result === "object" &&
    "type" in result &&
    result.type === "json" &&
    "value" in result
  ) {
    return result.value;
  }
  return result;
}

/**
 * Formats a tool response as JSON inside XML tags
 * Used by JSON protocol for tool response formatting
 */
export function formatToolResponseAsJsonInXml(
  toolResult: TCMCoreToolResult,
  toolResponseStart = "<tool_response>",
  toolResponseEnd = "</tool_response>"
): string {
  const unwrappedResult = unwrapToolResult(toolResult.result);
  return `${toolResponseStart}${JSON.stringify({
    toolName: toolResult.toolName,
    result: unwrappedResult,
  })}${toolResponseEnd}`;
}

/**
 * Formats a tool response as XML
 * Used by XML and YAML protocols for tool response formatting
 */
export function formatToolResponseAsXml(toolResult: TCMCoreToolResult): string {
  const unwrappedResult = unwrapToolResult(toolResult.result);

  // Simple XML formatting - could use a proper XML library if needed
  const escapeXml = (str: string): string => {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  };

  const toolNameXml = `<tool_name>${escapeXml(toolResult.toolName)}</tool_name>`;
  const resultXml = `<result>${typeof unwrappedResult === "string" ? escapeXml(unwrappedResult) : JSON.stringify(unwrappedResult)}</result>`;

  return `<tool_response>${toolNameXml}${resultXml}</tool_response>`;
}
