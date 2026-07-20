import { createHash } from "node:crypto";
import type {
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import {
  type StreamingToolCallDelta,
  StreamingToolCallTracker,
} from "@ai-sdk/provider-utils";
import { glm5Protocol } from "../../../src/core/protocols/glm5-protocol";
import { originalToolsSchema } from "../../../src/core/utils/provider-options";
import { wrapGenerate } from "../../../src/generate-handler";
import { wrapStream } from "../../../src/stream-handler";
import type {
  CapturedFunctionTool,
  ProviderCaptureRecord,
} from "./provider-capture";

export type ReplayParserChoice = "auto" | "glm5" | "native";

export type ReplayParserMode = "glm5" | "native";

export interface CaptureReplayCall {
  arguments: unknown;
  name: string;
  safeName: string;
}

export interface ChunkInvarianceResult {
  checked: boolean;
  normalizedSnapshotSha256?: string;
  sseByteChunkVariants: number;
  streamDeltaChunkVariants: number;
}

export interface CaptureResponseReplay {
  calls: CaptureReplayCall[];
  chunkInvariance: ChunkInvarianceResult;
  parser: ReplayParserMode;
  rawText: string;
  responseChunks: number;
  text: string;
}

interface OpenAiToolCallDelta extends StreamingToolCallDelta {
  function?: {
    arguments?: string | null;
    name?: string | null;
  } | null;
  id?: string | null;
  index?: number | null;
  type?: string | null;
}

interface PendingToolCall {
  arguments: string;
  id: string | null;
}

interface DeltaChunkStrategy {
  name: string;
  nextSize: (remaining: number) => number;
}

interface NormalizedStreamSnapshot {
  calls: Array<{
    dynamic?: boolean;
    id: string;
    input: string;
    providerExecuted?: boolean;
    toolName: string;
  }>;
  lifecycle: Record<string, unknown>[];
  text: string;
}

const SSE_BODY_START = /^data:/m;
const LEADING_BYTE_ORDER_MARK = /^\uFEFF/u;
const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 0,
  },
  outputTokens: { reasoning: undefined, text: undefined, total: 0 },
};
const BODY_CHUNK_WIDTHS = [1, 2, 3, 5, 7, 13, 29] as const;
const DELTA_CHUNK_WIDTHS = [1, 2, 3, 5, 7, 13] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parserError(
  errors: string[],
  message: string,
  metadata?: Record<string, unknown>
): void {
  errors.push(`${message}${metadata ? ` ${JSON.stringify(metadata)}` : ""}`);
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      const record = asRecord(part);
      return typeof record?.text === "string" ? record.text : "";
    })
    .join("");
}

function reasoningText(value: Record<string, unknown>): string {
  if (typeof value.reasoning_content === "string") {
    return value.reasoning_content;
  }
  return typeof value.reasoning === "string" ? value.reasoning : "";
}

function choices(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  return Array.isArray(root?.choices)
    ? root.choices.flatMap((choice) => {
        const record = asRecord(choice);
        return record ? [record] : [];
      })
    : [];
}

function firstChoice(payload: unknown): Record<string, unknown> | null {
  return choices(payload)[0] ?? null;
}

function openAiToolCall(value: unknown): OpenAiToolCallDelta | null {
  const call = asRecord(value);
  if (!call) {
    return null;
  }
  const function_ = asRecord(call.function);
  return {
    function:
      function_ === null
        ? null
        : {
            arguments:
              typeof function_.arguments === "string"
                ? function_.arguments
                : null,
            name: typeof function_.name === "string" ? function_.name : null,
          },
    id: typeof call.id === "string" ? call.id : null,
    index: typeof call.index === "number" ? call.index : null,
    type: typeof call.type === "string" ? call.type : null,
  };
}

function toolCalls(value: unknown): OpenAiToolCallDelta[] {
  return Array.isArray(value)
    ? value.flatMap((call) => {
        const parsed = openAiToolCall(call);
        return parsed ? [parsed] : [];
      })
    : [];
}

function isSse(record: ProviderCaptureRecord): boolean {
  const body = record.response?.body ?? "";
  const contentType = record.response?.headers["content-type"] ?? "";
  return contentType.includes("text/event-stream") || SSE_BODY_START.test(body);
}

