import type {
  LanguageModelV4FilePart,
  SharedV4FileData,
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

/**
 * Pass through canonical tool-result content parts for model prompts.
 *
 * Only `text` and v4/v7 `{ type: "file", data: SharedV4FileData }` are kept as
 * structured parts. Anything else becomes a text placeholder.
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
  const filePart = part as LanguageModelV4FilePart;
  const data = filePart.data as SharedV4FileData | undefined;

  if (!data || typeof data !== "object" || !("type" in data)) {
    return asPlaceholder(part, providerOptions);
  }

  if (data.type !== "url") {
    return filePart;
  }

  // Accept string urls from JSON-deserialized payloads and normalize to URL.
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
