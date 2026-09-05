import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { glm5ToolMiddleware } from "../../../src/preconfigured-middleware";
import {
  type BenchmarkTransport,
  runBenchmarkModel,
} from "./benchmark-model-call";
import {
  isRecord,
  OpenAICompatInputError,
  type ParsedOpenAIRequest,
  parseOpenAICompatRequest,
  parseTools,
  resolveReturnedToolName,
  serializeReturnedToolInput,
} from "./openai-compat-request-parsing";

interface BridgeCaptureContext {
  readonly arm: string;
  readonly attempt: number;
  readonly jobKey: string;
  readonly suite: string;
  readonly taskId?: string;
  readonly tools: Array<{
    readonly description?: string;
    readonly inputSchema: unknown;
    readonly name: string;
    readonly originalName?: string;
  }>;
  readonly transport: "generate" | "stream";
  readonly trial: number;
}

export interface BridgeCapture {
  readonly flush: () => Promise<void>;
  readonly run: <T>(
    context: BridgeCaptureContext,
    requestIds: string[],
    operation: () => T
  ) => T;
}

export interface OpenAICompatBridgeOptions {
  readonly bodyLimitBytes?: number;
  readonly capture?: BridgeCapture;
  readonly host?: string;
  readonly maxOutputTokens?: number;
  readonly modelFactory: (modelId: string) => LanguageModelV4;
  readonly modelId: string;
  readonly port?: number;
  readonly requestLogOutput?: string;
  readonly secretValues?: readonly string[];
  readonly suite?: string;
  readonly timeoutMs?: number;
  readonly transientRetries?: number;
  readonly transientRetryDelayMs?: number;
  readonly transport?: BenchmarkTransport;
}

export interface RunningOpenAICompatBridge {
  readonly close: () => Promise<void>;
  readonly host: string;
  readonly origin: string;
  readonly port: number;
}

export interface CapturePolicy {
  readonly safeError: (
    error: unknown,
    secretValues: readonly string[]
  ) => string;
  readonly safeText: (input: string, secretValues: readonly string[]) => string;
}

interface OpenAICompatResponse {
  readonly choices: Array<{
    readonly finish_reason: string | null;
    readonly index: number;
    readonly message: {
      readonly content: string | null;
      readonly role: "assistant";
      readonly tool_calls?: Array<{
        readonly function: {
          readonly arguments: string;
          readonly name: string;
        };
        readonly id: string;
        readonly type: "function";
      }>;
    };
  }>;
  readonly created: number;
  readonly id: string;
  readonly model: string;
  readonly object: "chat.completion";
  readonly usage: {
    readonly completion_tokens: number;
    readonly prompt_tokens: number;
    readonly total_tokens: number;
  };
}

interface RequestLogRecord {
  readonly arm?: "glm5" | "native";
  readonly completedAt: string;
  readonly error?: string;
  readonly latencyMs: number;
  readonly model?: string;
  readonly parserErrors?: string[];
  readonly requestBody: string;
  readonly requestId: string;
  readonly status: number;
  readonly suite: string;
  readonly transport: BenchmarkTransport;
  readonly upstreamCaptureIds: string[];
}

type ConfiguredBridge = Required<
  Pick<
    OpenAICompatBridgeOptions,
    | "bodyLimitBytes"
    | "host"
    | "maxOutputTokens"
    | "modelFactory"
    | "modelId"
    | "port"
    | "secretValues"
    | "suite"
    | "timeoutMs"
    | "transientRetries"
    | "transientRetryDelayMs"
    | "transport"
  >
> &
  Pick<OpenAICompatBridgeOptions, "capture" | "requestLogOutput">;

type Generate = ReturnType<typeof createOpenAICompatGenerate>;

const DEFAULT_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_TRANSIENT_RETRIES = 0;
export const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 5000;
const EXPOSED_MODELS = [
  "glm52-native",
  "glm52-prompt-only",
  "glm52-simulator",
] as const;
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
    return { raw, value: JSON.parse(raw) };
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