/** Parse an SSE response incrementally, including CR/LF split boundaries. */
export function parseCapturedSseChunks(
  chunks: Iterable<string>,
  errors: string[] = []
): unknown[] {
  const payloads: unknown[] = [];
  let buffered = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    const data = dataLines.join("\n");
    dataLines = [];
    if (!data || data === "[DONE]") {
      return;
    }
    try {
      payloads.push(JSON.parse(data) as unknown);
    } catch (error) {
      errors.push(`Malformed SSE data: ${errorText(error)}`);
    }
  };

  const processLine = (line: string) => {
    if (line.length === 0) {
      dispatch();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") {
      return;
    }
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    dataLines.push(value);
  };

  const drainLines = (final: boolean) => {
    let cursor = 0;
    for (let index = 0; index < buffered.length; index += 1) {
      const character = buffered.charAt(index);
      if (character !== "\n" && character !== "\r") {
        continue;
      }
      if (character === "\r" && index + 1 === buffered.length && !final) {
        break;
      }
      processLine(buffered.slice(cursor, index));
      if (character === "\r" && buffered.charAt(index + 1) === "\n") {
        index += 1;
      }
      cursor = index + 1;
    }
    buffered = buffered.slice(cursor);
    if (final && buffered.length > 0) {
      processLine(buffered);
      buffered = "";
    }
  };

  let firstChunk = true;
  for (const chunk of chunks) {
    const normalized = firstChunk
      ? chunk.replace(LEADING_BYTE_ORDER_MARK, "")
      : chunk;
    firstChunk = false;
    buffered += normalized;
    drainLines(false);
  }
  drainLines(true);
  dispatch();
  return payloads;
}

function responsePayloads(
  record: ProviderCaptureRecord,
  errors: string[]
): unknown[] {
  const body = record.response?.body ?? "";
  if (isSse(record)) {
    return parseCapturedSseChunks([body], errors);
  }
  try {
    return [JSON.parse(body) as unknown];
  } catch (error) {
    errors.push(`Malformed JSON response: ${errorText(error)}`);
    return [];
  }
}

function textChunks(payloads: unknown[], transport: "generate" | "stream") {
  const chunks: string[] = [];
  for (const payload of payloads) {
    const choice = firstChoice(payload);
    const container = asRecord(
      transport === "stream" ? choice?.delta : choice?.message
    );
    const text = contentText(container?.content);
    if (text) {
      chunks.push(text);
    }
  }
  return chunks;
}

function providerTools(
  tools: CapturedFunctionTool[]
): LanguageModelV4FunctionTool[] {
  return tools.map((tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema as LanguageModelV4FunctionTool["inputSchema"],
    name: tool.name,
    type: "function",
  }));
}

function originalName(name: string, tools: CapturedFunctionTool[]): string {
  return tools.find((tool) => tool.name === name)?.originalName ?? name;
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function replayCalls(
  parts: Array<LanguageModelV4Content | LanguageModelV4StreamPart>,
  tools: CapturedFunctionTool[]
): CaptureReplayCall[] {
  return parts.flatMap((part) =>
    part.type === "tool-call"
      ? [
          {
            arguments: parseArguments(part.input),
            name: originalName(part.toolName, tools),
            safeName: part.toolName,
          },
        ]
      : []
  );
}

function replayText(
  parts: Array<LanguageModelV4Content | LanguageModelV4StreamPart>
): string {
  return parts
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }
      return part.type === "text-delta" ? [part.delta] : [];
    })
    .join("");
}

function mapFinishReason(value: unknown): LanguageModelV4FinishReason {
  const raw = typeof value === "string" ? value : undefined;
  switch (raw) {
    case "stop":
      return { raw, unified: "stop" };
    case "length":
    case "max_tokens":
      return { raw, unified: "length" };
    case "content_filter":
      return { raw, unified: "content-filter" };
    case "tool_calls":
    case "function_call":
      return { raw, unified: "tool-calls" };
    default:
      return { raw, unified: "other" };
  }
}

