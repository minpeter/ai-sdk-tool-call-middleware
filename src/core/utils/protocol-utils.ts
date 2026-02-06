/**
 * Shared utilities for processing content in protocol implementations
 */

import type { LanguageModelV3Content } from "@ai-sdk/provider";

/**
 * Adds a text segment to the processed elements array if it's not empty after trimming.
 * This prevents adding whitespace-only text elements.
 *
 * @param text - The text to add
 * @param processedElements - The array to add the text element to
 */
export function addTextSegment(
  text: string,
  processedElements: LanguageModelV3Content[]
): void {
  if (text.trim()) {
    processedElements.push({ type: "text", text });
  }
}
