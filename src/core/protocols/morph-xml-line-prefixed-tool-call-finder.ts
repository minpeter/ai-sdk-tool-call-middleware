import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { extractToolNames } from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
import { collectSchemaSelectionPropertyNames } from "../utils/tool-call-schema-property-names";
import { findNextToolTag } from "../utils/xml-tool-tag-scanner";
import type { LinePrefixedToolCall } from "./morph-xml-stream-state-machine";
import { nextTagToken } from "./morph-xml-tag-tokenizer";
import { consumeWhitespace } from "./morph-xml-whitespace";

function getToolSchema(
  tools: LanguageModelV4FunctionTool[],
  toolName: string
): LanguageModelV4FunctionTool["inputSchema"] | undefined {
  return tools.find((tool) => tool.name === toolName)?.inputSchema;
}

interface TokenHandlerResult {
  depth: number;
  lastCompleteEnd: number;
  shouldBreak: boolean;
}

function handleSpecialToken(depth: number): TokenHandlerResult {
  return { depth, lastCompleteEnd: -1, shouldBreak: false };
}

function handleOpenToken(
  token: { selfClosing: boolean; nextPos: number },
  depth: number,
  lastCompleteEnd: number
): TokenHandlerResult {
  if (token.selfClosing) {
    return {
      depth,
      lastCompleteEnd: depth === 0 ? token.nextPos : lastCompleteEnd,
      shouldBreak: false,
    };
  }
  return { depth: depth + 1, lastCompleteEnd, shouldBreak: false };
}

function handleCloseToken(
  token: { nextPos: number },
  depth: number
): TokenHandlerResult {
  if (depth <= 0) {
    return { depth, lastCompleteEnd: -1, shouldBreak: true };
  }
  const newDepth = depth - 1;
  return {
    depth: newDepth,
    lastCompleteEnd: newDepth === 0 ? token.nextPos : -1,
    shouldBreak: false,
  };
}

function findLinePrefixedXmlBodyEnd(
  text: string,
  bodyStartIndex: number,
  toolNames: string[],
  propertyNames: Set<string>
): number {
  let cursor = bodyStartIndex;
  let depth = 0;
  let lastCompleteEnd = -1;

  while (cursor < text.length) {
    if (depth === 0) {
      cursor = consumeWhitespace(text, cursor);
      if (cursor >= text.length || text.charAt(cursor) !== "<") {
        break;
      }
    }

    const token = nextTagToken(text, cursor);
    if (token.kind === "eof") {
      break;
    }
    if (
      depth === 0 &&
      lastCompleteEnd !== -1 &&
      token.kind === "open" &&
      toolNames.includes(token.name) &&
      !propertyNames.has(token.name)
    ) {
      break;
    }

    let result: TokenHandlerResult;
    if (token.kind === "special") {
      result = handleSpecialToken(depth);
    } else if (token.kind === "open") {
      result = handleOpenToken(token, depth, lastCompleteEnd);
    } else {
      result = handleCloseToken(token, depth);
    }

    ({ depth } = result);
    if (result.lastCompleteEnd !== -1) {
      ({ lastCompleteEnd } = result);
    }
    if (result.shouldBreak) {
      break;
    }
    cursor = token.nextPos;
  }

  return lastCompleteEnd;
}

function resolveLinePrefixedCallBoundary(options: {
  contentEnd: number;
  propertyNames: Set<string>;
  text: string;
  toolName: string;
  toolNames: string[];
}): { boundaryConfirmed: boolean; endIndex: number } {
  const afterWhitespace = consumeWhitespace(options.text, options.contentEnd);
  const closeTagPattern = new RegExp(
    `^</\\s*${escapeRegExp(options.toolName)}\\s*>`
  );
  const closeMatch = closeTagPattern.exec(options.text.slice(afterWhitespace));
  if (closeMatch) {
    return {
      boundaryConfirmed: true,
      endIndex: afterWhitespace + closeMatch[0].length,
    };
  }
  const nextIsKnownToolCall = options.toolNames.some((toolName) => {
    if (options.propertyNames.has(toolName)) {
      return false;
    }
    const next = findNextToolTag(options.text, afterWhitespace, toolName);
    return next?.tagStart === afterWhitespace;
  });
  return {
    boundaryConfirmed:
      nextIsKnownToolCall ||
      (afterWhitespace < options.text.length &&
        options.text.charAt(afterWhitespace) !== "<"),
    endIndex: options.contentEnd,
  };
}

function findLinePrefixedToolCall(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  searchFrom = 0
):
  | (LinePrefixedToolCall & { boundaryConfirmed: boolean; segment: string })
  | null {
  let best:
    | (LinePrefixedToolCall & {
        boundaryConfirmed: boolean;
        segment: string;
      })
    | null = null;
  const toolNames = extractToolNames(tools);

  for (const toolName of toolNames) {
    const linePattern = new RegExp(
      `(^|\\n)[\\t ]*${escapeRegExp(toolName)}[\\t ]*:?[\\t ]*(?:\\r?\\n|$)`,
      "g"
    );
    linePattern.lastIndex = searchFrom;

    let match = linePattern.exec(text);
    while (match !== null) {
      const prefix = match[1] ?? "";
      const startIndex = match.index + prefix.length;
      const contentStart = consumeWhitespace(text, linePattern.lastIndex);
      if (contentStart >= text.length || text.charAt(contentStart) !== "<") {
        match = linePattern.exec(text);
        continue;
      }
      const propertyNames = collectSchemaSelectionPropertyNames(
        getToolSchema(tools, toolName)
      );
      const contentEnd = findLinePrefixedXmlBodyEnd(
        text,
        contentStart,
        toolNames,
        propertyNames
      );
      if (contentEnd === -1 || contentEnd <= contentStart) {
        match = linePattern.exec(text);
        continue;
      }
      const content = text.slice(contentStart, contentEnd);
      const { boundaryConfirmed, endIndex } = resolveLinePrefixedCallBoundary({
        contentEnd,
        propertyNames,
        text,
        toolName,
        toolNames,
      });

      const candidate = {
        toolName,
        startIndex,
        endIndex,
        content,
        boundaryConfirmed,
        segment: text.slice(startIndex, endIndex),
      };
      if (best === null || candidate.startIndex < best.startIndex) {
        best = candidate;
      }
      break;
    }
  }

  return best;
}

export function findLinePrefixedToolCalls(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): Array<LinePrefixedToolCall & { segment: string }> {
  const calls: Array<LinePrefixedToolCall & { segment: string }> = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const call = findLinePrefixedToolCall(text, tools, searchFrom);
    if (!call) {
      break;
    }
    calls.push(call);
    searchFrom = call.endIndex;
  }

  return calls;
}

export function findStreamingLinePrefixedToolCall(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  allowAtBufferEnd: boolean
): LinePrefixedToolCall | null {
  const candidate = findLinePrefixedToolCall(text, tools);
  if (!candidate) {
    return null;
  }
  return candidate.boundaryConfirmed || allowAtBufferEnd ? candidate : null;
}
