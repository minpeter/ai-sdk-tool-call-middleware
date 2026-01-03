import type { JSONValue } from "@ai-sdk/provider";
import type { ToolResultOutput, ToolResultPart } from "@ai-sdk/provider-utils";

/**
 * Common tool response to text conversion utilities
 * Used by all protocols to format tool responses consistently
 */

/**
 * Unwraps tool result output into a display-friendly value.
 * Supports ToolResultOutput types and preserves raw values for compatibility.
 */
export function unwrapToolResult(result: ToolResultOutput): JSONValue {
  switch (result.type) {
    case "text":
      return result.value ?? "";
    case "json":
      return result.value;
    case "execution-denied": {
      const reason = result.reason;
      return reason ? `[Execution Denied: ${reason}]` : "[Execution Denied]";
    }
    case "error-text":
      return `[Error: ${result.value ?? ""}]`;
    case "error-json":
      return `[Error: ${JSON.stringify(result.value)}]`;
    case "content": {
      return result.value
        .map((part) => {
          const contentPart = part as { type?: string };
          switch (contentPart.type) {
            case "text":
              return (contentPart as { text?: string }).text ?? "";
            case "image-data":
              return `[Image: ${
                (contentPart as { mediaType?: string }).mediaType
              }]`;
            case "image-url":
              return `[Image URL: ${(contentPart as { url?: string }).url}]`;
            case "image-file-id": {
              const fileId = (contentPart as { fileId?: unknown }).fileId;
              const displayId =
                typeof fileId === "string" ? fileId : JSON.stringify(fileId);
              return `[Image ID: ${displayId}]`;
            }
            case "file-data": {
              const filePart = contentPart as {
                filename?: string;
                mediaType?: string;
              };
              if (filePart.filename) {
                return `[File: ${filePart.filename} (${filePart.mediaType})]`;
              }
              return `[File: ${filePart.mediaType}]`;
            }
            case "file-url":
              return `[File URL: ${(contentPart as { url?: string }).url}]`;
            case "file-id": {
              const fileId = (contentPart as { fileId?: unknown }).fileId;
              const displayId =
                typeof fileId === "string" ? fileId : JSON.stringify(fileId);
              return `[File ID: ${displayId}]`;
            }
            case "media":
              return `[Media: ${
                (contentPart as { mediaType?: string }).mediaType
              }]`;
            case "custom":
              return "[Custom content]";
            default:
              return "[Unknown content]";
          }
        })
        .join("\n");
    }
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

/**
 * Formats a tool response as JSON inside XML tags
 * Used by JSON protocol for tool response formatting
 */
export function formatToolResponseAsJsonInXml(
  toolResult: ToolResultPart
): string {
  const unwrappedResult = unwrapToolResult(toolResult.output);
  return `<tool_response>${JSON.stringify({
    toolName: toolResult.toolName,
    result: unwrappedResult,
  })}</tool_response>`;
}

/**
 * Formats a tool response as XML
 * Used by XML and YAML protocols for tool response formatting
 */
export function formatToolResponseAsXml(toolResult: ToolResultPart): string {
  const unwrappedResult = unwrapToolResult(toolResult.output);

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
  const resultXml = `<result>${escapeXml(typeof unwrappedResult === "string" ? unwrappedResult : JSON.stringify(unwrappedResult))}</result>`;

  return `<tool_response>${toolNameXml}${resultXml}</tool_response>`;
}
