import type {
  LanguageModelV4FilePart,
  SharedV4FileData,
  SharedV4ProviderReference,
} from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { toTextPart } from "./text-part";
import { formatContentPartPlaceholder } from "./tool-result-placeholders";
import type { ToolResponseUserContentPart } from "./tool-result-user-content";

type ToolResultContentPart = Extract<
  ToolResultOutput,
  { type: "content" }
>["value"][number];
type CanonicalFilePart = Extract<ToolResultContentPart, { type: "file" }>;

/** Only network-fetchable schemes are forwarded as model file URL parts. */
const ALLOWED_FILE_URL_PROTOCOLS = new Set(["http:", "https:"]);

function asPlaceholder(
  part: ToolResultContentPart,
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

/**
 * Normalize and validate a file-part URL for model forwarding.
 *
 * Accepts either a `URL` instance or a string (JSON-deserialized tool results
 * often lose the `URL` class). Only `http:` / `https:` with a non-empty host
 * are allowed; everything else degrades to a placeholder.
 */
function toSafeFileUrl(rawUrl: URL | string): URL | null {
  let url: URL | null = null;
  if (rawUrl instanceof URL) {
    url = rawUrl;
  } else if (typeof rawUrl === "string") {
    url = parseUrl(rawUrl);
  }

  if (!url) {
    return null;
  }
  if (!ALLOWED_FILE_URL_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  if (url.hostname.length === 0) {
    return null;
  }
  return url;
}

function isProviderReference(
  value: SharedV4ProviderReference
): value is SharedV4ProviderReference {
  if (typeof value !== "object" || value === null || "type" in value) {
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
  filename?: CanonicalFilePart["filename"];
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
export function toModelContentPart(
  part: ToolResultContentPart
): ToolResponseUserContentPart {
  switch (part.type) {
    case "text":
      return toTextPart(
        typeof part.text === "string" ? part.text : "",
        part.providerOptions
      );
    case "file":
      return normalizeCanonicalFilePart(part, part.providerOptions);
    default:
      return asPlaceholder(part, part.providerOptions);
  }
}

function normalizeCanonicalFilePart(
  part: CanonicalFilePart,
  providerOptions?: LanguageModelV4FilePart["providerOptions"]
): ToolResponseUserContentPart {
  const { mediaType, filename, data } = part;

  if (typeof mediaType !== "string" || mediaType.length === 0) {
    return asPlaceholder(part, providerOptions);
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !("type" in data) ||
    typeof data.type !== "string"
  ) {
    return asPlaceholder(part, providerOptions);
  }

  switch (data.type) {
    case "data": {
      const { data: payload } = data;
      if (typeof payload !== "string" && !(payload instanceof Uint8Array)) {
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
      const safeUrl = toSafeFileUrl(data.url);
      if (!safeUrl) {
        return asPlaceholder(part, providerOptions);
      }
      return toValidatedFilePart({
        data: { type: "url", url: safeUrl },
        mediaType,
        filename,
        providerOptions,
      });
    }
    case "reference": {
      if (!isProviderReference(data.reference)) {
        return asPlaceholder(part, providerOptions);
      }
      return toValidatedFilePart({
        data: { type: "reference", reference: data.reference },
        mediaType,
        filename,
        providerOptions,
      });
    }
    case "text": {
      if (typeof data.text !== "string") {
        return asPlaceholder(part, providerOptions);
      }
      return toValidatedFilePart({
        data: { type: "text", text: data.text },
        mediaType,
        filename,
        providerOptions,
      });
    }
    default:
      return asPlaceholder(part, providerOptions);
  }
}
