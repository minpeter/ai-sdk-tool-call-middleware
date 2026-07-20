import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  jsonSchema,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
  wrapLanguageModel,
} from "ai";
import { glm5ToolMiddleware } from "../../../src/preconfigured-middleware";
import {
  type BenchmarkTransport,
  benchmarkTransport,
  runBenchmarkModel,
} from "./benchmark-model-call";
import {
  credentialSafeError,
  credentialSafeText,
  ProviderCapture,
} from "./provider-capture-vakra-linear";

export type OpenAICompatBridgeArm = "glm5" | "native";

export interface OpenAICompatBridgeOptions {
  bodyLimitBytes?: number;
  capture?: ProviderCapture;
  host?: string;
  maxOutputTokens?: number;
  modelFactory: (modelId: string) => LanguageModelV4;
  modelId: string;
  port?: number;
  requestLogOutput?: string;
  secretValues?: readonly string[];
  suite?: string;
  timeoutMs?: number;
  transientRetries?: number;
  transientRetryDelayMs?: number;
  transport?: BenchmarkTransport;
}

export interface RunningOpenAICompatBridge {
  close: () => Promise<void>;
  host: string;
  origin: string;
  port: number;
}

interface FunctionMapping {
  description?: string;
  original: string;
  parameters: Record<string, unknown>;
  safe: string;
}

interface ParsedOpenAIRequest {
  arm: OpenAICompatBridgeArm;
  historyParserErrors: string[];
  instructions?: string;
  maxOutputTokens: number;
  messages: ModelMessage[];
  requestedModel: string;
  stopSequences?: string[];
  temperature?: number;
  toolChoice?: ToolChoice<ToolSet>;
  toolMappings: FunctionMapping[];
  tools?: ToolSet;
  topP?: number;
}