function generateProviderContent(
  payloads: unknown[],
  errors: string[]
): {
  content: LanguageModelV4Content[];
  finishReason: LanguageModelV4FinishReason;
} {
  const [payload] = payloads;
  const choice = firstChoice(payload);
  if (!choice) {
    return { content: [], finishReason: mapFinishReason(undefined) };
  }
  const message = asRecord(choice.message);
  if (!message) {
    errors.push("Generate response did not contain choices[0].message");
    return { content: [], finishReason: mapFinishReason(choice.finish_reason) };
  }

  const content: LanguageModelV4Content[] = [];
  const text = contentText(message.content);
  if (text.length > 0) {
    content.push({ text, type: "text" });
  }
  const reasoning = reasoningText(message);
  if (reasoning.length > 0) {
    content.push({ text: reasoning, type: "reasoning" });
  }
  for (const [index, call] of toolCalls(message.tool_calls).entries()) {
    const toolName = call.function?.name;
    const input = call.function?.arguments;
    if (!(toolName && typeof input === "string")) {
      errors.push(`Malformed generate tool call at index ${index}`);
      continue;
    }
    content.push({
      input,
      toolCallId: call.id ?? `captured-generate-${index}`,
      toolName,
      type: "tool-call",
    });
  }
  return { content, finishReason: mapFinishReason(choice.finish_reason) };
}

function providerOptions(
  tools: LanguageModelV4FunctionTool[],
  errors: string[]
) {
  return {
    toolCallMiddleware: {
      onError(message: string, metadata?: Record<string, unknown>) {
        parserError(errors, message, metadata);
      },
      originalTools: originalToolsSchema.encode(tools),
    },
  };
}

function generateResult(
  content: LanguageModelV4Content[],
  finishReason: LanguageModelV4FinishReason
): LanguageModelV4GenerateResult {
  return { content, finishReason, usage: ZERO_USAGE, warnings: [] };
}

async function replayGenerate(
  payloads: unknown[],
  mode: ReplayParserMode,
  tools: LanguageModelV4FunctionTool[],
  errors: string[]
): Promise<LanguageModelV4Content[]> {
  const providerResult = generateProviderContent(payloads, errors);
  if (mode === "native") {
    return providerResult.content;
  }
  const result = await wrapGenerate({
    doGenerate: async () =>
      generateResult(providerResult.content, providerResult.finishReason),
    params: { providerOptions: providerOptions(tools, errors) },
    protocol: glm5Protocol(),
  });
  return result.content;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This mirrors the OpenAI-compatible provider's ordered reasoning, text, pending-name, and tool lifecycle translation.
function streamProviderParts(
  payloads: unknown[],
  errors: string[]
): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
  ];
  const tracker = new StreamingToolCallTracker<OpenAiToolCallDelta>({
    enqueue(part) {
      if (part) {
        parts.push(part);
      }
    },
  });
  const pending = new Map<number, PendingToolCall>();
  const forwarded = new Set<number>();
  let activeReasoning = false;
  let activeText = false;
  let finishReason = mapFinishReason(undefined);

  const processToolCall = (call: OpenAiToolCallDelta) => {
    const { index } = call;
    if (index == null || forwarded.has(index)) {
      tracker.processDelta(call);
      return;
    }
    const current = pending.get(index) ?? { arguments: "", id: null };
    current.id ??= call.id ?? null;
    current.arguments += call.function?.arguments ?? "";
    pending.set(index, current);
    const name = call.function?.name;
    if (name != null) {
      tracker.processDelta({
        function: { arguments: current.arguments, name },
        id: current.id,
        index,
      });
      pending.delete(index);
      forwarded.add(index);
    }
  };

  try {
    for (const payload of payloads) {
      const choice = firstChoice(payload);
      if (!choice) {
        continue;
      }
      if (choice.finish_reason != null) {
        finishReason = mapFinishReason(choice.finish_reason);
      }
      const delta = asRecord(choice.delta);
      if (!delta) {
        continue;
      }
      const reasoning = reasoningText(delta);
      if (reasoning.length > 0) {
        if (!activeReasoning) {
          parts.push({ id: "reasoning-0", type: "reasoning-start" });
          activeReasoning = true;
        }
        parts.push({
          delta: reasoning,
          id: "reasoning-0",
          type: "reasoning-delta",
        });
      }
      const text = contentText(delta.content);
      if (text.length > 0) {
        if (activeReasoning) {
          parts.push({ id: "reasoning-0", type: "reasoning-end" });
          activeReasoning = false;
        }
        if (!activeText) {
          parts.push({ id: "txt-0", type: "text-start" });
          activeText = true;
        }
        parts.push({ delta: text, id: "txt-0", type: "text-delta" });
      }
      const calls = toolCalls(delta.tool_calls);
      if (calls.length > 0 && activeReasoning) {
        parts.push({ id: "reasoning-0", type: "reasoning-end" });
        activeReasoning = false;
      }
      for (const call of calls) {
        processToolCall(call);
      }
    }
    if (activeReasoning) {
      parts.push({ id: "reasoning-0", type: "reasoning-end" });
    }
    if (activeText) {
      parts.push({ id: "txt-0", type: "text-end" });
    }
    for (const [index, call] of pending) {
      tracker.processDelta({
        function: { arguments: call.arguments },
        id: call.id,
        index,
      });
    }
    tracker.flush();
  } catch (error) {
    errors.push(`Malformed provider stream: ${errorText(error)}`);
    parts.push({ error, type: "error" });
  }
  parts.push({ finishReason, type: "finish", usage: ZERO_USAGE });
  return parts;
}

