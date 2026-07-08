import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { toolCallTextHasPrototypeSensitiveKey } from "./prototype-sensitive-keys";
import { decodeStructuredTextEscapes } from "./structured-text-escapes";

export interface SensitiveToolCallDropSpan {
  dropReason: "prototype-sensitive-tool-candidate";
  endIndex: number;
  startIndex: number;
}

interface JsonScanState {
  depth: number;
  escaping: boolean;
  inString: boolean;
}

const TOOL_CALL_OPEN_REGEX = /<tool_call\b[^>]*>/gi;
const TOOL_CALL_OPEN_AFTER_REGEX = /<tool_call\b[^>]*>/i;
const TOOL_CALL_CLOSE_REGEX = /<\/tool_call\s*>/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanJsonChar(state: JsonScanState, char: string): JsonScanState {
  if (state.inString) {
    if (state.escaping) {
      return { ...state, escaping: false };
    }
    if (char === "\\") {
      return { ...state, escaping: true };
    }
    if (char === '"') {
      return { ...state, inString: false };
    }
    return state;
  }
  if (char === '"') {
    return { ...state, inString: true };
  }
  if (char === "{") {
    return { ...state, depth: state.depth + 1 };
  }
  if (char === "}") {
    return { ...state, depth: Math.max(0, state.depth - 1) };
  }
  return state;
}

function findJsonObjectEnd(text: string, startIndex: number): number | null {
  let state: JsonScanState = { depth: 0, escaping: false, inString: false };
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    state = scanJsonChar(state, char);
    if (!state.inString && char === "}" && state.depth === 0) {
      return index + 1;
    }
  }
  return null;
}

function hasKnownJsonToolReference(text: string, toolNames: string[]): boolean {
  const normalizedText = decodeStructuredTextEscapes(text);
  return toolNames.some((toolName) => {
    const name = escapeRegExp(toolName);
    const quoted = new RegExp(
      `["'](?:name|tool|function)["']\\s*:\\s*["']${name}["']`,
      "i"
    );
    const relaxed = new RegExp(
      `(?:^|[{,]\\s*)(?:name|tool|function)\\s*:\\s*["']${name}["']`,
      "i"
    );
    return quoted.test(normalizedText) || relaxed.test(normalizedText);
  });
}

function isSensitiveKnownToolText(
  text: string,
  toolNames: string[],
  allowSingleToolArgs: boolean
): boolean {
  if (!toolCallTextHasPrototypeSensitiveKey(text)) {
    return false;
  }
  return (
    hasKnownJsonToolReference(text, toolNames) ||
    (allowSingleToolArgs && toolNames.length === 1)
  );
}

function findRegexIndex(text: string, regex: RegExp): number | null {
  const match = regex.exec(text);
  return match ? match.index : null;
}

function findIncompleteGenericToolCallEnd(
  text: string,
  bodyStart: number
): number | null {
  const body = text.slice(bodyStart);
  const closeIndex = findRegexIndex(body, TOOL_CALL_CLOSE_REGEX);
  const nextOpenIndex = findRegexIndex(body, TOOL_CALL_OPEN_AFTER_REGEX);
  if (
    closeIndex !== null &&
    (nextOpenIndex === null || closeIndex < nextOpenIndex)
  ) {
    return null;
  }
  return nextOpenIndex === null ? text.length : bodyStart + nextOpenIndex;
}

function findIncompleteNamedXmlEnd(
  text: string,
  tagName: string,
  bodyStart: number
): number | null {
  const body = text.slice(bodyStart);
  const escapedTag = escapeRegExp(tagName);
  const closeIndex = findRegexIndex(
    body,
    new RegExp(`</\\s*${escapedTag}\\s*>`, "i")
  );
  const nextOpenIndex = findRegexIndex(
    body,
    new RegExp(`<\\s*${escapedTag}(?=\\s|>|/)[^>]*>`, "i")
  );
  if (
    closeIndex !== null &&
    (nextOpenIndex === null || closeIndex < nextOpenIndex)
  ) {
    return null;
  }
  return nextOpenIndex === null ? text.length : bodyStart + nextOpenIndex;
}

function addDropSpan(
  spans: SensitiveToolCallDropSpan[],
  startIndex: number,
  endIndex: number
): void {
  if (startIndex < endIndex) {
    spans.push({
      startIndex,
      endIndex,
      dropReason: "prototype-sensitive-tool-candidate",
    });
  }
}

function collectGenericToolCallSpans(
  text: string,
  toolNames: string[]
): SensitiveToolCallDropSpan[] {
  const spans: SensitiveToolCallDropSpan[] = [];
  TOOL_CALL_OPEN_REGEX.lastIndex = 0;
  let match = TOOL_CALL_OPEN_REGEX.exec(text);
  while (match) {
    const startIndex = match.index;
    const bodyStart = startIndex + match[0].length;
    const endIndex = findIncompleteGenericToolCallEnd(text, bodyStart);
    if (endIndex !== null) {
      const candidate = text.slice(startIndex, endIndex);
      if (isSensitiveKnownToolText(candidate, toolNames, true)) {
        addDropSpan(spans, startIndex, endIndex);
      }
    }
    match = TOOL_CALL_OPEN_REGEX.exec(text);
  }
  return spans;
}

function collectNamedXmlToolSpans(
  text: string,
  toolNames: string[]
): SensitiveToolCallDropSpan[] {
  const spans: SensitiveToolCallDropSpan[] = [];
  for (const toolName of toolNames) {
    const openTag = new RegExp(
      `<\\s*${escapeRegExp(toolName)}(?=\\s|>|/)[^>]*>`,
      "gi"
    );
    let match = openTag.exec(text);
    while (match) {
      const startIndex = match.index;
      const bodyStart = startIndex + match[0].length;
      const endIndex = findIncompleteNamedXmlEnd(text, toolName, bodyStart);
      if (endIndex !== null) {
        const candidate = text.slice(startIndex, endIndex);
        if (toolCallTextHasPrototypeSensitiveKey(candidate)) {
          addDropSpan(spans, startIndex, endIndex);
        }
      }
      match = openTag.exec(text);
    }
  }
  return spans;
}

function collectUnbalancedJsonSpans(
  text: string,
  toolNames: string[]
): SensitiveToolCallDropSpan[] {
  const spans: SensitiveToolCallDropSpan[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") {
      continue;
    }
    if (findJsonObjectEnd(text, index) !== null) {
      continue;
    }
    const candidate = text.slice(index);
    if (isSensitiveKnownToolText(candidate, toolNames, false)) {
      addDropSpan(spans, index, text.length);
      break;
    }
  }
  return spans;
}

export function extractSensitiveIncompleteToolCallDropSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): SensitiveToolCallDropSpan[] {
  if (!toolCallTextHasPrototypeSensitiveKey(text)) {
    return [];
  }
  const toolNames = tools.map((tool) => tool.name).filter(Boolean);
  if (toolNames.length === 0) {
    return [];
  }
  return [
    ...collectGenericToolCallSpans(text, toolNames),
    ...collectNamedXmlToolSpans(text, toolNames),
    ...collectUnbalancedJsonSpans(text, toolNames),
  ];
}