interface OpenAICompatResponse {
  choices: Array<{
    finish_reason: string | null;
    index: number;
    message: {
      content: string | null;
      role: "assistant";
      tool_calls?: Array<{
        function: { arguments: string; name: string };
        id: string;
        type: "function";
      }>;
    };
  }>;
  created: number;
  id: string;
  model: string;
  object: "chat.completion";
  usage: {
    completion_tokens: number;
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface RequestLogRecord {
  arm?: OpenAICompatBridgeArm;
  completedAt: string;
  error?: string;
  latencyMs: number;
  model?: string;
  parserErrors?: string[];
  requestBody: string;
  requestId: string;
  status: number;
  suite: string;
  transport: BenchmarkTransport;
  upstreamCaptureIds: string[];
}

const DEFAULT_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_TRANSIENT_RETRIES = 0;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 5000;
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

class OpenAICompatInputError extends Error {
  readonly status: number;

  constructor(message: string, options?: ErrorOptions & { status?: number }) {
    super(message, options);
    this.name = "OpenAICompatInputError";
    this.status = options?.status ?? 400;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function mappedToolStemWithoutDigest(value: string): string {
  return value.replace(MAPPED_TOOL_DIGEST_SUFFIX, "");
}

function uniqueMapping(
  mappings: FunctionMapping[],
  predicate: (mapping: FunctionMapping) => boolean
): FunctionMapping | undefined {
  const matches = mappings.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveReturnedToolName(
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

function serializeReturnedToolInput(
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

function parseTools(value: unknown): FunctionMapping[] {
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
    const rawParameters = tool.function.parameters;
    const parameters =
      rawParameters === undefined
        ? { properties: {}, type: "object" }
        : rawParameters;
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
    return {
      description,
      original,
      parameters,
      safe,
    };
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
    parsed = JSON.parse(source) as unknown;
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordered OpenAI message history validation deliberately stays fail-closed in one state machine.
function parseMessages(
  value: unknown,
  mappings: FunctionMapping[]
): {
  instructions?: string;
  messages: ModelMessage[];
  parserErrors: string[];
} {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OpenAICompatInputError("messages must be a non-empty array");
  }
  if (value.length > MAX_MESSAGES) {
    throw new OpenAICompatInputError(
      `messages cannot exceed ${MAX_MESSAGES} items`
    );
  }
  const safeByOriginal = new Map(
    mappings.map((mapping) => [mapping.original, mapping.safe])
  );
  const usedSafeNames = new Set(mappings.map((mapping) => mapping.safe));
  const historyToolName = (original: string): string => {
    const current = safeByOriginal.get(original);
    if (current) {
      return current;
    }
    // OpenAI chat history may contain demonstration or earlier-turn calls for
    // tools that are intentionally absent from the current request's `tools`
    // array. Preserve those calls as history without exposing the omitted tool
    // to the model as currently callable.
    const safe = mappedToolName(original, usedSafeNames);
    usedSafeNames.add(safe);
    safeByOriginal.set(original, safe);
    return safe;
  };
  const callNames = new Map<string, string>();
  const pendingToolCalls = new Map<string, string>();
  const messages: ModelMessage[] = [];
  const instructions: string[] = [];
  const parserErrors: string[] = [];
  const preserveMissingToolResults = (before: string): void => {
    if (pendingToolCalls.size === 0) {
      return;
    }
    messages.push({
      content: [...pendingToolCalls].map(([toolCallId, toolName]) => ({
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
    parserErrors.push(
      `bridge history missing-tool-result preservation: inserted ${pendingToolCalls.size} sentinel result(s) before ${before}`
    );
    pendingToolCalls.clear();
  };
  for (const [index, raw] of value.entries()) {
    const field = `messages[${index}]`;
    if (!isRecord(raw)) {
      throw new OpenAICompatInputError(`${field} must be an object`);
    }
    if (raw.role !== "tool") {
      preserveMissingToolResults(field);
    }
    if (raw.role === "system" || raw.role === "developer") {
      instructions.push(messageText(raw.content, `${field}.content`));
      continue;
    }
    if (raw.role === "user") {
      messages.push({
        content: messageText(raw.content, `${field}.content`),
        role: "user",
      });
      continue;
    }
    if (raw.role === "assistant") {
      const content: Array<
        | { text: string; type: "text" }
        | {
            input: Record<string, unknown>;
            toolCallId: string;
            toolName: string;
            type: "tool-call";
          }
      > = [];
      const text = messageText(raw.content, `${field}.content`);
      if (text.length > 0) {
        content.push({ text, type: "text" });
      }
      if (raw.tool_calls !== undefined && raw.tool_calls !== null) {
        if (!Array.isArray(raw.tool_calls)) {
          throw new OpenAICompatInputError(
            `${field}.tool_calls must be an array`
          );
        }
        for (const [callIndex, call] of raw.tool_calls.entries()) {
          const callField = `${field}.tool_calls[${callIndex}]`;
          if (!(isRecord(call) && isRecord(call.function))) {
            throw new OpenAICompatInputError(`${callField} is invalid`);
          }
          const original = requiredString(
            call.function.name,
            `${callField}.function.name`,
            512
          );
          const safe = historyToolName(original);
          const id = requiredString(call.id, `${callField}.id`, 512);
          callNames.set(id, safe);
          pendingToolCalls.set(id, safe);
          content.push({
            input: parseHistoryArguments(
              call.function.arguments,
              `${callField}.function.arguments`,
              parserErrors
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
      messages.push({ content, role: "assistant" } as ModelMessage);
      continue;
    }
    if (raw.role === "tool") {
      const id = requiredString(raw.tool_call_id, `${field}.tool_call_id`, 512);
      const safe = callNames.get(id);
      if (!safe) {
        throw new OpenAICompatInputError(
          `${field}.tool_call_id references an unknown preceding call`
        );
      }
      pendingToolCalls.delete(id);
      messages.push({
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
      continue;
    }
    throw new OpenAICompatInputError(`${field}.role is unsupported`);
  }
  preserveMissingToolResults("the end of messages");
  return {
    parserErrors,
    instructions:
      instructions.length > 0 ? instructions.join("\n\n") : undefined,
    messages,
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

function parserProviderOptions(errors: string[]) {
  return {
    toolCallMiddleware: {
      onError: (message: string, metadata?: Record<string, unknown>) => {
        errors.push(
          metadata === undefined
            ? message
            : `${message} ${JSON.stringify(metadata).slice(0, 500)}`
        );
      },
    },
  };
}

function normalizedFinishReason(value: unknown): string | null {
  let reason: string | null = null;
  if (typeof value === "string") {
    reason = value;
  } else if (isRecord(value) && typeof value.unified === "string") {
    reason = value.unified;
  }
  if (reason === "tool-calls") {
    return "tool_calls";
  }
  if (reason === "stop" || reason === "length" || reason === "content-filter") {
    return reason === "content-filter" ? "content_filter" : reason;
  }
  return reason;
}

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function createOpenAICompatGenerate(
  options: Pick<
    Required<OpenAICompatBridgeOptions>,
    "maxOutputTokens" | "modelFactory" | "modelId" | "timeoutMs" | "transport"
  >
) {
  return async (
    body: unknown
  ): Promise<{ parserErrors: string[]; response: OpenAICompatResponse }> => {
    const request = parseOpenAICompatRequest(body, options.maxOutputTokens);
    const parserErrors: string[] = [...request.historyParserErrors];
    const baseModel = options.modelFactory(options.modelId);
    const model =
      request.arm === "glm5"
        ? wrapLanguageModel({
            middleware: glm5ToolMiddleware,
            model: baseModel,
          })
        : baseModel;
    const result = await runBenchmarkModel(
      {
        abortSignal: AbortSignal.timeout(options.timeoutMs),
        instructions: request.instructions,
        maxOutputTokens: request.maxOutputTokens,
        maxRetries: 0,
        messages: request.messages,
        model,
        providerOptions:
          request.arm === "glm5"
            ? (parserProviderOptions(parserErrors) as never)
            : undefined,
        stopSequences: request.stopSequences,
        temperature: request.temperature,
        toolChoice: request.toolChoice,
        tools: request.tools,
        topP: request.topP,
      },
      options.transport
    );
    const toolCalls = result.toolCalls.map((call) => {
      const original = resolveReturnedToolName(
        call.toolName,
        request.toolMappings,
        parserErrors
      );
      return {
        function: {
          arguments: serializeReturnedToolInput(
            call.input,
            call.toolName,
            parserErrors
          ),
          name: original,
        },
        id: call.toolCallId,
        type: "function" as const,
      };
    });
    const promptTokens = numericUsage(result.usage.inputTokens);
    const completionTokens = numericUsage(result.usage.outputTokens);
    return {
      parserErrors,
      response: {
        choices: [
          {
            finish_reason: normalizedFinishReason(result.finishReason),
            index: 0,
            message: {
              content: result.text.length > 0 ? result.text : null,
              role: "assistant",
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        created: Math.floor(Date.now() / 1000),
        id: `chatcmpl_${randomUUID().replaceAll("-", "")}`,
        model: request.requestedModel,
        object: "chat.completion",
        usage: {
          completion_tokens: completionTokens,
          prompt_tokens: promptTokens,
          total_tokens: promptTokens + completionTokens,
        },
      },
    };
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

async function readBody(
  request: IncomingMessage,
  limitBytes: number
): Promise<{ raw: string; value: unknown }> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limitBytes) {
      throw new OpenAICompatInputError("request body is too large", {
        status: 413,
      });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new OpenAICompatInputError("request body is empty");
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error) {
    throw new OpenAICompatInputError("request body is not valid JSON", {
      cause: error,
    });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function captureTools(value: unknown): Array<{
  description?: string;
  inputSchema: unknown;
  name: string;
  originalName?: string;
}> {
  try {
    return parseTools(isRecord(value) ? value.tools : undefined).map(
      (mapping) => ({
        description: mapping.description,
        inputSchema: mapping.parameters,
        name: mapping.safe,
        ...(mapping.safe === mapping.original
          ? {}
          : { originalName: mapping.original }),
      })
    );
  } catch {
    return [];
  }
}

function prepareRequestLog(path: string, resume: boolean) {
  mkdirSync(dirname(path), { recursive: true });
  if (!resume) {
    writeFileSync(path, "");
  }
}

function appendRequestLog(path: string | undefined, record: RequestLogRecord) {
  if (path) {
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  }
}

const TRANSIENT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function transientHttpStatus(status: unknown): boolean | undefined {
  if (typeof status !== "number" || !Number.isInteger(status)) {
    return;
  }
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function isTransientUpstreamError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);
    if (!isRecord(current)) {
      return false;
    }
    const status =
      transientHttpStatus(current.statusCode) ??
      transientHttpStatus(current.status) ??
      (isRecord(current.response)
        ? transientHttpStatus(current.response.status)
        : undefined);
    if (status !== undefined) {
      return status;
    }
    if (current.isRetryable === true) {
      return true;
    }
    if (
      typeof current.code === "string" &&
      TRANSIENT_ERROR_CODES.has(current.code)
    ) {
      return true;
    }
    if (
      current.name === "TimeoutError" ||
      current.name === "AbortError" ||
      (current.name === "TypeError" && current.message === "fetch failed")
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

async function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs === 0) {
    return;
  }
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

export async function startOpenAICompatBridge(
  options: OpenAICompatBridgeOptions
): Promise<RunningOpenAICompatBridge> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("OpenAI compatibility bridge only permits a loopback host");
  }
  const configured = {
    bodyLimitBytes: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    capture: options.capture,
    host,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    modelFactory: options.modelFactory,
    modelId: options.modelId,
    port: options.port ?? 8790,
    requestLogOutput: options.requestLogOutput,
    secretValues: options.secretValues ?? [],
    suite: options.suite ?? "official-tool-benchmark",
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    transientRetries: options.transientRetries ?? DEFAULT_TRANSIENT_RETRIES,
    transientRetryDelayMs:
      options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS,
    transport: options.transport ?? "generate",
  };
  const generate = createOpenAICompatGenerate(configured);
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a single HTTP boundary keeps validation, capture, and redacted error logging atomic.
  const server = createServer(async (request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: { message: "loopback clients only" } });
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && requestUrl.pathname === "/healthz") {
      sendJson(response, 200, {
        exposedModels: ["glm52-native", "glm52-prompt-only", "glm52-simulator"],
        model: configured.modelId,
        status: "ok",
        suite: configured.suite,
        transientRetries: configured.transientRetries,
        transport: configured.transport,
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
      sendJson(response, 200, {
        data: ["glm52-native", "glm52-prompt-only", "glm52-simulator"].map(
          (id) => ({ created: 0, id, object: "model", owned_by: "benchmark" })
        ),
        object: "list",
      });
      return;
    }
    if (
      request.method !== "POST" ||
      requestUrl.pathname !== "/v1/chat/completions"
    ) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }

    const requestId = randomUUID();
    const started = performance.now();
    const upstreamCaptureIds: string[] = [];
    let rawBody = "";
    let parsedBody: unknown;
    let parsed: ParsedOpenAIRequest | undefined;
    try {
      const body = await readBody(request, configured.bodyLimitBytes);
      rawBody = body.raw;
      parsedBody = body.value;
      parsed = parseOpenAICompatRequest(parsedBody, configured.maxOutputTokens);
      const operation = () => generate(parsedBody);
      let generated: Awaited<ReturnType<typeof generate>> | undefined;
      for (
        let attempt = 1;
        attempt <= configured.transientRetries + 1;
        attempt += 1
      ) {
        try {
          generated = configured.capture
            ? await configured.capture.run(
                {
                  arm: parsed.arm,
                  attempt,
                  jobKey: requestId,
                  suite: configured.suite,
                  taskId:
                    typeof request.headers["x-benchmark-task-id"] === "string"
                      ? request.headers["x-benchmark-task-id"]
                      : undefined,
                  tools: captureTools(parsedBody),
                  transport: configured.transport,
                  trial: 1,
                },
                upstreamCaptureIds,
                operation
              )
            : await operation();
          break;
        } catch (error) {
          if (
            attempt > configured.transientRetries ||
            !isTransientUpstreamError(error)
          ) {
            throw error;
          }
          await waitForRetry(configured.transientRetryDelayMs);
        }
      }
      if (!generated) {
        throw new Error("transient retry loop completed without a result");
      }
      sendJson(response, 200, generated.response);
      appendRequestLog(configured.requestLogOutput, {
        arm: parsed.arm,
        completedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        model: parsed.requestedModel,
        parserErrors: generated.parserErrors,
        requestBody: credentialSafeText(rawBody, configured.secretValues),
        requestId,
        status: 200,
        suite: configured.suite,
        transport: configured.transport,
        upstreamCaptureIds,
      });
    } catch (error) {
      const status =
        error instanceof OpenAICompatInputError ? error.status : 502;
      const safeError = credentialSafeError(error, configured.secretValues);
      sendJson(response, status, {
        error: {
          message:
            error instanceof OpenAICompatInputError
              ? error.message
              : "model generation failed",
          type:
            error instanceof OpenAICompatInputError
              ? "invalid_request_error"
              : "upstream_error",
        },
      });
      appendRequestLog(configured.requestLogOutput, {
        arm: parsed?.arm,
        completedAt: new Date().toISOString(),
        error: safeError,
        latencyMs: Math.round(performance.now() - started),
        model: parsed?.requestedModel,
        requestBody: credentialSafeText(rawBody, configured.secretValues),
        requestId,
        status,
        suite: configured.suite,
        transport: configured.transport,
        upstreamCaptureIds,
      });
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(configured.port, configured.host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address() as AddressInfo;
  const displayHost = configured.host === "::1" ? "[::1]" : configured.host;
  return {
    close: async () => {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
      await configured.capture?.flush();
    },
    host: configured.host,
    origin: `http://${displayHost}:${address.port}`,
    port: address.port,
  };
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function runOpenAICompatBridgeCli(): Promise<RunningOpenAICompatBridge> {
  const apiKey = requireEnv("FREEROUTER_API_KEY");
  const baseURL =
    process.env.FREEROUTER_BASE_URL ??
    "https://freerouter.minpeter.workers.dev/v1";
  const modelId = process.env.OPENAI_BRIDGE_MODEL ?? "zai-org/glm-5.2";
  const outputRoot = resolve(
    process.env.OPENAI_BRIDGE_OUTPUT ?? "/tmp/glm52-official-bridge"
  );
  const resume = process.env.OPENAI_BRIDGE_RESUME === "1";
  const capture = new ProviderCapture({
    arms: new Set(["native", "glm5"]),
    enabled: process.env.OPENAI_BRIDGE_RAW_CAPTURE !== "0",
    output: resolve(outputRoot, "provider-raw.jsonl"),
    secretValues: [apiKey],
  });
  capture.prepare(resume);
  const requestLogOutput = resolve(outputRoot, "requests.jsonl");
  prepareRequestLog(requestLogOutput, resume);
  const provider = createOpenAICompatible({
    apiKey,
    baseURL,
    fetch: capture.fetch,
    name: "freerouter-official-tool-benchmarks",
  });
  const bridge = await startOpenAICompatBridge({
    capture,
    host: process.env.OPENAI_BRIDGE_HOST ?? "127.0.0.1",
    maxOutputTokens: envPositiveInt(
      "OPENAI_BRIDGE_MAX_OUTPUT_TOKENS",
      DEFAULT_MAX_OUTPUT_TOKENS
    ),
    modelFactory: (requestedModel) => provider(requestedModel),
    modelId,
    port: envPositiveInt("OPENAI_BRIDGE_PORT", 8790),
    requestLogOutput,
    secretValues: [apiKey],
    suite: process.env.OPENAI_BRIDGE_SUITE ?? "official-tool-benchmark",
    timeoutMs: envPositiveInt("OPENAI_BRIDGE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    transientRetries: envNonNegativeInt(
      "OPENAI_BRIDGE_TRANSIENT_RETRIES",
      DEFAULT_TRANSIENT_RETRIES
    ),
    transientRetryDelayMs: envNonNegativeInt(
      "OPENAI_BRIDGE_TRANSIENT_RETRY_DELAY_MS",
      DEFAULT_TRANSIENT_RETRY_DELAY_MS
    ),
    transport: benchmarkTransport(process.env.OPENAI_BRIDGE_TRANSPORT),
  });
  console.log(
    JSON.stringify({
      model: modelId,
      origin: bridge.origin,
      outputRoot,
      status: "listening",
      transport: benchmarkTransport(process.env.OPENAI_BRIDGE_TRANSPORT),
    })
  );
  return bridge;
}

const [, entrypoint] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runOpenAICompatBridgeCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export function countJsonlRows(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
