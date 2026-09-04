import { isJSONValue, type JSONValue } from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { toTextPart } from "./text-part";
import {
  getMediaMode,
  shouldPassRawByStrategy,
  type ToolResponseMediaStrategy,
} from "./tool-result-media-strategy";
import {
  formatContentPartPlaceholder,
  getContentPartMediaKind,
} from "./tool-result-placeholders";
import { toModelContentPart } from "./tool-result-to-model-content";
import type { ToolResponseUserContentPart } from "./tool-result-user-content";

export type {
  ToolResponseMediaCapabilities,
  ToolResponseMediaMode,
  ToolResponseMediaStrategy,
  ToolResponseMediaType,
} from "./tool-result-media-strategy";
export type { ToolResponseUserContentPart } from "./tool-result-user-content";

type ToolResultContentPart = Extract<
  ToolResultOutput,
  { type: "content" }
>["value"][number];

interface LegacyMediaPart {
  readonly mediaType: string;
  readonly type: "media";
}

type PlaceholderContentPart = ToolResultContentPart | LegacyMediaPart;

function hasContentType(value: object): value is { readonly type: string } {
  return typeof value === "object" && value !== null && "type" in value;
}

function isToolResultContentPart(
  value: object
): value is ToolResultContentPart {
  if (!hasContentType(value)) {
    return false;
  }
  switch (value.type) {
    case "text":
    case "file":
    case "file-data":
    case "file-url":
    case "file-id":
    case "file-reference":
    case "image-data":
    case "image-url":
    case "image-file-id":
    case "image-file-reference":
    case "custom":
      return true;
    default:
      return false;
  }
}

function isPlaceholderContentPart(
  value: object
): value is PlaceholderContentPart {
  return (
    isToolResultContentPart(value) ||
    (hasContentType(value) &&
      value.type === "media" &&
      "mediaType" in value &&
      typeof value.mediaType === "string")
  );
}

function shouldPassRawContent(
  contentParts: readonly object[],
  strategy?: ToolResponseMediaStrategy
): boolean {
  if (
    getMediaMode(strategy) !== "auto" ||
    !contentParts.every(isPlaceholderContentPart)
  ) {
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
      const { reason } = result;
      return reason ? `[Execution Denied: ${reason}]` : "[Execution Denied]";
    }
    case "error-text":
      return `[Error: ${result.value ?? ""}]`;
    case "error-json":
      return `[Error: ${JSON.stringify(result.value)}]`;
    case "content": {
      const parts = result.value;
      if (shouldPassRawContent(parts, mediaStrategy) && isJSONValue(parts)) {
        return parts;
      }

      // model mode is handled by normalizeToolResultForUserContent; string
      // serializers always degrade media to placeholders here.
      if (parts.every(isPlaceholderContentPart)) {
        return parts.map(formatContentPartPlaceholder).join("\n");
      }
      return parts
        .map((part) =>
          isPlaceholderContentPart(part)
            ? formatContentPartPlaceholder(part)
            : "[Unknown content]"
        )
        .join("\n");
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
  if (result.type === "content" && getMediaMode(mediaStrategy) === "model") {
    const parts: readonly object[] = result.value;
    if (parts.every(isToolResultContentPart)) {
      return parts.map(toModelContentPart);
    }
    return parts.map((part) =>
      isToolResultContentPart(part)
        ? toModelContentPart(part)
        : toTextPart("[Unknown content]")
    );
  }

  const unwrapped = unwrapToolResult(result, mediaStrategy);
  const providerOptions =
    "providerOptions" in result ? result.providerOptions : undefined;
  return [toTextPart(stringifyJsonValue(unwrapped), providerOptions)];
}
