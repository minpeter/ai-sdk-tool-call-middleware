import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  generateText,
  jsonSchema,
  type ModelMessage,
  type ToolSet,
  wrapLanguageModel,
} from "ai";
import { glm5ToolMiddleware } from "../../../src/preconfigured-middleware";

export type Tau2BridgeArm = "glm5" | "native";

export interface Tau2BridgeTool {
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
}

export interface Tau2BridgeToolCall {
  arguments: Record<string, unknown>;
  id: string;
  name: string;
}

export interface Tau2BridgeToolResult {
  content: string;
  error?: boolean;
  id: string;
  name: string;
}

export type Tau2BridgeMessage =
  | { content: string; role: "user" }
  | { content: string; role: "assistant" }
  | { role: "assistant"; toolCalls: Tau2BridgeToolCall[] }
  | { role: "tool"; toolResults: Tau2BridgeToolResult[] };

export interface Tau2BridgeRequest {
  arm: Tau2BridgeArm;
  messages: Tau2BridgeMessage[];
  model?: string;
  system: string;
  tools: Tau2BridgeTool[];
}

export interface Tau2BridgeResponse {
  arm: Tau2BridgeArm;
  finishReason: string;
  model: string;
  parserErrors: string[];
  rawFinishReason?: string;
  text: string;
  toolCalls: Tau2BridgeToolCall[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface Tau2BridgeOptions {
  bodyLimitBytes?: number;
  host?: string;
  maxOutputTokens?: number;
  modelFactory: (modelId: string) => LanguageModelV4;
  modelId: string;
  port?: number;
  timeoutMs?: number;
}

export interface RunningTau2Bridge {
  close: () => Promise<void>;
  host: string;
  origin: string;
  port: number;
}

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_MESSAGES = 256;
const MAX_TOOLS = 256;
const MAX_NAME_LENGTH = 128;
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

class BridgeInputError extends Error {
  readonly status: number;

  constructor(message: string, options?: ErrorOptions & { status?: number }) {
    super(message, options);
    this.name = "BridgeInputError";
    this.status = options?.status ?? 400;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 1_000_000
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeInputError(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new BridgeInputError(`${field} is too long`);
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength = 1_000_000
): string | undefined {
  if (value === undefined) {
    return;
  }
  return requiredString(value, field, maxLength);
}

function toolName(value: unknown, field: string): string {
  const name = requiredString(value, field, MAX_NAME_LENGTH);
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new BridgeInputError(`${field} is not a valid tool name`);
  }
  return name;
}

function parseTool(value: unknown, index: number): Tau2BridgeTool {
  if (!isRecord(value)) {
    throw new BridgeInputError(`tools[${index}] must be an object`);
  }
  const { inputSchema } = value;
  if (!isRecord(inputSchema)) {
    throw new BridgeInputError(`tools[${index}].inputSchema must be an object`);
  }
  return {
    description: optionalString(
      value.description,
      `tools[${index}].description`,
      100_000
    ),
    inputSchema,
    name: toolName(value.name, `tools[${index}].name`),
  };
}

function parseToolCall(
  value: unknown,
  field: string,
  knownTools: ReadonlySet<string>
): Tau2BridgeToolCall {
  if (!isRecord(value)) {
    throw new BridgeInputError(`${field} must be an object`);
  }
  const name = toolName(value.name, `${field}.name`);
  if (!knownTools.has(name)) {
    throw new BridgeInputError(`${field}.name references an unknown tool`);
  }
  if (!isRecord(value.arguments)) {
    throw new BridgeInputError(`${field}.arguments must be an object`);
  }
  return {
    arguments: value.arguments,
    id: requiredString(value.id, `${field}.id`, 512),
    name,
  };
}

function parseToolResult(
  value: unknown,
  field: string,
  knownTools: ReadonlySet<string>,
  callNames: ReadonlyMap<string, string>
): Tau2BridgeToolResult {
  if (!isRecord(value)) {
    throw new BridgeInputError(`${field} must be an object`);
  }
  const id = requiredString(value.id, `${field}.id`, 512);
  const name = toolName(value.name, `${field}.name`);
  if (!knownTools.has(name)) {
    throw new BridgeInputError(`${field}.name references an unknown tool`);
  }
  if (callNames.get(id) !== name) {
    throw new BridgeInputError(
      `${field} does not match a preceding assistant tool call`
    );
  }
  if (value.error !== undefined && typeof value.error !== "boolean") {
    throw new BridgeInputError(`${field}.error must be a boolean`);
  }
  return {
    content:
      value.content === ""
        ? ""
        : requiredString(value.content, `${field}.content`),
    error: value.error as boolean | undefined,
    id,
    name,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fail-closed validation intentionally keeps the ordered message/call/result state machine in one pass.
function parseMessages(
  value: unknown,
  knownTools: ReadonlySet<string>
): Tau2BridgeMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BridgeInputError("messages must be a non-empty array");
  }
  if (value.length > MAX_MESSAGES) {
    throw new BridgeInputError(`messages cannot exceed ${MAX_MESSAGES} items`);
  }

  const callNames = new Map<string, string>();
  const messages: Tau2BridgeMessage[] = [];
  for (const [index, item] of value.entries()) {
    const field = `messages[${index}]`;
    if (!isRecord(item)) {
      throw new BridgeInputError(`${field} must be an object`);
    }
    if (item.role === "user") {
      messages.push({
        content: requiredString(item.content, `${field}.content`),
        role: "user",
      });
      continue;
    }
    if (item.role === "assistant" && item.toolCalls === undefined) {
      messages.push({
        content: requiredString(item.content, `${field}.content`),
        role: "assistant",
      });
      continue;
    }
    if (item.role === "assistant") {
      if (!Array.isArray(item.toolCalls) || item.toolCalls.length === 0) {
        throw new BridgeInputError(`${field}.toolCalls must be non-empty`);
      }
      const calls = item.toolCalls.map((call, callIndex) =>
        parseToolCall(call, `${field}.toolCalls[${callIndex}]`, knownTools)
      );
      for (const call of calls) {
        if (callNames.has(call.id)) {
          throw new BridgeInputError(
            `${field} contains a duplicate tool call id`
          );
        }
        callNames.set(call.id, call.name);
      }
      messages.push({ role: "assistant", toolCalls: calls });
      continue;
    }
    if (item.role === "tool") {
      if (!Array.isArray(item.toolResults) || item.toolResults.length === 0) {
        throw new BridgeInputError(`${field}.toolResults must be non-empty`);
      }
      messages.push({
        role: "tool",
        toolResults: item.toolResults.map((result, resultIndex) =>
          parseToolResult(
            result,
            `${field}.toolResults[${resultIndex}]`,
            knownTools,
            callNames
          )
        ),
      });
      continue;
    }
    throw new BridgeInputError(`${field}.role is unsupported`);
  }

  const last = messages.at(-1);
  if (last?.role !== "user" && last?.role !== "tool") {
    throw new BridgeInputError(
      "the final message must be from the user or a tool"
    );
  }
  return messages;
}

export function parseTau2BridgeRequest(
  value: unknown,
  configuredModelId: string
): Tau2BridgeRequest {
  if (!isRecord(value)) {
    throw new BridgeInputError("request body must be a JSON object");
  }
  if (value.arm !== "native" && value.arm !== "glm5") {
    throw new BridgeInputError("arm must be native or glm5");
  }
  if (!Array.isArray(value.tools)) {
    throw new BridgeInputError("tools must be an array");
  }
  if (value.tools.length > MAX_TOOLS) {
    throw new BridgeInputError(`tools cannot exceed ${MAX_TOOLS} items`);
  }
  const tools = value.tools.map(parseTool);
  const knownTools = new Set<string>();
  for (const tool of tools) {
    if (knownTools.has(tool.name)) {
      throw new BridgeInputError(`duplicate tool name: ${tool.name}`);
    }
    knownTools.add(tool.name);
  }
  const model = optionalString(value.model, "model", 512);
  if (model !== undefined && model !== configuredModelId) {
    throw new BridgeInputError(
      `model must match the bridge model (${configuredModelId})`
    );
  }
  return {
    arm: value.arm,
    messages: parseMessages(value.messages, knownTools),
    model,
    system: requiredString(value.system, "system"),
    tools,
  };
}

function toToolSet(tools: Tau2BridgeTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema(tool.inputSchema),
      },
    ])
  );
}