function readableParts(
  parts: LanguageModelV4StreamPart[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

async function collectStream(
  stream: ReadableStream<LanguageModelV4StreamPart>
): Promise<LanguageModelV4StreamPart[]> {
  const output: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) {
    output.push(part);
  }
  return output;
}

async function runGlm5Stream(
  parts: LanguageModelV4StreamPart[],
  tools: LanguageModelV4FunctionTool[],
  errors: string[]
): Promise<LanguageModelV4StreamPart[]> {
  const result = await wrapStream({
    doGenerate: async () => generateResult([], mapFinishReason(undefined)),
    doStream: async () => ({ stream: readableParts(parts) }),
    params: { providerOptions: providerOptions(tools, errors) },
    protocol: glm5Protocol(),
  });
  return collectStream(result.stream);
}

function replayStream(
  parts: LanguageModelV4StreamPart[],
  mode: ReplayParserMode,
  tools: LanguageModelV4FunctionTool[],
  errors: string[]
): Promise<LanguageModelV4StreamPart[]> {
  if (mode === "native") {
    return Promise.resolve(parts);
  }
  return runGlm5Stream(parts, tools, errors);
}

function seededStrategy(seed: string): DeltaChunkStrategy {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) || 1;
  return {
    name: "seeded",
    nextSize(remaining) {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return Math.min(remaining, 1 + (state % 23));
    },
  };
}

function fixedStrategy(width: number): DeltaChunkStrategy {
  return {
    name: `width-${width}`,
    nextSize: (remaining) => Math.min(remaining, width),
  };
}

function chunkString(value: string, strategy: DeltaChunkStrategy): string[] {
  if (value.length === 0) {
    return [""];
  }
  const codePoints = Array.from(value);
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < codePoints.length) {
    const size = Math.max(1, strategy.nextSize(codePoints.length - cursor));
    chunks.push(codePoints.slice(cursor, cursor + size).join(""));
    cursor += size;
  }
  return chunks;
}

function isDeltaPart(
  part: LanguageModelV4StreamPart
): part is Extract<
  LanguageModelV4StreamPart,
  { type: "text-delta" | "tool-input-delta" }
> {
  return part.type === "text-delta" || part.type === "tool-input-delta";
}

export function rechunkStreamDeltas(
  parts: LanguageModelV4StreamPart[],
  strategy: DeltaChunkStrategy
): LanguageModelV4StreamPart[] {
  const output: LanguageModelV4StreamPart[] = [];
  let cursor = 0;
  while (cursor < parts.length) {
    const first = parts[cursor];
    if (!(first && isDeltaPart(first))) {
      if (first) {
        output.push(first);
      }
      cursor += 1;
      continue;
    }
    let combined = first.delta;
    let end = cursor + 1;
    while (end < parts.length) {
      const next = parts[end];
      if (
        !(next && isDeltaPart(next)) ||
        next.type !== first.type ||
        next.id !== first.id
      ) {
        break;
      }
      combined += next.delta;
      end += 1;
    }
    for (const delta of chunkString(combined, strategy)) {
      output.push({ ...first, delta });
    }
    cursor = end;
  }
  return output;
}

