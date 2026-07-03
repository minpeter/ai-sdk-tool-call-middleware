import type {
  JSONValue,
  LanguageModelV4FilePart,
  LanguageModelV4TextPart,
} from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { toTextPart } from "./text-part";

type ToolResponseMediaType = "image" | "audio" | "video" | "file";

interface ToolResponseMediaCapabilities {
  audio?: boolean;
  file?: boolean;
  image?: boolean;
  video?: boolean;
}

type ToolResponseMediaMode = "placeholder" | "raw" | "auto" | "model";

export interface ToolResponseMediaStrategy {
  capabilities?: ToolResponseMediaCapabilities;
  mode?: ToolResponseMediaMode;
}

export type ToolResponseUserContentPart =
  | LanguageModelV4TextPart
  | LanguageModelV4FilePart;

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
    case "file":
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

interface TaggedFileData {
  data?: unknown;
  reference?: unknown;
  text?: string;
  type?: string;
  url?: string;
}

/**
 * Placeholder for the canonical v4 `type: 'file'` content part whose `data`
 * is a tagged union (`data` / `url` / `reference` / `text`).
 */
function formatTaggedFilePartPlaceholder(contentPart: {
  data?: unknown;
  mediaType?: string;
  filename?: string;
}): string {
  const fileData = isMapping(contentPart.data)
    ? (contentPart.data as TaggedFileData)
    : undefined;
  const mediaType = contentPart.mediaType ?? "application/octet-stream";
  const isImage = mediaType.startsWith("image");

  switch (fileData?.type) {
    case "url":
      return isImage
        ? `[Image URL: ${fileData.url}]`
        : `[File URL: ${fileData.url}]`;
    case "reference":
      return formatIdPlaceholder(
        isImage ? "Image ID" : "File ID",
        fileData.reference
      );
    case "text":
      // Inline text documents are readable content; surface the text itself.
      return fileData.text ?? "";
    default: {
      if (isImage) {
        return `[Image: ${mediaType}]`;
      }
      if (contentPart.filename) {
        return `[File: ${contentPart.filename} (${mediaType})]`;
      }
      return `[File: ${mediaType}]`;
    }
  }
}

function formatContentPartPlaceholder(part: unknown): string {
  const contentPart = part as { type?: string };
  switch (contentPart.type) {
    case "text":
      return (contentPart as { text?: string }).text ?? "";
    case "file":
      return formatTaggedFilePartPlaceholder(
        contentPart as { data?: unknown; mediaType?: string; filename?: string }
      );
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
  providerOptions?: LanguageModelV4FilePart["providerOptions"];
}): LanguageModelV4FilePart {
  return {
    type: "file",
    data: { type: "data", data: options.data },
    mediaType: options.mediaType,
    ...(options.filename === undefined ? {} : { filename: options.filename }),
    ...(options.providerOptions === undefined
      ? {}
      : { providerOptions: options.providerOptions }),
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
    providerOptions?: LanguageModelV4TextPart["providerOptions"];
  };

  switch (contentPart.type) {
    case "text":
      return toTextPart(contentPart.text ?? "", contentPart.providerOptions);
    case "file":
      // Canonical v4 file part — already in LanguageModelV4FilePart shape
      // (tagged `data` union, mediaType, optional filename).
      return part as LanguageModelV4FilePart;
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
      providerOptions?: LanguageModelV4TextPart["providerOptions"];
    }
  ).providerOptions;

  return [toTextPart(stringifyJsonValue(unwrapped), providerOptions)];
}
