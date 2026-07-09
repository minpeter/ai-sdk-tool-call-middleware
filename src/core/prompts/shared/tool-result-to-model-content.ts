import type {
  LanguageModelV4FilePart,
  SharedV4FileData,
  SharedV4ProviderReference,
} from "@ai-sdk/provider";
import { toTextPart } from "./text-part";
import { formatContentPartPlaceholder } from "./tool-result-placeholders";
import type { ToolResponseUserContentPart } from "./tool-result-user-content";

function asPlaceholder(
  part: unknown,
  providerOptions?: LanguageModelV4FilePart["providerOptions"]
): ToolResponseUserContentPart {
  return toTextPart(formatContentPartPlaceholder(part), providerOptions);
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isInlineFileData(value: unknown): value is string | Uint8Array {
  return typeof value === "string" || value instanceof Uint8Array;
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
  return entries.every(([, entryValue]) => typeof entryValue === "string");
}

function toValidatedFilePart(options: {
  data: SharedV4FileData;
  mediaType: string;
  filename?: unknown;
  providerOptions?: LanguageModelV4FilePart["providerOptions"];
}): LanguageModelV4FilePart {
  return {
    type: "file",
    data: options.data,
    mediaType: options.mediaType,
    ...(typeof options.filename === "string"
      ? { filename: options.filename }
      : {}),
    ...(options.providerOptions === undefined
      ? {}
      : { providerOptions: options.providerOptions }),
  };
}

/**
 * Pass through canonical tool-result content parts for model prompts.
 *
 * Only `text` and valid v4/v7 `{ type: "file", data: SharedV4FileData }` parts
 * are kept as structured content. Anything else becomes a text placeholder.
 */
export function toModelContentPart(part: unknown): ToolResponseUserContentPart {
  const contentPart = part as {
    type?: string;
    text?: string;
    providerOptions?: LanguageModelV4FilePart["providerOptions"];
  };

  if (contentPart.type === "text") {
    return toTextPart(contentPart.text ?? "", contentPart.providerOptions);
  }

  if (contentPart.type === "file") {
    return normalizeCanonicalFilePart(part, contentPart.providerOptions);
  }

  return asPlaceholder(part, contentPart.providerOptions);
}

function normalizeCanonicalFilePart(
  part: unknown,
  providerOptions?: LanguageModelV4FilePart["providerOptions"]
): ToolResponseUserContentPart {
  const { mediaType, filename, data } = part as {
    mediaType?: unknown;
    filename?: unknown;
    data?: unknown;
  };

  if (!isNonEmptyString(mediaType)) {
    return asPlaceholder(part, providerOptions);
  }

  if (!(isMapping(data) && "type" in data)) {
    return asPlaceholder(part, providerOptions);
  }

  switch (data.type) {
    case "data": {
      const { data: payload } = data;
      if (!isInlineFileData(payload)) {
        return asPlaceholder(part, providerOptions);
      }
      return toValidatedFilePart({
        data: { type: "data", data: payload },
        mediaType,
        filename,
        providerOptions,
      });
    }
    case "url": {
      const { url: rawUrl } = data;
      if (rawUrl instanceof URL) {
        return toValidatedFilePart({
          data: { type: "url", url: rawUrl },
          mediaType,
          filename,
          providerOptions,
        });
      }
      if (typeof rawUrl !== "string") {
        return asPlaceholder(part, providerOptions);
      }
      const parsed = parseUrl(rawUrl);
      if (!parsed) {
        return asPlaceholder(part, providerOptions);
      }
      return toValidatedFilePart({
        data: { type: "url", url: parsed },
        mediaType,
        filename,
        providerOptions,
      });
    }
    case "reference": {
      const { reference } = data;
      if (!isProviderReference(reference)) {
        return asPlaceholder(part, providerOptions);
      }
      return toValidatedFilePart({
        data: { type: "reference", reference },
        mediaType,
        filename,
        providerOptions,
      });
    }
    case "text": {
      const { text } = data;
      if (typeof text !== "string") {
        return asPlaceholder(part, providerOptions);
      }
      return toValidatedFilePart({
        data: { type: "text", text },
        mediaType,
        filename,
        providerOptions,
      });
    }
    default:
      return asPlaceholder(part, providerOptions);
  }
}