function captureTools(value: unknown): BridgeCaptureContext["tools"] {
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

function appendRequestLog(path: string | undefined, record: RequestLogRecord) {
  if (path) {
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  }
}

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

async function generateWithRetries(
  request: IncomingMessage,
  parsedBody: unknown,
  context: {
    readonly configured: ConfiguredBridge;
    readonly generate: Generate;
    readonly parsed: ParsedOpenAIRequest;
    readonly requestId: string;
    readonly upstreamCaptureIds: string[];
  }
): Promise<Awaited<ReturnType<Generate>>> {
  const operation = () => context.generate(parsedBody);
  for (
    let attempt = 1;
    attempt <= context.configured.transientRetries + 1;
    attempt += 1
  ) {
    try {
      return context.configured.capture
        ? await context.configured.capture.run(
            {
              arm: context.parsed.arm,
              attempt,
              jobKey: context.requestId,
              suite: context.configured.suite,
              taskId:
                typeof request.headers["x-benchmark-task-id"] === "string"
                  ? request.headers["x-benchmark-task-id"]
                  : undefined,
              tools: captureTools(parsedBody),
              transport: context.configured.transport,
              trial: 1,
            },
            context.upstreamCaptureIds,
            operation
          )
        : await operation();
    } catch (error) {
      if (
        attempt > context.configured.transientRetries ||
        !isTransientUpstreamError(error)
      ) {
        throw error;
      }
      await waitForRetry(context.configured.transientRetryDelayMs);
    }
  }
  throw new Error("transient retry loop completed without a result");
}

async function handleCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    readonly configured: ConfiguredBridge;
    readonly generate: Generate;
    readonly policy: CapturePolicy;
  }
): Promise<void> {
  const requestId = randomUUID();
  const started = performance.now();
  const upstreamCaptureIds: string[] = [];
  let rawBody = "";
  let parsed: ParsedOpenAIRequest | undefined;
  try {
    const body = await readBody(request, context.configured.bodyLimitBytes);
    rawBody = body.raw;
    parsed = parseOpenAICompatRequest(
      body.value,
      context.configured.maxOutputTokens
    );
    const generated = await generateWithRetries(request, body.value, {
      configured: context.configured,
      generate: context.generate,
      parsed,
      requestId,
      upstreamCaptureIds,
    });
    sendJson(response, 200, generated.response);
    appendRequestLog(context.configured.requestLogOutput, {
      arm: parsed.arm,
      completedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started),
      model: parsed.requestedModel,
      parserErrors: generated.parserErrors,
      requestBody: context.policy.safeText(
        rawBody,
        context.configured.secretValues
      ),
      requestId,
      status: 200,
      suite: context.configured.suite,
      transport: context.configured.transport,
      upstreamCaptureIds,
    });
  } catch (error) {
    const status = error instanceof OpenAICompatInputError ? error.status : 502;
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
    appendRequestLog(context.configured.requestLogOutput, {
      arm: parsed?.arm,
      completedAt: new Date().toISOString(),
      error: context.policy.safeError(error, context.configured.secretValues),
      latencyMs: Math.round(performance.now() - started),
      model: parsed?.requestedModel,
      requestBody: context.policy.safeText(
        rawBody,
        context.configured.secretValues
      ),
      requestId,
      status,
      suite: context.configured.suite,
      transport: context.configured.transport,
      upstreamCaptureIds,
    });
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    readonly configured: ConfiguredBridge;
    readonly generate: Generate;
    readonly policy: CapturePolicy;
  }
): Promise<void> {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: { message: "loopback clients only" } });
    return;
  }
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && requestUrl.pathname === "/healthz") {
    sendJson(response, 200, {
      exposedModels: EXPOSED_MODELS,
      model: context.configured.modelId,
      status: "ok",
      suite: context.configured.suite,
      transientRetries: context.configured.transientRetries,
      transport: context.configured.transport,
    });
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
    sendJson(response, 200, {
      data: EXPOSED_MODELS.map((id) => ({
        created: 0,
        id,
        object: "model",
        owned_by: "benchmark",
      })),
      object: "list",
    });
    return;
  }
  if (
    request.method === "POST" &&
    requestUrl.pathname === "/v1/chat/completions"
  ) {
    await handleCompletion(request, response, context);
    return;
  }
  sendJson(response, 404, { error: { message: "not found" } });
}

export function createStartOpenAICompatBridge(
  policy: CapturePolicy
): (options: OpenAICompatBridgeOptions) => Promise<RunningOpenAICompatBridge> {
  return (options) => startSharedOpenAICompatBridge(options, policy);
}

export async function startSharedOpenAICompatBridge(
  options: OpenAICompatBridgeOptions,
  policy: CapturePolicy
): Promise<RunningOpenAICompatBridge> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("OpenAI compatibility bridge only permits a loopback host");
  }
  const configured: ConfiguredBridge = {
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
  const context = {
    configured,
    generate: createOpenAICompatGenerate(configured),
    policy,
  };
  const server = createServer((request, response) =>
    routeRequest(request, response, context)
  );
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