function normalizedId(
  ids: Map<string, string>,
  raw: string,
  prefix: "text" | "tool"
): string {
  const existing = ids.get(raw);
  if (existing) {
    return existing;
  }
  const id = `${prefix}-${ids.size + 1}`;
  ids.set(raw, id);
  return id;
}

/** Normalize only generated IDs and adjacent delta segmentation. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Exhaustive V4 lifecycle narrowing keeps every compared semantic field explicit.
export function normalizeCallTextLifecycle(
  parts: LanguageModelV4StreamPart[]
): NormalizedStreamSnapshot {
  const lifecycle: Record<string, unknown>[] = [];
  const textIds = new Map<string, string>();
  const toolIds = new Map<string, string>();

  const append = (part: Record<string, unknown>) => {
    const previous = lifecycle.at(-1);
    if (
      (part.type === "text-delta" || part.type === "tool-input-delta") &&
      previous?.type === part.type &&
      previous.id === part.id
    ) {
      previous.delta = `${String(previous.delta ?? "")}${String(part.delta ?? "")}`;
      return;
    }
    lifecycle.push(part);
  };

  for (const part of parts) {
    if (part.type === "text-start" || part.type === "text-end") {
      append({
        id: normalizedId(textIds, part.id, "text"),
        type: part.type,
      });
    } else if (part.type === "text-delta") {
      append({
        delta: part.delta,
        id: normalizedId(textIds, part.id, "text"),
        type: part.type,
      });
    } else if (part.type === "tool-input-start") {
      append({
        ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
        id: normalizedId(toolIds, part.id, "tool"),
        ...(part.providerExecuted === undefined
          ? {}
          : { providerExecuted: part.providerExecuted }),
        ...(part.title === undefined ? {} : { title: part.title }),
        toolName: part.toolName,
        type: part.type,
      });
    } else if (part.type === "tool-input-delta") {
      append({
        delta: part.delta,
        id: normalizedId(toolIds, part.id, "tool"),
        type: part.type,
      });
    } else if (part.type === "tool-input-end") {
      append({
        id: normalizedId(toolIds, part.id, "tool"),
        type: part.type,
      });
    } else if (part.type === "tool-call") {
      append({
        ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
        id: normalizedId(toolIds, part.toolCallId, "tool"),
        input: part.input,
        ...(part.providerExecuted === undefined
          ? {}
          : { providerExecuted: part.providerExecuted }),
        toolName: part.toolName,
        type: part.type,
      });
    }
  }

  const calls = lifecycle.flatMap((part) =>
    part.type === "tool-call"
      ? [
          {
            ...(part.dynamic === undefined
              ? {}
              : { dynamic: Boolean(part.dynamic) }),
            id: String(part.id),
            input: String(part.input),
            ...(part.providerExecuted === undefined
              ? {}
              : { providerExecuted: Boolean(part.providerExecuted) }),
            toolName: String(part.toolName),
          },
        ]
      : []
  );
  const text = lifecycle
    .flatMap((part) => (part.type === "text-delta" ? [String(part.delta)] : []))
    .join("");
  return { calls, lifecycle, text };
}

function* fixedBodyChunks(body: string, width: number): Iterable<string> {
  for (let cursor = 0; cursor < body.length; cursor += width) {
    yield body.slice(cursor, cursor + width);
  }
}

function* seededBodyChunks(body: string, seed: string): Iterable<string> {
  const strategy = seededStrategy(seed);
  let cursor = 0;
  while (cursor < body.length) {
    const width = strategy.nextSize(body.length - cursor);
    yield body.slice(cursor, cursor + width);
    cursor += width;
  }
}

async function validateGlm5ChunkInvariance(options: {
  baselineOutput: LanguageModelV4StreamPart[];
  body: string;
  captureId: string;
  providerParts: LanguageModelV4StreamPart[];
  tools: LanguageModelV4FunctionTool[];
}): Promise<ChunkInvarianceResult> {
  const baselineSseErrors: string[] = [];
  const baselinePayloads = parseCapturedSseChunks(
    [options.body],
    baselineSseErrors
  );
  const baselineSse = JSON.stringify({
    errors: baselineSseErrors,
    payloads: baselinePayloads,
  });
  const bodyVariants: Iterable<string>[] = BODY_CHUNK_WIDTHS.map((width) =>
    fixedBodyChunks(options.body, width)
  );
  bodyVariants.push(seededBodyChunks(options.body, options.captureId));
  for (const chunks of bodyVariants) {
    const errors: string[] = [];
    const payloads = parseCapturedSseChunks(chunks, errors);
    if (JSON.stringify({ errors, payloads }) !== baselineSse) {
      throw new Error(
        `SSE byte-chunk invariance failed for capture ${options.captureId}`
      );
    }
  }

  const baselineSnapshot = normalizeCallTextLifecycle(options.baselineOutput);
  const baseline = JSON.stringify(baselineSnapshot);
  const deltaStrategies = DELTA_CHUNK_WIDTHS.map(fixedStrategy);
  deltaStrategies.push(seededStrategy(`${options.captureId}:stream-deltas`));
  deltaStrategies.push({
    name: "whole",
    nextSize: (remaining) => remaining,
  });
  for (const strategy of deltaStrategies) {
    const errors: string[] = [];
    const rechunked = rechunkStreamDeltas(options.providerParts, strategy);
    const output = await runGlm5Stream(rechunked, options.tools, errors);
    const candidate = JSON.stringify(normalizeCallTextLifecycle(output));
    if (candidate !== baseline) {
      throw new Error(
        `GLM prompt-only stream chunk invariance failed for capture ${options.captureId} (${strategy.name}); baseline=${sha256(baseline)} candidate=${sha256(candidate)}`
      );
    }
  }
  return {
    checked: true,
    normalizedSnapshotSha256: sha256(baseline),
    sseByteChunkVariants: bodyVariants.length + 1,
    streamDeltaChunkVariants: deltaStrategies.length + 1,
  };
}

export function replayParserMode(
  arm: string,
  choice: ReplayParserChoice
): ReplayParserMode {
  if (choice === "native") {
    return "native";
  }
  if (choice === "glm5") {
    return "glm5";
  }
  switch (arm) {
    case "native":
      return "native";
    case "glm5":
      return "glm5";
    default:
      throw new Error(
        `--parser auto has no response semantics for capture arm ${arm}`
      );
  }
}

export async function replayProviderCaptureResponse(
  record: ProviderCaptureRecord,
  parserChoice: ReplayParserChoice,
  errors: string[] = []
): Promise<CaptureResponseReplay> {
  const parser = replayParserMode(record.context.arm, parserChoice);
  const payloads = responsePayloads(record, errors);
  const rawChunks = textChunks(payloads, record.context.transport);
  const rawText = rawChunks.join("");
  const tools = providerTools(record.context.tools);

  if (record.context.transport === "generate") {
    const content = await replayGenerate(payloads, parser, tools, errors);
    return {
      calls: replayCalls(content, record.context.tools),
      chunkInvariance: {
        checked: false,
        sseByteChunkVariants: 0,
        streamDeltaChunkVariants: 0,
      },
      parser,
      rawText,
      responseChunks: rawChunks.length,
      text: replayText(content),
    };
  }

  const providerParts = streamProviderParts(payloads, errors);
  const output = await replayStream(providerParts, parser, tools, errors);
  const chunkInvariance =
    parser === "glm5" && isSse(record)
      ? await validateGlm5ChunkInvariance({
          baselineOutput: output,
          body: record.response?.body ?? "",
          captureId: record.captureId,
          providerParts,
          tools,
        })
      : {
          checked: false,
          sseByteChunkVariants: 0,
          streamDeltaChunkVariants: 0,
        };
  return {
    calls: replayCalls(output, record.context.tools),
    chunkInvariance,
    parser,
    rawText,
    responseChunks: rawChunks.length,
    text: replayText(output),
  };
}
