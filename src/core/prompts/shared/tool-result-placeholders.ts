import {
  getMediaKindFromMediaType,
  type ToolResponseMediaType,
} from "./tool-result-media-strategy";

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  url?: unknown;
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

export function formatContentPartPlaceholder(part: unknown): string {
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
      const { fileId } = contentPart as { fileId?: unknown };
      return formatIdPlaceholder("Image ID", fileId);
    }
    case "image-file-reference": {
      const { providerReference } = contentPart as {
        providerReference?: unknown;
      };
      return formatIdPlaceholder("Image ID", providerReference);
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
      const { fileId } = contentPart as { fileId?: unknown };
      return formatIdPlaceholder("File ID", fileId);
    }
    case "file-reference": {
      const { providerReference } = contentPart as {
        providerReference?: unknown;
      };
      return formatIdPlaceholder("File ID", providerReference);
    }
    case "media":
      return `[Media: ${(contentPart as { mediaType?: string }).mediaType}]`;
    case "custom":
      return "[Custom content]";
    default:
      return "[Unknown content]";
  }
}

const IMAGE_PART_TYPES = new Set([
  "image-data",
  "image-url",
  "image-file-id",
  "image-file-reference",
]);

const FILE_LIKE_PART_TYPES = new Set([
  "file",
  "file-data",
  "file-url",
  "file-id",
  "file-reference",
  "media",
]);

export function getContentPartMediaKind(
  part: unknown
): ToolResponseMediaType | null {
  const contentPart = isMapping(part) ? part : undefined;
  const type = contentPart?.type;
  if (typeof type !== "string") {
    return null;
  }

  if (IMAGE_PART_TYPES.has(type)) {
    return "image";
  }

  if (!FILE_LIKE_PART_TYPES.has(type)) {
    return null;
  }

  const mediaType = contentPart?.mediaType;
  if (typeof mediaType === "string") {
    return getMediaKindFromMediaType(mediaType);
  }
  return "file";
}
