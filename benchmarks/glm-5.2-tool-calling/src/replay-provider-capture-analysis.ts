import type {
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  type StreamingToolCallDelta,
  StreamingToolCallTracker,
} from "@ai-sdk/provider-utils";
import type {
  CapturedFunctionTool,
  ProviderCaptureRecord,
} from "./provider-capture";

interface CaptureReplayCall {
  arguments: unknown;
  name: string;
  safeName: string;
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

interface StreamAssemblyState {
  activeReasoning: boolean;
  activeText: boolean;
  finishReason: LanguageModelV4FinishReason;
  readonly forwarded: Set<number>;
  readonly parts: LanguageModelV4StreamPart[];
  readonly pending: Map<number, PendingToolCall>;
  readonly tracker: StreamingToolCallTracker<OpenAiToolCallDelta>;
}

const SSE_BODY_START = /^data:/m;
const LEADING_BYTE_ORDER_MARK = /^\uFEFF/u;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parserError(
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

export function isSse(record: ProviderCaptureRecord): boolean {
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
      payloads.push(JSON.parse(data));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Malformed SSE data: ${message}`);
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

export function responsePayloads(
  record: ProviderCaptureRecord,
  errors: string[]
): unknown[] {
  const body = record.response?.body ?? "";
  if (isSse(record)) {
    return parseCapturedSseChunks([body], errors);
  }
  try {
    return [JSON.parse(body)];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Malformed JSON response: ${message}`);
    return [];
  }
}

export function textChunks(
  payloads: unknown[],
  transport: "generate" | "stream"
) {
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

export function providerTools(
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
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function replayCalls(
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

export function replayText(
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

export function mapFinishReason(value: unknown): LanguageModelV4FinishReason {
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

export function generateProviderContent(
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

function createStreamAssembly(): StreamAssemblyState {
  const parts: LanguageModelV4StreamPart[] = [
    { type: "stream-start", warnings: [] },
  ];
  return {
    activeReasoning: false,
    activeText: false,
    finishReason: mapFinishReason(undefined),
    forwarded: new Set(),
    parts,
    pending: new Map(),
    tracker: new StreamingToolCallTracker<OpenAiToolCallDelta>({
      enqueue(part) {
        if (part) {
          parts.push(part);
        }
      },
    }),
  };
}

function processToolCall(
  state: StreamAssemblyState,
  call: OpenAiToolCallDelta
): void {
  const { index } = call;
  if (index == null || state.forwarded.has(index)) {
    state.tracker.processDelta(call);
    return;
  }
  const current = state.pending.get(index) ?? { arguments: "", id: null };
  current.id ??= call.id ?? null;
  current.arguments += call.function?.arguments ?? "";
  state.pending.set(index, current);
  const name = call.function?.name;
  if (name != null) {
    state.tracker.processDelta({
      function: { arguments: current.arguments, name },
      id: current.id,
      index,
    });
    state.pending.delete(index);
    state.forwarded.add(index);
  }
}

function appendReasoning(state: StreamAssemblyState, reasoning: string): void {
  if (!state.activeReasoning) {
    state.parts.push({ id: "reasoning-0", type: "reasoning-start" });
    state.activeReasoning = true;
  }
  state.parts.push({
    delta: reasoning,
    id: "reasoning-0",
    type: "reasoning-delta",
  });
}

function closeReasoning(state: StreamAssemblyState): void {
  if (state.activeReasoning) {
    state.parts.push({ id: "reasoning-0", type: "reasoning-end" });
    state.activeReasoning = false;
  }
}

function appendText(state: StreamAssemblyState, text: string): void {
  closeReasoning(state);
  if (!state.activeText) {
    state.parts.push({ id: "txt-0", type: "text-start" });
    state.activeText = true;
  }
  state.parts.push({ delta: text, id: "txt-0", type: "text-delta" });
}

function processStreamPayload(
  state: StreamAssemblyState,
  payload: unknown
): void {
  const choice = firstChoice(payload);
  if (!choice) {
    return;
  }
  if (choice.finish_reason != null) {
    state.finishReason = mapFinishReason(choice.finish_reason);
  }
  const delta = asRecord(choice.delta);
  if (!delta) {
    return;
  }
  const reasoning = reasoningText(delta);
  if (reasoning.length > 0) {
    appendReasoning(state, reasoning);
  }
  const text = contentText(delta.content);
  if (text.length > 0) {
    appendText(state, text);
  }
  const calls = toolCalls(delta.tool_calls);
  if (calls.length > 0) {
    closeReasoning(state);
  }
  for (const call of calls) {
    processToolCall(state, call);
  }
}

function finishStreamAssembly(state: StreamAssemblyState): void {
  closeReasoning(state);
  if (state.activeText) {
    state.parts.push({ id: "txt-0", type: "text-end" });
  }
  for (const [index, call] of state.pending) {
    state.tracker.processDelta({
      function: { arguments: call.arguments },
      id: call.id,
      index,
    });
  }
  state.tracker.flush();
}

export function streamProviderParts(
  payloads: unknown[],
  errors: string[]
): LanguageModelV4StreamPart[] {
  const state = createStreamAssembly();
  try {
    for (const payload of payloads) {
      processStreamPayload(state, payload);
    }
    finishStreamAssembly(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Malformed provider stream: ${message}`);
    state.parts.push({ error, type: "error" });
  }
  state.parts.push({
    finishReason: state.finishReason,
    type: "finish",
    usage: {
      inputTokens: {
        cacheRead: undefined,
        cacheWrite: undefined,
        noCache: undefined,
        total: 0,
      },
      outputTokens: { reasoning: undefined, text: undefined, total: 0 },
    },
  });
  return state.parts;
}
