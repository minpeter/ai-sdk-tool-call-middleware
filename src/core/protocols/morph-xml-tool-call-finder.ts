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

interface ToolCallRange {
  readonly endIndex: number;
  readonly startIndex: number;
}

interface RootRepairOptions<Match extends ToolCallRange> {
  readonly findCalls: (text: string, toolNames: string[]) => Match[];
  readonly parseText: string;
  readonly toolCalls: Match[];
  readonly toolNames: string[];
}

export function findToolCallsWithRootRepair<Match extends ToolCallRange>(
  options: RootRepairOptions<Match>
): { readonly parseText: string; readonly toolCalls: Match[] } {
  const { findCalls, parseText, toolCalls, toolNames } = options;
  if (toolCalls.length > 0) {
    return { parseText, toolCalls };
  }
  const repaired = tryRepairXmlSelfClosingRootWithBody(parseText, toolNames);
  if (repaired === null) {
    return { parseText, toolCalls };
  }
  const repairedCalls = findCalls(repaired, toolNames);
  return repairedCalls.length > 0
    ? { parseText: repaired, toolCalls: repairedCalls }
    : { parseText, toolCalls };
}

export function findToolCallsWithFallbacks(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): { parseText: string; toolCalls: ReturnType<typeof findToolCalls> } {
  const parseText = text;
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

  return findToolCallsWithRootRepair({
    findCalls: findToolCalls,
    parseText,
    toolCalls,
    toolNames,
  });
}
