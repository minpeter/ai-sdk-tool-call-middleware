import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { extractToolNames } from "../utils/protocol-utils";
import { tryRepairXmlSelfClosingRootWithBody } from "../utils/xml-root-repair";
import { findPotentialLinePrefixedToolCallStart as findPotentialLinePrefixedToolCallStartImpl } from "./morph-xml-line-prefix-potential";
import {
  findLinePrefixedToolCalls,
  findStreamingLinePrefixedToolCall as findStreamingLinePrefixedToolCallImpl,
} from "./morph-xml-line-prefixed-tool-call-finder";
import { findPotentialToolTagStart as findPotentialToolTagStartImpl } from "./morph-xml-potential-tag-finder";
import { findToolCalls as findToolCallsImpl } from "./morph-xml-tool-tag-scanner";

export const findPotentialLinePrefixedToolCallStart =
  findPotentialLinePrefixedToolCallStartImpl;
export const findPotentialToolTagStart = findPotentialToolTagStartImpl;
export const findStreamingLinePrefixedToolCall =
  findStreamingLinePrefixedToolCallImpl;
export const findToolCalls = findToolCallsImpl;

export function findToolCallsWithFallbacks(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): { parseText: string; toolCalls: ReturnType<typeof findToolCalls> } {
  let parseText = text;
  const toolNames = extractToolNames(tools);
  let toolCalls = findToolCalls(parseText, toolNames);
  const linePrefixedCalls = findLinePrefixedToolCalls(parseText, tools);

  if (linePrefixedCalls.length > 0) {
    const candidates = [...toolCalls, ...linePrefixedCalls].sort(
      (left, right) =>
        left.startIndex - right.startIndex || right.endIndex - left.endIndex
    );
    toolCalls = [];
    for (const candidate of candidates) {
      if (
        toolCalls.every(
          (selected) =>
            candidate.endIndex <= selected.startIndex ||
            candidate.startIndex >= selected.endIndex
        )
      ) {
        toolCalls.push(candidate);
      }
    }
  }

  if (toolCalls.length === 0) {
    const repaired = tryRepairXmlSelfClosingRootWithBody(parseText, toolNames);
    if (repaired) {
      const repairedCalls = findToolCalls(repaired, toolNames);
      if (repairedCalls.length > 0) {
        parseText = repaired;
        toolCalls = repairedCalls;
      }
    }
  }

  return { parseText, toolCalls };
}