function toModelMessages(messages: Tau2BridgeMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === "user") {
      return message;
    }
    if (message.role === "assistant" && "content" in message) {
      return message;
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.toolCalls.map((call) => ({
          type: "tool-call" as const,
          input: call.arguments,
          toolCallId: call.id,
          toolName: call.name,
        })),
      };
    }
    return {
      role: "tool",
      content: message.toolResults.map((result) => ({
        type: "tool-result" as const,
        output: {
          type: "text" as const,
          value: result.error
            ? `[tool error] ${result.content}`
            : result.content,
        },
        toolCallId: result.id,
        toolName: result.name,
      })),
    };
  });
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

function usageTotal(input?: number, output?: number): number | undefined {
  if (input === undefined && output === undefined) {
    return;
  }
  return (input ?? 0) + (output ?? 0);
}

export function createTau2BridgeGenerate(
  options: Pick<
    Required<Tau2BridgeOptions>,
    "maxOutputTokens" | "modelFactory" | "modelId" | "timeoutMs"
  >
) {
  return async (body: unknown): Promise<Tau2BridgeResponse> => {
    const request = parseTau2BridgeRequest(body, options.modelId);
    const parserErrors: string[] = [];
    const knownTools = new Set(request.tools.map((tool) => tool.name));
    const baseModel = options.modelFactory(options.modelId);
    const model =
      request.arm === "glm5"
        ? wrapLanguageModel({
            middleware: glm5ToolMiddleware,
            model: baseModel,
          })
        : baseModel;
    const result = await generateText({
      abortSignal: AbortSignal.timeout(options.timeoutMs),
      instructions: request.system,
      maxOutputTokens: options.maxOutputTokens,
      maxRetries: 0,
      messages: toModelMessages(request.messages),
      model,
      providerOptions:
        request.arm === "glm5"
          ? (parserProviderOptions(parserErrors) as never)
          : undefined,
      temperature: 0,
      ...(request.tools.length > 0
        ? { toolChoice: "auto" as const, tools: toToolSet(request.tools) }
        : {}),
    });
    const calls = result.toolCalls.map((call) => {
      if (!knownTools.has(call.toolName)) {
        throw new Error(`model returned unknown tool: ${call.toolName}`);
      }
      if (!isRecord(call.input)) {
        throw new Error(`model returned non-object input for ${call.toolName}`);
      }
      return {
        arguments: call.input,
        id: call.toolCallId,
        name: call.toolName,
      };
    });
    if (calls.length === 0 && result.text.trim().length === 0) {
      throw new Error("model returned neither text nor tool calls");
    }
    const { inputTokens, outputTokens } = result.usage;
    return {
      arm: request.arm,
      finishReason: result.finishReason,
      model: options.modelId,
      parserErrors,
      rawFinishReason: result.rawFinishReason,
      text: calls.length > 0 ? "" : result.text,
      toolCalls: calls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: usageTotal(inputTokens, outputTokens),
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

async function readJsonBody(
  request: IncomingMessage,
  limitBytes: number
): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limitBytes) {
      throw new BridgeInputError("request body is too large", { status: 413 });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new BridgeInputError("request body is empty");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new BridgeInputError("request body is not valid JSON", {
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

export async function startTau2Bridge(
  options: Tau2BridgeOptions
): Promise<RunningTau2Bridge> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("tau2 bridge only permits a loopback host");
  }
  const configured = {
    bodyLimitBytes: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    host,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    modelFactory: options.modelFactory,
    modelId: options.modelId,
    port: options.port ?? 8787,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const generate = createTau2BridgeGenerate(configured);
  const server = createServer(async (request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: "loopback clients only" });
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, {
        arms: ["native", "glm5"],
        model: configured.modelId,
        status: "ok",
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/generate") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    try {
      const body = await readJsonBody(request, configured.bodyLimitBytes);
      sendJson(response, 200, await generate(body));
    } catch (error) {
      const status = error instanceof BridgeInputError ? error.status : 502;
      const message =
        error instanceof BridgeInputError
          ? error.message
          : "model generation failed";
      sendJson(response, status, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(configured.port, configured.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const displayHost = configured.host === "::1" ? "[::1]" : configured.host;
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function runTau2BridgeCli(): Promise<RunningTau2Bridge> {
  const apiKey = requireEnv("FREEROUTER_API_KEY");
  const baseURL =
    process.env.FREEROUTER_BASE_URL ??
    "https://freerouter.minpeter.workers.dev/v1";
  const modelId = process.env.TAU2_BRIDGE_MODEL ?? "zai-org/glm-5.2";
  const provider = createOpenAICompatible({
    apiKey,
    baseURL,
    name: "freerouter-tau2",
  });
  const bridge = await startTau2Bridge({
    host: process.env.TAU2_BRIDGE_HOST ?? "127.0.0.1",
    maxOutputTokens: envPositiveInt(
      "TAU2_BRIDGE_MAX_OUTPUT_TOKENS",
      DEFAULT_MAX_OUTPUT_TOKENS
    ),
    modelFactory: (requestedModel) => provider(requestedModel),
    modelId,
    port: envPositiveInt("TAU2_BRIDGE_PORT", 8787),
    timeoutMs: envPositiveInt("TAU2_BRIDGE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  });
  console.log(
    JSON.stringify({
      model: modelId,
      origin: bridge.origin,
      status: "listening",
    })
  );
  return bridge;
}

const [, entrypoint] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runTau2BridgeCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
