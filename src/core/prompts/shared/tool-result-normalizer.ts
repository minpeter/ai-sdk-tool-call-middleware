import type {
  JSONValue,
  LanguageModelV3FilePart,
  LanguageModelV3TextPart,
} from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { toTextPart } from "./text-part";

type ToolResponseMediaType = "image" | "audio" | "video" | "file";

export interface ToolResponseMediaCapabilities {
  audio?: boolean;
  file?: boolean;
  image?: boolean;
  video?: boolean;
}

export type ToolResponseMediaMode = "placeholder" | "raw" | "auto" | "model";

export interface ToolResponseMediaStrategy {
  capabilities?: ToolResponseMediaCapabilities;
  mode?: ToolResponseMediaMode;
}

export type ToolResponseUserContentPart =
  | LanguageModelV3TextPart
  | LanguageModelV3FilePart;

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
  const mode = getMediaMode(strategy);
  if (mode === "raw") {
    return true;
  }
  if (mode === "placeholder") {
    return false;
  }
  if (mode === "model") {
    return false;
  }

  return strategy?.capabilities?.[mediaKind] === true;
}

function getMediaMode(
  strategy?: ToolResponseMediaStrategy
): ToolResponseMediaMode {
  return strategy?.mode ?? "placeholder";
}

function shouldPassRawContent(
  contentParts: unknown[],
  strategy?: ToolResponseMediaStrategy
): boolean {
  const mode = getMediaMode(strategy);
  if (mode === "raw") {
    return true;
  }
  if (mode === "placeholder") {
    return false;
  }
  if (mode === "model") {
    return false;
  }

  let hasSupportedMediaContent = false;

  for (const part of contentParts) {
    const mediaKind = getContentPartMediaKind(part);
    if (!mediaKind) {
      continue;
    }
    hasSupportedMediaContent = true;
    if (!shouldPassRawByStrategy(mediaKind, strategy)) {
      return false;
    }
  }

  return hasSupportedMediaContent;
}

function formatIdPlaceholder(
  label: "Image ID" | "File ID",
  fileId: unknown
): string {
  const displayId =
    typeof fileId === "string" ? fileId : JSON.stringify(fileId);
  return `[${label}: ${displayId}]`;
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
      return formatIdPlaceholder("Image ID", fileId);
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
      return formatIdPlaceholder("File ID", fileId);
    }
    case "media":
      return `[Media: ${(contentPart as { mediaType?: string }).mediaType}]`;
    case "custom":
      return "[Custom content]";
    default:
      return "[Unknown content]";
  }
}

function toFilePart(options: {
  data: string;
  mediaType: string;
  filename?: string;
  providerOptions?: LanguageModelV3FilePart["providerOptions"];
}): LanguageModelV3FilePart {
  return {
    type: "file",
    data: options.data,
    mediaType: options.mediaType,
    ...(options.filename !== undefined ? { filename: options.filename } : {}),
    ...(options.providerOptions !== undefined
      ? { providerOptions: options.providerOptions }
      : {}),
  };
}

function toModelContentPart(part: unknown): ToolResponseUserContentPart {
  const contentPart = part as {
    type?: string;
    text?: string;
    data?: string;
    mediaType?: string;
    url?: string;
    filename?: string;
    providerOptions?: LanguageModelV3TextPart["providerOptions"];
  };

  switch (contentPart.type) {
    case "text":
      return toTextPart(contentPart.text ?? "", contentPart.providerOptions);
    case "image-data":
      return toFilePart({
        data: contentPart.data ?? "",
        mediaType: contentPart.mediaType ?? "image/*",
        providerOptions: contentPart.providerOptions,
      });
    case "image-url":
      return toFilePart({
        data: contentPart.url ?? "",
        mediaType: "image/*",
        providerOptions: contentPart.providerOptions,
      });
    case "file-data":
      return toFilePart({
        data: contentPart.data ?? "",
        mediaType: contentPart.mediaType ?? "application/octet-stream",
        filename: contentPart.filename,
        providerOptions: contentPart.providerOptions,
      });
    case "file-url":
      return toFilePart({
        data: contentPart.url ?? "",
        mediaType: "application/octet-stream",
        providerOptions: contentPart.providerOptions,
      });
    case "media":
      return toFilePart({
        data: contentPart.data ?? "",
        mediaType: contentPart.mediaType ?? "application/octet-stream",
        providerOptions: contentPart.providerOptions,
      });
    case "image-file-id":
    case "file-id":
    case "custom":
      return toTextPart(
        formatContentPartPlaceholder(part),
        contentPart.providerOptions
      );
    default:
      return toTextPart(
        formatContentPartPlaceholder(part),
        contentPart.providerOptions
      );
  }
}

function stringifyJsonValue(value: JSONValue): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
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

export function normalizeToolResultForUserContent(
  result: ToolResultOutput,
  mediaStrategy?: ToolResponseMediaStrategy
): ToolResponseUserContentPart[] {
  if (result.type === "content" && mediaStrategy?.mode === "model") {
    return (result.value as unknown[]).map(toModelContentPart);
  }

  const unwrapped = unwrapToolResult(result, mediaStrategy);
  const providerOptions = (
    result as {
      providerOptions?: LanguageModelV3TextPart["providerOptions"];
    }
  ).providerOptions;

  return [toTextPart(stringifyJsonValue(unwrapped), providerOptions)];
}
