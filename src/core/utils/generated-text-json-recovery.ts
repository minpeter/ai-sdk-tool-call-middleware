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

function extractCodeBlockCandidates(text: string): string[] {
  const codeBlockRegex = /```(?:json|yaml|xml)?\s*([\s\S]*?)```/gi;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while (true) {
    match = codeBlockRegex.exec(text);
    if (!match) {
      break;
    }
    const body = match[1]?.trim();
    if (body) {
      candidates.push(body);
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
): string | null {
  let state: JsonScanState = {
    depth: 0,
    inString: false,
    escaping: false,
  };

  for (let end = start; end < text.length; end += 1) {
    const char = text[end];
    state = scanJsonChar(state, char);

    if (state.depth === 0) {
      const candidate = text.slice(start, end + 1).trim();
      if (
        candidate.length > 1 &&
        candidate.length <= maxCandidateLength &&
        candidate.startsWith("{") &&
        candidate.endsWith("}")
      ) {
        return candidate;
      }
      return null;
    }
    if (end - start + 1 > maxCandidateLength) {
      return null;
    }
  }
  return null;
}

function extractBalancedJsonObjects(text: string): string[] {
  const maxCandidateLength = 10_000;
  const candidates = new Set<string>();

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
      candidates.add(candidate);
    }
  }

  return [...candidates];
}

function extractJsonLikeCandidates(rawText: string): string[] {
  const taggedMatches = [
    ...rawText.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi),
  ]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item));

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
  for (const candidateText of jsonCandidates) {
    const parsed = parseJsonCandidate(candidateText);
    if (parsed === undefined) {
      continue;
    }

    const toolPayload = parseAsToolPayload(parsed, tools);
    if (toolPayload) {
      return [toToolCallPart(toolPayload)];
    }

    const argsPayload = parseAsArgumentsOnly(parsed, tools);
    if (argsPayload) {
      return [toToolCallPart(argsPayload)];
    }
  }

  return null;
}
