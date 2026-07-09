import type {
  LanguageModelV4FilePart,
  SharedV4FileData,
  SharedV4ProviderReference,
} from "@ai-sdk/provider";
import { toTextPart } from "./text-part";
import { formatContentPartPlaceholder } from "./tool-result-placeholders";
import type { ToolResponseUserContentPart } from "./tool-result-user-content";

interface ToolContentPartLike {
  data?: string;
  fileId?: unknown;
  filename?: string;
  mediaType?: string;
  providerOptions?: LanguageModelV4FilePart["providerOptions"];
  providerReference?: unknown;
  text?: string;
  type?: string;
  url?: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderReference(
  value: unknown
): value is SharedV4ProviderReference {
  if (!isMapping(value) || "type" in value) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(
    ([, entryValue]) => typeof entryValue === "string" && entryValue.length > 0
  );
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function toFilePart(options: {
  data: SharedV4FileData;
  mediaType: string;
  filename?: string;
  providerOptions?: LanguageModelV4FilePart["providerOptions"];
}): LanguageModelV4FilePart {
  return {
    type: "file",
    data: options.data,
    mediaType: options.mediaType,
    ...(options.filename === undefined ? {} : { filename: options.filename }),
    ...(options.providerOptions === undefined
      ? {}
      : { providerOptions: options.providerOptions }),
  };
}

function asPlaceholder(
  part: unknown,
  providerOptions?: LanguageModelV4FilePart["providerOptions"]
): ToolResponseUserContentPart {
  return toTextPart(formatContentPartPlaceholder(part), providerOptions);
}

function toUrlFilePart(
  part: unknown,
  url: string | undefined,
  mediaType: string,
  providerOptions?: LanguageModelV4FilePart["providerOptions"]
): ToolResponseUserContentPart {
  const parsed = parseUrl(url ?? "");
  if (!parsed) {
    return asPlaceholder(part, providerOptions);
  }
  return toFilePart({
    data: { type: "url", url: parsed },
    mediaType,
    providerOptions,
  });
}

function toReferenceFilePart(
  part: unknown,
  reference: unknown,
  mediaType: string,
  providerOptions?: LanguageModelV4FilePart["providerOptions"]
): ToolResponseUserContentPart {
  if (!isProviderReference(reference)) {
    return asPlaceholder(part, providerOptions);
  }
  return toFilePart({
    data: { type: "reference", reference },
    mediaType,
    providerOptions,
  });
}

function normalizeCanonicalFilePart(
  part: unknown,
  providerOptions?: LanguageModelV4FilePart["providerOptions"]
): ToolResponseUserContentPart {
  const filePart = part as LanguageModelV4FilePart;
  const data = filePart.data as SharedV4FileData | undefined;

  if (!data || typeof data !== "object" || !("type" in data)) {
    return asPlaceholder(part, providerOptions);
  }

  if (data.type !== "url") {
    return filePart;
  }

  const rawUrl = data.url as unknown;
  if (rawUrl instanceof URL) {
    return filePart;
  }
  if (typeof rawUrl !== "string") {
    return asPlaceholder(part, providerOptions);
  }

  const parsed = parseUrl(rawUrl);
  if (!parsed) {
    return asPlaceholder(part, providerOptions);
  }
  return {
    ...filePart,
    data: { type: "url", url: parsed },
  };
}

/**
 * Convert a tool-result content part into a model prompt part.
 *
 * Prefer AI SDK v4/v7 canonical `{ type: "file", data: SharedV4FileData }`.
 * Deprecated image/file aliases are upgraded when possible; otherwise they
 * fall back to a text placeholder.
 */
export function toModelContentPart(part: unknown): ToolResponseUserContentPart {
  const contentPart = part as ToolContentPartLike;
  const { providerOptions } = contentPart;

  switch (contentPart.type) {
    case "text":
      return toTextPart(contentPart.text ?? "", providerOptions);
    case "file":
      return normalizeCanonicalFilePart(part, providerOptions);
    case "image-data":
      return toFilePart({
        data: { type: "data", data: contentPart.data ?? "" },
        mediaType: contentPart.mediaType ?? "image",
        providerOptions,
      });
    case "image-url":
      return toUrlFilePart(part, contentPart.url, "image", providerOptions);
    case "file-data":
      return toFilePart({
        data: { type: "data", data: contentPart.data ?? "" },
        mediaType: contentPart.mediaType ?? "application/octet-stream",
        filename: contentPart.filename,
        providerOptions,
      });
    case "file-url":
      return toUrlFilePart(
        part,
        contentPart.url,
        contentPart.mediaType ?? "application/octet-stream",
        providerOptions
      );
    case "media":
      return toFilePart({
        data: { type: "data", data: contentPart.data ?? "" },
        mediaType: contentPart.mediaType ?? "application/octet-stream",
        providerOptions,
      });
    case "image-file-id":
      return toReferenceFilePart(
        part,
        contentPart.fileId,
        "image",
        providerOptions
      );
    case "file-id":
      return toReferenceFilePart(
        part,
        contentPart.fileId,
        contentPart.mediaType ?? "application/octet-stream",
        providerOptions
      );
    case "image-file-reference":
      return toReferenceFilePart(
        part,
        contentPart.providerReference,
        "image",
        providerOptions
      );
    case "file-reference":
      return toReferenceFilePart(
        part,
        contentPart.providerReference,
        contentPart.mediaType ?? "application/octet-stream",
        providerOptions
      );
    case "custom":
      return asPlaceholder(part, providerOptions);
    default:
      return asPlaceholder(part, providerOptions);
  }
}
