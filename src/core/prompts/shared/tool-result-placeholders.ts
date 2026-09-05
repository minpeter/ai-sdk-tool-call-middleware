import type { SharedV4ProviderReference } from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import {
  getMediaKindFromMediaType,
  type ToolResponseMediaType,
} from "./tool-result-media-strategy";

type ToolResultContentPart = Extract<
  ToolResultOutput,
  { type: "content" }
>["value"][number];
type CanonicalFilePart = Extract<ToolResultContentPart, { type: "file" }>;
interface LegacyMediaPart {
  readonly mediaType: string;
  readonly type: "media";
}
type PlaceholderContentPart = ToolResultContentPart | LegacyMediaPart;

function formatIdPlaceholder(
  label: "Image ID" | "File ID",
  fileId: string | SharedV4ProviderReference
): string {
  const displayId =
    typeof fileId === "string" ? fileId : JSON.stringify(fileId);
  return `[${label}: ${displayId}]`;
}

/**
 * Placeholder for the canonical v4 `type: 'file'` content part whose `data`
 * is a tagged union (`data` / `url` / `reference` / `text`).
 */
function formatTaggedFilePartPlaceholder(
  contentPart: CanonicalFilePart
): string {
  const fileData = contentPart.data;
  const mediaType =
    typeof contentPart.mediaType === "string"
      ? contentPart.mediaType
      : "application/octet-stream";
  const isImage = getMediaKindFromMediaType(mediaType) === "image";

  switch (fileData?.type) {
    case "url":
      return isImage
        ? `[Image URL: ${String(fileData.url)}]`
        : `[File URL: ${String(fileData.url)}]`;
    case "reference":
      return formatIdPlaceholder(
        isImage ? "Image ID" : "File ID",
        fileData.reference
      );
    case "text":
      // Inline text documents are readable content; surface the text itself.
      return typeof fileData.text === "string" ? fileData.text : "";
    default: {
      if (isImage) {
        return `[Image: ${mediaType}]`;
      }
      if (typeof contentPart.filename === "string" && contentPart.filename) {
        return `[File: ${contentPart.filename} (${mediaType})]`;
      }
      return `[File: ${mediaType}]`;
    }
  }
}

export function formatContentPartPlaceholder(
  part: PlaceholderContentPart
): string {
  switch (part.type) {
    case "text":
      return typeof part.text === "string" ? part.text : "";
    case "file":
      return formatTaggedFilePartPlaceholder(part);
    case "image-data":
      return `[Image: ${String(part.mediaType)}]`;
    case "image-url":
      return `[Image URL: ${String(part.url)}]`;
    case "image-file-id":
      return formatIdPlaceholder("Image ID", part.fileId);
    case "image-file-reference":
      return formatIdPlaceholder("Image ID", part.providerReference);
    case "file-data":
      if (typeof part.filename === "string" && part.filename) {
        return `[File: ${part.filename} (${String(part.mediaType)})]`;
      }
      return `[File: ${String(part.mediaType)}]`;
    case "file-url":
      return `[File URL: ${String(part.url)}]`;
    case "file-id":
      return formatIdPlaceholder("File ID", part.fileId);
    case "file-reference":
      return formatIdPlaceholder("File ID", part.providerReference);
    case "media":
      return `[Media: ${String(part.mediaType)}]`;
    case "custom":
      return "[Custom content]";
    default:
      return "[Unknown content]";
  }
}

const IMAGE_PART_TYPES = new Set<PlaceholderContentPart["type"]>([
  "image-data",
  "image-url",
  "image-file-id",
  "image-file-reference",
]);

const FILE_LIKE_PART_TYPES = new Set<PlaceholderContentPart["type"]>([
  "file",
  "file-data",
  "file-url",
  "file-id",
  "file-reference",
  "media",
]);

export function getContentPartMediaKind(
  part: PlaceholderContentPart
): ToolResponseMediaType | null {
  if (IMAGE_PART_TYPES.has(part.type)) {
    return "image";
  }

  if (!FILE_LIKE_PART_TYPES.has(part.type)) {
    return null;
  }

  return "mediaType" in part && typeof part.mediaType === "string"
    ? getMediaKindFromMediaType(part.mediaType)
    : "file";
}
