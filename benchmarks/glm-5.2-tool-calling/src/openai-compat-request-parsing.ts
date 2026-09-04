import { createHash } from "node:crypto";
import {
  jsonSchema,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
} from "ai";

export type OpenAICompatBridgeArm = "glm5" | "native";

export interface FunctionMapping {
  readonly description?: string;
  readonly original: string;
  readonly parameters: Record<string, unknown>;
  readonly safe: string;
}

export interface ParsedOpenAIRequest {
  readonly arm: OpenAICompatBridgeArm;
  readonly historyParserErrors: string[];
  readonly instructions?: string;
  readonly maxOutputTokens: number;
  readonly messages: ModelMessage[];
  readonly requestedModel: string;
  readonly stopSequences?: string[];
  readonly temperature?: number;
  readonly toolChoice?: ToolChoice<ToolSet>;
  readonly toolMappings: FunctionMapping[];
  readonly tools?: ToolSet;
  readonly topP?: number;
}

export class OpenAICompatInputError extends Error {
  readonly status: number;

  constructor(message: string, options?: ErrorOptions & { status?: number }) {
    super(message, options);
    this.name = "OpenAICompatInputError";
    this.status = options?.status ?? 400;
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MALFORMED_HISTORY_ARGUMENTS_KEY = "__bridge_malformed_tool_arguments__";
const MISSING_HISTORY_TOOL_RESULT_KEY = "__bridge_missing_tool_result__";
const MAX_MESSAGES = 1024;
const MAX_TOOLS = 1024;
const MAX_TOOL_NAME_LENGTH = 64;
const SAFE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAPPED_TOOL_DIGEST_SUFFIX = /_([0-9a-f]{12})(?:_\d+)?$/u;
const UNSAFE_TOOL_NAME_CHARACTER = /[^A-Za-z0-9_-]/gu;
const UNSAFE_TOOL_NAME_PREFIX = /^[^A-Za-z_]+/u;
const REPEATED_UNDERSCORE = /_+/gu;

type AssistantContent = Array<
  | { readonly text: string; readonly type: "text" }
  | {
      readonly input: Record<string, unknown>;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly type: "tool-call";
    }
>;

interface HistoryState {
  readonly callNames: Map<string, string>;
  readonly instructions: string[];
  readonly messages: ModelMessage[];
  readonly parserErrors: string[];
  readonly pendingToolCalls: Map<string, string>;
  readonly safeByOriginal: Map<string, string>;
  readonly usedSafeNames: Set<string>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 4_000_000
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OpenAICompatInputError(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new OpenAICompatInputError(`${field} is too long`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OpenAICompatInputError(`${field} must be a finite number`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number | undefined {
  const number = finiteNumber(value, field);
  if (number === undefined) {
    return;
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new OpenAICompatInputError(`${field} must be a positive integer`);
  }
  return number;
}

function messageText(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (!Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const parts: string[] = [];
  for (const [index, part] of value.entries()) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) {
      throw new OpenAICompatInputError(`${field}[${index}] is unsupported`);
    }
    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
      continue;
    }
    throw new OpenAICompatInputError(
      `${field}[${index}].type is unsupported by this text benchmark bridge`
    );
  }
  return parts.join("\n");
}

function safeToolStem(original: string): string {
  const normalized = original
    .normalize("NFKD")
    .replace(UNSAFE_TOOL_NAME_CHARACTER, "_")
    .replace(UNSAFE_TOOL_NAME_PREFIX, "")
    .replace(REPEATED_UNDERSCORE, "_");
  return normalized || "tool";
}

function mappedToolName(original: string, used: ReadonlySet<string>): string {
  if (SAFE_TOOL_NAME.test(original) && !used.has(original)) {
    return original;
  }
  const digest = createHash("sha256")
    .update(original)
    .digest("hex")
    .slice(0, 12);
  const stem = safeToolStem(original).slice(
    0,
    MAX_TOOL_NAME_LENGTH - digest.length - 1
  );
  let candidate = `${stem}_${digest}`;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `_${suffix}`;
    candidate = `${stem.slice(0, MAX_TOOL_NAME_LENGTH - digest.length - tail.length - 1)}_${digest}${tail}`;
    suffix += 1;
  }
  return candidate;
}

function mappedToolDigest(value: string): string | undefined {
  return MAPPED_TOOL_DIGEST_SUFFIX.exec(value)?.[1];
}

function uniqueMapping(
  mappings: FunctionMapping[],
  predicate: (mapping: FunctionMapping) => boolean
): FunctionMapping | undefined {
  const matches = mappings.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveReturnedToolName(
  returned: string,
  mappings: FunctionMapping[],
  parserErrors: string[]
): string {
  const exactSafe = mappings.find((mapping) => mapping.safe === returned);
  if (exactSafe) {
    return exactSafe.original;
  }
  const exactOriginal = mappings.find(
    (mapping) => mapping.original === returned
  );
  if (exactOriginal) {
    parserErrors.push(
      `bridge tool-name recovery: exact original name ${JSON.stringify(returned)}`
    );
    return exactOriginal.original;
  }
  const returnedDigest = mappedToolDigest(returned);
  const digestMatch = returnedDigest
    ? uniqueMapping(
        mappings,
        (mapping) => mappedToolDigest(mapping.safe) === returnedDigest
      )
    : undefined;
  if (digestMatch) {
    parserErrors.push(
      `bridge tool-name recovery: unique digest suffix ${JSON.stringify(returned)}`
    );
    return digestMatch.original;
  }
  const stemMatch = uniqueMapping(
    mappings,
    (mapping) =>
      mappedToolStemWithoutDigest(mapping.safe) === returned &&
      mapping.safe !== returned
  );
  if (stemMatch) {
    parserErrors.push(
      `bridge tool-name recovery: unique stem without digest ${JSON.stringify(returned)}`
    );
    return stemMatch.original;
  }
  parserErrors.push(
    `bridge tool-name pass-through: unmapped model output ${JSON.stringify(returned)}`
  );
  return returned;
}

function mappedToolStemWithoutDigest(value: string): string {
  return value.replace(MAPPED_TOOL_DIGEST_SUFFIX, "");
}

export function serializeReturnedToolInput(
  input: unknown,
  returnedToolName: string,
  parserErrors: string[]
): string {
  if (isRecord(input)) {
    return JSON.stringify(input);
  }
  parserErrors.push(
    `bridge tool-input pass-through: non-object input for ${JSON.stringify(returnedToolName)}`
  );
  if (typeof input === "string") {
    return input;
  }
  return JSON.stringify(input) ?? String(input);
}

export function parseTools(value: unknown): FunctionMapping[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new OpenAICompatInputError("tools must be an array");
  }
  if (value.length > MAX_TOOLS) {
    throw new OpenAICompatInputError(`tools cannot exceed ${MAX_TOOLS} items`);
  }
  const usedOriginal = new Set<string>();
  const usedSafe = new Set<string>();
  return value.map((tool, index) => {
    if (!isRecord(tool) || tool.type !== "function") {
      throw new OpenAICompatInputError(
        `tools[${index}] must be a function tool`
      );
    }
    if (!isRecord(tool.function)) {
      throw new OpenAICompatInputError(`tools[${index}].function is required`);
    }
    const original = requiredString(
      tool.function.name,
      `tools[${index}].function.name`,
      512
    );
    if (usedOriginal.has(original)) {
      throw new OpenAICompatInputError(`duplicate tool name: ${original}`);
    }
    usedOriginal.add(original);
    const safe = mappedToolName(original, usedSafe);
    usedSafe.add(safe);
    const parameters =
      tool.function.parameters === undefined
        ? { properties: {}, type: "object" }
        : tool.function.parameters;
    if (!isRecord(parameters)) {
      throw new OpenAICompatInputError(
        `tools[${index}].function.parameters must be an object`
      );
    }
    const { description } = tool.function;
    if (description !== undefined && typeof description !== "string") {
      throw new OpenAICompatInputError(
        `tools[${index}].function.description must be a string`
      );
    }
    return { description, original, parameters, safe };
  });
}

function toToolSet(mappings: FunctionMapping[]): ToolSet | undefined {
  if (mappings.length === 0) {
    return;
  }
  return Object.fromEntries(
    mappings.map((mapping) => [
      mapping.safe,
      {
        description: mapping.description,
        inputSchema: jsonSchema(mapping.parameters),
      },
    ])
  );
}

function parseHistoryArguments(
  value: unknown,
  field: string,
  parserErrors: string[]
): Record<string, unknown> {
  const source = requiredString(value, field);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    parserErrors.push(
      `bridge history tool-input preservation: invalid JSON at ${field}`
    );
    return { [MALFORMED_HISTORY_ARGUMENTS_KEY]: source };
  }
  if (!isRecord(parsed)) {
    parserErrors.push(
      `bridge history tool-input preservation: non-object JSON at ${field}`
    );
    return { [MALFORMED_HISTORY_ARGUMENTS_KEY]: source };
  }
  return parsed;
}

function historyToolName(original: string, state: HistoryState): string {
  const current = state.safeByOriginal.get(original);
  if (current) {
    return current;
  }
  const safe = mappedToolName(original, state.usedSafeNames);
  state.usedSafeNames.add(safe);
  state.safeByOriginal.set(original, safe);
  return safe;
}

function preserveMissingToolResults(before: string, state: HistoryState): void {
  if (state.pendingToolCalls.size === 0) {
    return;
  }
  state.messages.push({
    content: [...state.pendingToolCalls].map(([toolCallId, toolName]) => ({
      output: {
        type: "text" as const,
        value: JSON.stringify({ [MISSING_HISTORY_TOOL_RESULT_KEY]: true }),
      },
      toolCallId,
      toolName,
      type: "tool-result" as const,
    })),
    role: "tool",
  } as ModelMessage);
  state.parserErrors.push(
    `bridge history missing-tool-result preservation: inserted ${state.pendingToolCalls.size} sentinel result(s) before ${before}`
  );
  state.pendingToolCalls.clear();
}

function appendAssistantMessage(
  raw: Record<string, unknown>,
  field: string,
  state: HistoryState
): void {
  const content: AssistantContent = [];
  const text = messageText(raw.content, `${field}.content`);
  if (text.length > 0) {
    content.push({ text, type: "text" });
  }
  const calls = raw.tool_calls;
  if (calls !== undefined && calls !== null) {
    if (!Array.isArray(calls)) {
      throw new OpenAICompatInputError(`${field}.tool_calls must be an array`);
    }
    for (const [callIndex, call] of calls.entries()) {
      const callField = `${field}.tool_calls[${callIndex}]`;
      if (!(isRecord(call) && isRecord(call.function))) {
        throw new OpenAICompatInputError(`${callField} is invalid`);
      }
      const original = requiredString(
        call.function.name,
        `${callField}.function.name`,
        512
      );
      const safe = historyToolName(original, state);
      const id = requiredString(call.id, `${callField}.id`, 512);
      state.callNames.set(id, safe);
      state.pendingToolCalls.set(id, safe);
      content.push({
        input: parseHistoryArguments(
          call.function.arguments,
          `${callField}.function.arguments`,
          state.parserErrors
        ),
        toolCallId: id,
        toolName: safe,
        type: "tool-call",
      });
    }
  }
  if (content.length === 0) {
    content.push({ text: "", type: "text" });
  }
  state.messages.push({ content, role: "assistant" } as ModelMessage);
}

function appendToolMessage(
  raw: Record<string, unknown>,
  field: string,
  state: HistoryState
): void {
  const id = requiredString(raw.tool_call_id, `${field}.tool_call_id`, 512);
  const safe = state.callNames.get(id);
  if (!safe) {
    throw new OpenAICompatInputError(
      `${field}.tool_call_id references an unknown preceding call`
    );
  }
  state.pendingToolCalls.delete(id);
  state.messages.push({
    content: [
      {
        output: {
          type: "text",
          value: messageText(raw.content, `${field}.content`),
        },
        toolCallId: id,
        toolName: safe,
        type: "tool-result",
      },
    ],
    role: "tool",
  } as ModelMessage);
}

function appendMessage(
  raw: Record<string, unknown>,
  field: string,
  state: HistoryState
): void {
  if (raw.role !== "tool") {
    preserveMissingToolResults(field, state);
  }
  switch (raw.role) {
    case "system":
    case "developer":
      state.instructions.push(messageText(raw.content, `${field}.content`));
      return;
    case "user":
      state.messages.push({
        content: messageText(raw.content, `${field}.content`),
        role: "user",
      });
      return;
    case "assistant":
      appendAssistantMessage(raw, field, state);
      return;
    case "tool":
      appendToolMessage(raw, field, state);
      return;
    default:
      throw new OpenAICompatInputError(`${field}.role is unsupported`);
  }
}

function parseMessages(
  value: unknown,
  mappings: FunctionMapping[]
): {
  readonly instructions?: string;
  readonly messages: ModelMessage[];
  readonly parserErrors: string[];
} {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OpenAICompatInputError("messages must be a non-empty array");
  }
  if (value.length > MAX_MESSAGES) {
    throw new OpenAICompatInputError(
      `messages cannot exceed ${MAX_MESSAGES} items`
    );
  }
  const state: HistoryState = {
    callNames: new Map(),
    instructions: [],
    messages: [],
    parserErrors: [],
    pendingToolCalls: new Map(),
    safeByOriginal: new Map(
      mappings.map((mapping) => [mapping.original, mapping.safe])
    ),
    usedSafeNames: new Set(mappings.map((mapping) => mapping.safe)),
  };
  for (const [index, raw] of value.entries()) {
    const field = `messages[${index}]`;
    if (!isRecord(raw)) {
      throw new OpenAICompatInputError(`${field} must be an object`);
    }
    appendMessage(raw, field, state);
  }
  preserveMissingToolResults("the end of messages", state);
  return {
    parserErrors: state.parserErrors,
    instructions:
      state.instructions.length > 0
        ? state.instructions.join("\n\n")
        : undefined,
    messages: state.messages,
  };
}

export function bridgeArmFromModel(model: string): OpenAICompatBridgeArm {
  const normalized = model.toLowerCase().replaceAll("_", "-");
  if (normalized.includes("native-plus") || normalized.includes("nativeplus")) {
    throw new OpenAICompatInputError(
      "the native-plus bridge arm has been removed; use prompt-only"
    );
  }
  if (
    normalized.includes("prompt-only") ||
    normalized.includes("promptonly") ||
    normalized.endsWith("/glm5") ||
    normalized === "glm5"
  ) {
    return "glm5";
  }
  if (normalized.includes("native") || normalized.includes("simulator")) {
    return "native";
  }
  throw new OpenAICompatInputError(
    "model must identify an explicit native or prompt-only bridge arm"
  );
}

function parseToolChoice(
  value: unknown,
  mappings: FunctionMapping[]
): ToolChoice<ToolSet> | undefined {
  if (value === undefined || value === null) {
    return mappings.length > 0 ? "auto" : undefined;
  }
  if (value === "auto" || value === "none" || value === "required") {
    return value;
  }
  if (
    isRecord(value) &&
    value.type === "function" &&
    isRecord(value.function)
  ) {
    const original = requiredString(
      value.function.name,
      "tool_choice.function.name"
    );
    const safe = mappings.find(
      (mapping) => mapping.original === original
    )?.safe;
    if (!safe) {
      throw new OpenAICompatInputError(
        "tool_choice.function.name references an unknown tool"
      );
    }
    return { toolName: safe, type: "tool" };
  }
  throw new OpenAICompatInputError("tool_choice is unsupported");
}

function parseStop(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    return [value];
  }
  if (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every((item) => typeof item === "string")
  ) {
    return value;
  }
  throw new OpenAICompatInputError("stop must be a string or string array");
}

