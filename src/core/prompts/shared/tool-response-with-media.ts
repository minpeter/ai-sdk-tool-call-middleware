import type { JSONValue, LanguageModelV4FilePart } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { toTextPart } from "./text-part";
import {
  getMediaMode,
  type ToolResponseMediaStrategy,
} from "./tool-result-media-strategy";
import {
  normalizeToolResultForUserContent,
  unwrapToolResult,
} from "./tool-result-normalizer";
import type {
  ToolResponsePromptTemplateResult,
  ToolResponseUserContentPart,
} from "./tool-result-user-content";

/**
 * Format a tool result for the next model turn.
 *
 * Default media strategy (`model`) projects tool `content` media into real
 * `file` parts while keeping protocol wrappers as adjacent text. Opt into
 * `placeholder` or `auto` via `mediaStrategy` for text-only or capability-gated
 * paths.
 */
export function formatToolResponseWithMedia(options: {
  toolResult: ToolResultPart;
  mediaStrategy?: ToolResponseMediaStrategy;
  wrapContent: (content: JSONValue) => string;
}): ToolResponsePromptTemplateResult {
  const { toolResult, mediaStrategy, wrapContent } = options;
  const mode = getMediaMode(mediaStrategy);

  if (toolResult.output.type === "content" && mode === "model") {
    const parts = normalizeToolResultForUserContent(
      toolResult.output,
      mediaStrategy
    );
    const fileParts = parts.filter(
      (part): part is LanguageModelV4FilePart => part.type === "file"
    );
    const textBody = parts
      .filter(
        (
          part
        ): part is Extract<ToolResponseUserContentPart, { type: "text" }> =>
          part.type === "text"
      )
      .map((part) => part.text)
      .filter((text) => text.length > 0)
      .join("\n");

    const wrapped = wrapContent(textBody);

    if (fileParts.length === 0) {
      return wrapped;
    }

    return [toTextPart(wrapped), ...fileParts];
  }

  const unwrapped = unwrapToolResult(toolResult.output, mediaStrategy);
  return wrapContent(unwrapped);
}
