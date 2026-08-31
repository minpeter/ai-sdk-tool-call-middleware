import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import {
  consumeMarkdownCodeText,
  createMarkdownCodeContext,
  markdownCodeContextSuppressesToolCall,
} from "../utils/markdown-code-context";
import { parseGlm5AnchoredBareToolCall } from "./glm5-bare-tool-call";
import {
  type Glm5CallSnapshot,
  hasExplicitlyClosedGlm5TaggedBody,
  parseGlm5CallBody,
  type ResolvedGlm5ProtocolOptions,
} from "./glm5-call-parsing";

export interface Glm5TagMatch {
  end: number;
  raw: string;
  start: number;
}

export interface ClosedGlm5CallSelection {
  close: Glm5TagMatch;
  parsed: Glm5CallSnapshot | null;
  rejected: boolean;
}

const TOOL_CALL_OPEN_RE = /<\s*tool_call\s*>/gi;
const TOOL_CALL_CLOSE_RE = /<\s*\/\s*tool_call\s*>/gi;
const STRUCTURAL_RECOVERY_CODES = new Set([
  "recovered-missing-arg-key-close",
  "recovered-missing-arg-value-close",
]);
const MAX_GLM5_TOOL_CALL_CLOSE_CANDIDATES = 256;

function findTag(
  text: string,
  from: number,
  pattern: RegExp
): Glm5TagMatch | null {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }
  const start = match.index;
  return {
    end: start + match[0].length,
    raw: match[0],
    start,
  };
}

export function findGlm5ToolCallOpen(
  text: string,
  from: number
): Glm5TagMatch | null {
  return findTag(text, from, TOOL_CALL_OPEN_RE);
}

function hasStructuralRecovery(call: Glm5CallSnapshot): boolean {
  return call.recoveries.some((code) => STRUCTURAL_RECOVERY_CODES.has(code));
}

export function selectClosedGlm5Call(options: {
  open: Glm5TagMatch;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): ClosedGlm5CallSelection | null {
  const nestedOpen = findGlm5ToolCallOpen(options.text, options.open.end);
  let cursor = options.open.end;
  let candidateCount = 0;
  let first: {
    close: Glm5TagMatch;
    parsed: Glm5CallSnapshot | null;
  } | null = null;
  let last: {
    close: Glm5TagMatch;
    parsed: Glm5CallSnapshot | null;
  } | null = null;
  let recoverable: {
    close: Glm5TagMatch;
    parsed: Glm5CallSnapshot;
  } | null = null;

  while (cursor < options.text.length) {
    const close = findTag(options.text, cursor, TOOL_CALL_CLOSE_RE);
    if (!close) {
      break;
    }
    candidateCount += 1;
    if (candidateCount > MAX_GLM5_TOOL_CALL_CLOSE_CANDIDATES) {
      return { close, parsed: null, rejected: true };
    }
    const body = options.text.slice(options.open.end, close.start);
    const parsed = parseGlm5CallBody({
      body,
      complete: true,
      protocolOptions: options.protocolOptions,
      tools: options.tools,
    });
    first ??= { close, parsed };
    last = { close, parsed };
    if (!parsed && hasExplicitlyClosedGlm5TaggedBody(body)) {
      return { close, parsed: null, rejected: false };
    }
    if (parsed && !hasStructuralRecovery(parsed)) {
      return { close, parsed, rejected: false };
    }
    if (parsed && !recoverable) {
      recoverable = { close, parsed };
    }
    cursor = close.end;
  }

  if (nestedOpen && last) {
    return { close: last.close, parsed: null, rejected: true };
  }
  if (recoverable) {
    return { ...recoverable, rejected: false };
  }
  return first ? { ...first, rejected: false } : null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Extraction mirrors parser recovery, Markdown non-execution, and resynchronization branches explicitly.
export function extractGlm5ToolCallSegments(options: {
  protocolOptions: ResolvedGlm5ProtocolOptions;
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): string[] {
  const segments: string[] = [];
  const markdownContext = createMarkdownCodeContext();
  let cursor = 0;
  while (cursor < options.text.length) {
    const open = findGlm5ToolCallOpen(options.text, cursor);
    if (!open) {
      break;
    }
    consumeMarkdownCodeText(
      markdownContext,
      options.text.slice(cursor, open.start)
    );
    const insideMarkdownCode =
      markdownCodeContextSuppressesToolCall(markdownContext);
    const selected = selectClosedGlm5Call({
      open,
      protocolOptions: options.protocolOptions,
      text: options.text,
      tools: options.tools,
    });
    if (insideMarkdownCode) {
      const rawEnd = selected?.close.end ?? options.text.length;
      consumeMarkdownCodeText(
        markdownContext,
        options.text.slice(open.start, rawEnd)
      );
      cursor = rawEnd;
      continue;
    }
    if (selected?.rejected) {
      break;
    }
    if (!selected) {
      const nestedOpen = findGlm5ToolCallOpen(options.text, open.end);
      if (options.protocolOptions.recoverIncompleteToolCalls && !nestedOpen) {
        const raw = options.text.slice(open.start);
        const parsed = parseGlm5CallBody({
          body: options.text.slice(open.end),
          complete: true,
          protocolOptions: options.protocolOptions,
          tools: options.tools,
        });
        if (parsed) {
          segments.push(raw);
        }
      }
      break;
    }
    if (selected.parsed) {
      segments.push(options.text.slice(open.start, selected.close.end));
    }
    cursor = selected.close.end;
  }
  if (segments.length > 0) {
    return segments;
  }
  return parseGlm5AnchoredBareToolCall({
    text: options.text,
    tools: options.tools,
  })
    ? [options.text.trim()]
    : [];
}
