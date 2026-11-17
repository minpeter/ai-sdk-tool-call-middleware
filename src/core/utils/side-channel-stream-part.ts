import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

type SideChannelStreamPart = Extract<
  LanguageModelV4StreamPart,
  { type: "raw" | "ping" }
>;

/**
 * Side-channel stream parts carry no generated content: `raw` mirrors the
 * provider wire chunk (`includeRawChunks`) and `ping` is a keep-alive
 * heartbeat. Providers interleave them anywhere, including between the text
 * deltas of one tool call, so stream parsers must forward them without
 * treating them as a content boundary. Flushing buffered text on one would
 * publish a half-received tool-call tag as plain text and lose the call.
 */
export function isSideChannelStreamPart(
  part: LanguageModelV4StreamPart
): part is SideChannelStreamPart {
  return part.type === "raw" || part.type === "ping";
}
