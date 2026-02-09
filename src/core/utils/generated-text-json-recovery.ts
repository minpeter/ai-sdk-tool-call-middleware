import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
} from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import { generateId } from "./id";

interface ToolCallCandidate {
  toolName: string;
  input: string;
}

interface JsonCandidate {
  text: string;
  startIndex: number;
  endIndex: number;
}

interface JsonScanState {
  depth: number;
  inString: boolean;
  escaping: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseJsonCandidate(candidateText: string): unknown {
  try {
    return parseRJSON(candidateText);
  } catch {
    return undefined;
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

    if (!state.inString && char === "{") {
      if (state.depth === 0) {
        currentStart = index;
        ignoreCurrent = false;
      }
    }

    state = scanJsonChar(state, char);

    if (currentStart !== null && !ignoreCurrent) {
      if (index - currentStart + 1 > maxCandidateLength) {
        ignoreCurrent = true;
      }
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

function extractJsonLikeCandidates(rawText: string): JsonCandidate[] {
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
  const merged: JsonCandidate[] = [];
  let taggedIndex = 0;
  let codeIndex = 0;
  let balancedIndex = 0;

  while (
    taggedIndex < tagged.length ||
    codeIndex < codeBlocks.length ||
    balancedIndex < balanced.length
  ) {
    const taggedCandidate =
      taggedIndex < tagged.length ? tagged[taggedIndex] : null;
    const codeCandidate =
      codeIndex < codeBlocks.length ? codeBlocks[codeIndex] : null;
    const balancedCandidate =
      balancedIndex < balanced.length ? balanced[balancedIndex] : null;

    let nextCandidate = taggedCandidate;
    if (
      codeCandidate &&
      (!nextCandidate ||
        codeCandidate.startIndex < nextCandidate.startIndex ||
        (codeCandidate.startIndex === nextCandidate.startIndex &&
          codeCandidate.endIndex < nextCandidate.endIndex))
    ) {
      nextCandidate = codeCandidate;
    }
    if (
      balancedCandidate &&
      (!nextCandidate ||
        balancedCandidate.startIndex < nextCandidate.startIndex ||
        (balancedCandidate.startIndex === nextCandidate.startIndex &&
          balancedCandidate.endIndex < nextCandidate.endIndex))
    ) {
      nextCandidate = balancedCandidate;
    }

    if (nextCandidate === taggedCandidate) {
      taggedIndex += 1;
    } else if (nextCandidate === codeCandidate) {
      codeIndex += 1;
    } else if (nextCandidate === balancedCandidate) {
      balancedIndex += 1;
    }

    if (nextCandidate) {
      merged.push(nextCandidate);
    }
  }

  return merged;
}

function toToolCallPart(candidate: ToolCallCandidate): LanguageModelV3Content {
  return {
    type: "tool-call",
    toolCallId: generateId(),
    toolName: candidate.toolName,
    input: candidate.input,
  };
}

function toRecoveredParts(
  text: string,
  candidate: JsonCandidate,
  toolCallPart: LanguageModelV3Content
): LanguageModelV3Content[] {
  const out: LanguageModelV3Content[] = [];
  const prefix = text.slice(0, candidate.startIndex);
  if (prefix.length > 0) {
    out.push({ type: "text", text: prefix });
  }

  out.push(toolCallPart);

  const suffix = text.slice(candidate.endIndex);
  if (suffix.length > 0) {
    out.push({ type: "text", text: suffix });
  }
  return out;
}

function parseAsToolPayload(
  payload: unknown,
  tools: LanguageModelV3FunctionTool[]
): ToolCallCandidate | null {
  if (!isRecord(payload)) {
    return null;
  }

  const toolName =
    typeof payload.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim()
      : null;
  if (!toolName) {
    return null;
  }

  if (!tools.some((tool) => tool.name === toolName)) {
    return null;
  }

  const rawArgs = Object.hasOwn(payload, "arguments") ? payload.arguments : {};
  if (!isRecord(rawArgs)) {
    return null;
  }

  return {
    toolName,
    input: safeStringify(rawArgs),
  };
}

function isLikelyArgumentsShapeForTool(
  args: Record<string, unknown>,
  tool: LanguageModelV3FunctionTool
): boolean {
  const unwrapped = unwrapJsonSchema(tool.inputSchema);
  if (!isRecord(unwrapped)) {
    return false;
  }
  if (getSchemaType(unwrapped) !== "object") {
    return false;
  }

  const properties = unwrapped.properties;
  if (!isRecord(properties)) {
    return false;
  }

  const keys = Object.keys(args);
  if (keys.length === 0) {
    return false;
  }

  const knownKeys = keys.filter((key) => Object.hasOwn(properties, key));
  if (knownKeys.length === 0) {
    return false;
  }

  if (
    unwrapped.additionalProperties === false &&
    knownKeys.length !== keys.length
  ) {
    return false;
  }

  return true;
}

function parseAsArgumentsOnly(
  payload: unknown,
  tools: LanguageModelV3FunctionTool[]
): ToolCallCandidate | null {
  if (tools.length !== 1) {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }
  if (Object.hasOwn(payload, "name") || Object.hasOwn(payload, "arguments")) {
    return null;
  }

  const tool = tools[0];
  if (!isLikelyArgumentsShapeForTool(payload, tool)) {
    return null;
  }

  return {
    toolName: tool.name,
    input: safeStringify(payload),
  };
}

export function recoverToolCallFromJsonCandidates(
  text: string,
  tools: LanguageModelV3FunctionTool[]
): LanguageModelV3Content[] | null {
  if (tools.length === 0) {
    return null;
  }

  const jsonCandidates = extractJsonLikeCandidates(text);
  for (const jsonCandidate of jsonCandidates) {
    const parsed = parseJsonCandidate(jsonCandidate.text);
    if (parsed === undefined) {
      continue;
    }

    const toolPayload = parseAsToolPayload(parsed, tools);
    if (toolPayload) {
      return toRecoveredParts(text, jsonCandidate, toToolCallPart(toolPayload));
    }

    const argsPayload = parseAsArgumentsOnly(parsed, tools);
    if (argsPayload) {
      return toRecoveredParts(text, jsonCandidate, toToolCallPart(argsPayload));
    }
  }

  return null;
}