export function parseOpenAICompatRequest(
  value: unknown,
  configuredMaxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS
): ParsedOpenAIRequest {
  if (!isRecord(value)) {
    throw new OpenAICompatInputError("request body must be a JSON object");
  }
  if (value.stream === true) {
    throw new OpenAICompatInputError(
      "client-side SSE is unsupported; select bridge upstream transport instead"
    );
  }
  if (value.n !== undefined && value.n !== 1) {
    throw new OpenAICompatInputError("n must be 1");
  }
  const requestedModel = requiredString(value.model, "model", 512);
  const toolMappings = parseTools(value.tools);
  const parsedMessages = parseMessages(value.messages, toolMappings);
  const requestedMax =
    positiveInteger(value.max_completion_tokens, "max_completion_tokens") ??
    positiveInteger(value.max_tokens, "max_tokens") ??
    configuredMaxOutputTokens;
  return {
    arm: bridgeArmFromModel(requestedModel),
    historyParserErrors: parsedMessages.parserErrors,
    instructions: parsedMessages.instructions,
    maxOutputTokens: Math.min(requestedMax, configuredMaxOutputTokens),
    messages: parsedMessages.messages,
    requestedModel,
    stopSequences: parseStop(value.stop),
    temperature: finiteNumber(value.temperature, "temperature"),
    toolChoice: parseToolChoice(value.tool_choice, toolMappings),
    toolMappings,
    tools: toToolSet(toolMappings),
    topP: finiteNumber(value.top_p, "top_p"),
  };
}
