import type { JSONValue, LanguageModelV4TextPart } from "@ai-sdk/provider";
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

function shouldPassRawContent(
  contentParts: unknown[],
  strategy?: ToolResponseMediaStrategy
): boolean {
  if (getMediaMode(strategy) !== "auto") {
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
      const parts = result.value as unknown[];
      if (shouldPassRawContent(parts, mediaStrategy)) {
        return parts as JSONValue;
      }

      // model mode is handled by normalizeToolResultForUserContent; string
      // serializers always degrade media to placeholders here.
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
  if (result.type === "content" && getMediaMode(mediaStrategy) === "model") {
    return (result.value as unknown[]).map(toModelContentPart);
  }

  const unwrapped = unwrapToolResult(result, mediaStrategy);
  const { providerOptions } = result as {
    providerOptions?: LanguageModelV4TextPart["providerOptions"];
  };

  return [toTextPart(stringifyJsonValue(unwrapped), providerOptions)];
}
