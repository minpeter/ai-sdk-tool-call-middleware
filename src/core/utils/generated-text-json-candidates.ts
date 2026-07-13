import { parse as parseRJSON } from "../../rjson";
import { toolCallInputHasPrototypeSensitiveKey } from "./prototype-sensitive-keys";

export interface JsonCandidate {
  endIndex: number;
  startIndex: number;
  text: string;
}

interface JsonScanState {
  depth: number;
  escaping: boolean;
  inString: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function containsPrototypeSensitiveKey(value: unknown): boolean {
  return toolCallInputHasPrototypeSensitiveKey(value);
}

export function parseJsonCandidate(candidateText: string): unknown {
  try {
    return parseRJSON(candidateText);
  } catch {
    // swallow parse failures and return undefined
  }
}

function extractCodeBlockCandidates(text: string): JsonCandidate[] {
  const codeBlockRegex = /```(?:json|yaml|xml)?\s*([\s\S]*?)```/gi;
  const candidates: JsonCandidate[] = [];
  let match: RegExpExecArray | null;
  while (true) {
    match = codeBlockRegex.exec(text);
    if (!match) {
      break;
    }
    const body = match[1]?.trim();
    if (body) {
      const startIndex = match.index ?? 0;
      const endIndex = startIndex + match[0].length;
      candidates.push({
        text: body,
        startIndex,
        endIndex,
      });
    }
  }
  return candidates;
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

function extractBalancedJsonObjects(text: string): JsonCandidate[] {
  const maxCandidateLength = 10_000;
  const candidates: JsonCandidate[] = [];
  let state: JsonScanState = { depth: 0, inString: false, escaping: false };
  let currentStart: number | null = null;
  let ignoreCurrent = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!state.inString && char === "{" && state.depth === 0) {
      currentStart = index;
      ignoreCurrent = false;
    }

    state = scanJsonChar(state, char);

    if (
      currentStart !== null &&
      !ignoreCurrent &&
      index - currentStart + 1 > maxCandidateLength
    ) {
      ignoreCurrent = true;
    }

    if (!state.inString && char === "}" && state.depth === 0) {
      if (currentStart !== null && !ignoreCurrent) {
        const endIndex = index + 1;
        const candidate = text.slice(currentStart, endIndex);
        if (candidate.length > 1) {
          candidates.push({
            text: candidate,
            startIndex: currentStart,
            endIndex,
          });
        }
      }
      currentStart = null;
      ignoreCurrent = false;
    }
  }

  return candidates;
}

function extractTaggedToolCallCandidates(rawText: string): JsonCandidate[] {
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  const candidates: JsonCandidate[] = [];
  let match: RegExpExecArray | null;
  while (true) {
    match = toolCallRegex.exec(rawText);
    if (!match) {
      break;
    }
    const body = match[1]?.trim();
    if (!body) {
      continue;
    }
    const startIndex = match.index ?? 0;
    const endIndex = startIndex + match[0].length;
    candidates.push({
      text: body,
      startIndex,
      endIndex,
    });
  }
  return candidates;
}

export function extractJsonLikeCandidates(rawText: string): JsonCandidate[] {
  return mergeJsonCandidatesByStart(
    extractTaggedToolCallCandidates(rawText),
    extractCodeBlockCandidates(rawText),
    extractBalancedJsonObjects(rawText)
  );
}

function mergeJsonCandidatesByStart(
  tagged: JsonCandidate[],
  codeBlocks: JsonCandidate[],
  balanced: JsonCandidate[]
): JsonCandidate[] {
  return [...tagged, ...codeBlocks, ...balanced].sort((a, b) =>
    a.startIndex === b.startIndex
      ? b.endIndex - a.endIndex
      : a.startIndex - b.startIndex
  );
}
