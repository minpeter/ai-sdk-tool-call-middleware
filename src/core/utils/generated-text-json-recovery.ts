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
    return { ...state, depth: state.depth - 1 };
  }
  return state;
}

function extractBalancedCandidateAt(
  text: string,
  start: number,
  maxCandidateLength: number
): JsonCandidate | null {
  let state: JsonScanState = {
    depth: 0,
    inString: false,
    escaping: false,
  };

  for (let end = start; end < text.length; end += 1) {
    const char = text[end];
    state = scanJsonChar(state, char);

    if (state.depth === 0) {
      const endIndex = end + 1;
      const candidate = text.slice(start, endIndex);
      if (
        candidate.length > 1 &&
        candidate.length <= maxCandidateLength &&
        candidate.startsWith("{") &&
        candidate.endsWith("}")
      ) {
        return {
          text: candidate,
          startIndex: start,
          endIndex,
        };
      }
      return null;
    }
    if (end - start + 1 > maxCandidateLength) {
      return null;
    }
  }
  return null;
}

function extractBalancedJsonObjects(text: string): JsonCandidate[] {
  const maxCandidateLength = 10_000;
  const candidates = new Map<string, JsonCandidate>();

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") {
      continue;
    }
    const candidate = extractBalancedCandidateAt(
      text,
      start,
      maxCandidateLength
    );
    if (candidate) {
      candidates.set(
        `${candidate.startIndex}:${candidate.endIndex}`,
        candidate
      );
    }
  }

  return [...candidates.values()];
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
  const taggedMatches = extractTaggedToolCallCandidates(rawText);

  const codeBlocks = extractCodeBlockCandidates(rawText);
  const balancedObjects = extractBalancedJsonObjects(rawText);

  return [...taggedMatches, ...codeBlocks, ...balancedObjects];
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
