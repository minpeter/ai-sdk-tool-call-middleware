import type {
  JSONValue,
  LanguageModelV3Content,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type {
  ToolApprovalResponse,
  ToolContent,
  ToolResultOutput,
  ToolResultPart,
} from "@ai-sdk/provider-utils";
import type { TCMCoreProtocol } from "../protocols/protocol-interface";

export interface AssistantToolCallTextConversionOptions {
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

export function assistantToolCallsToTextContent(options: {
  content: LanguageModelV3Content[];
  protocol: TCMCoreProtocol;
  conversionOptions?: AssistantToolCallTextConversionOptions;
}): LanguageModelV3Content[] {
  const newContent: LanguageModelV3Content[] = [];
  for (const item of options.content) {
    switch (item.type) {
      case "tool-call":
        newContent.push({
          type: "text",
          text: options.protocol.formatToolCall(item),
        });
        break;
      case "text":
      case "reasoning":
        newContent.push(item);
        break;
      default:
        options.conversionOptions?.onError?.(
          "tool-call-middleware: unknown assistant content; stringifying for provider compatibility",
          { content: item }
        );
        newContent.push({
          type: "text",
          text: JSON.stringify(item),
        });
    }
  }

  if (!newContent.every((entry) => entry.type === "text")) {
    return newContent;
  }

  return [
    {
      type: "text",
      text: newContent
        .map((entry) => (entry as { text: string }).text)
        .join("\n"),
    },
  ];
}

function formatApprovalResponse(part: ToolApprovalResponse): string {
  const status = part.approved ? "Approved" : "Denied";
  const reason = part.reason ? `: ${part.reason}` : "";
  return `[Tool Approval ${status}${reason}]`;
}

export function toolRoleContentToUserTextMessage(options: {
  toolContent: ToolContent;
  toolResponsePromptTemplate: (toolResult: ToolResultPart) => string;
}): LanguageModelV3Prompt[number] {
  const toolResultParts = options.toolContent.filter(
    (part): part is ToolResultPart => part.type === "tool-result"
  );
  const approvalResponseParts = options.toolContent.filter(
    (part): part is ToolApprovalResponse =>
      part.type === "tool-approval-response"
  );

  const resultTexts = toolResultParts.map((toolResult) => {
    return options.toolResponsePromptTemplate(toolResult);
  });
  const approvalTexts = approvalResponseParts.map(formatApprovalResponse);
  const allTexts = [...resultTexts, ...approvalTexts];

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: allTexts.join("\n"),
      },
    ],
  };
}

export type ToolResponseMediaType = "image" | "audio" | "video" | "file";

export interface ToolResponseMediaCapabilities {
  image?: boolean;
  audio?: boolean;
  video?: boolean;
  file?: boolean;
}

export type ToolResponseMediaMode = "placeholder" | "raw" | "auto";

export interface ToolResponseMediaStrategy {
  mode?: ToolResponseMediaMode;
  capabilities?: ToolResponseMediaCapabilities;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMediaKindFromMediaType(mediaType: string): ToolResponseMediaType {
  if (mediaType.startsWith("image/")) {
    return "image";
  }
  if (mediaType.startsWith("audio/")) {
    return "audio";
  }
  if (mediaType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function getContentPartMediaKind(part: unknown): ToolResponseMediaType | null {
  const contentPart = isMapping(part) ? part : undefined;
  const type = contentPart?.type;

  switch (type) {
    case "image-data":
    case "image-url":
    case "image-file-id":
      return "image";
    case "file-data":
    case "file-url":
    case "file-id": {
      const mediaType = contentPart?.mediaType;
      if (typeof mediaType === "string") {
        return getMediaKindFromMediaType(mediaType);
      }
      return "file";
    }
    case "media": {
      const mediaType = contentPart?.mediaType;
      if (typeof mediaType === "string") {
        return getMediaKindFromMediaType(mediaType);
      }
      return "file";
    }
    default:
      return null;
  }
}

function shouldPassRawByStrategy(
  mediaKind: ToolResponseMediaType,
  strategy?: ToolResponseMediaStrategy
): boolean {
  const mode = strategy?.mode ?? "placeholder";
  if (mode === "raw") {
    return true;
  }
  if (mode === "placeholder") {
    return false;
  }

  return strategy?.capabilities?.[mediaKind] === true;
}

function shouldPassRawContent(
  contentParts: unknown[],
  strategy?: ToolResponseMediaStrategy
): boolean {
  const mode = strategy?.mode ?? "placeholder";
  if (mode === "raw") {
    return true;
  }
  if (mode === "placeholder") {
    return false;
  }

  for (const part of contentParts) {
    const mediaKind = getContentPartMediaKind(part);
    if (!mediaKind) {
      continue;
    }
    if (!shouldPassRawByStrategy(mediaKind, strategy)) {
      return false;
    }
  }

  return true;
}

function formatContentPartPlaceholder(part: unknown): string {
  const contentPart = part as { type?: string };
  switch (contentPart.type) {
    case "text":
      return (contentPart as { text?: string }).text ?? "";
    case "image-data":
      return `[Image: ${(contentPart as { mediaType?: string }).mediaType}]`;
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
      return `[Media: ${(contentPart as { mediaType?: string }).mediaType}]`;
    case "custom":
      return "[Custom content]";
    default:
      return "[Unknown content]";
  }
}

export function unwrapToolResult(
  result: ToolResultOutput,
  mediaStrategy?: ToolResponseMediaStrategy
): JSONValue {
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
      const parts = result.value as unknown[];
      if (shouldPassRawContent(parts, mediaStrategy)) {
        return parts as JSONValue;
      }

      return parts.map(formatContentPartPlaceholder).join("\n");
    }
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
