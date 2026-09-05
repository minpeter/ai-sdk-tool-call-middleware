import { createHash } from "node:crypto";
import type {
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { glm5Protocol } from "../../../src/core/protocols/glm5-protocol";
import { originalToolsSchema } from "../../../src/core/utils/provider-options";
import { wrapGenerate } from "../../../src/generate-handler";
import { wrapStream } from "../../../src/stream-handler";
import {
  generateProviderContent,
  mapFinishReason,
  parseCapturedSseChunks,
  parserError,
} from "./replay-provider-capture-analysis";
import type {
  CaptureResponseReplay,
  ReplayParserMode,
} from "./replay-provider-capture-core";

type ChunkInvarianceResult = CaptureResponseReplay["chunkInvariance"];

interface ReplayMiddlewareContext {
  readonly errors: string[];
  readonly tools: LanguageModelV4FunctionTool[];
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

function providerOptions(context: ReplayMiddlewareContext) {
  return {
    toolCallMiddleware: {
      onError(message: string, metadata?: Record<string, unknown>) {
        parserError(context.errors, message, metadata);
      },
      originalTools: originalToolsSchema.encode(context.tools),
    },
  };
}

function generateResult(
  content: LanguageModelV4Content[],
  finishReason: LanguageModelV4FinishReason
): LanguageModelV4GenerateResult {
  return { content, finishReason, usage: ZERO_USAGE, warnings: [] };
}

export async function replayGenerate(
  payloads: unknown[],
  mode: ReplayParserMode,
  context: ReplayMiddlewareContext
): Promise<LanguageModelV4Content[]> {
  const providerResult = generateProviderContent(payloads, context.errors);
  if (mode === "native") {
    return providerResult.content;
  }
  const result = await wrapGenerate({
    doGenerate: async () =>
      generateResult(providerResult.content, providerResult.finishReason),
    params: { providerOptions: providerOptions(context) },
    protocol: glm5Protocol(),
  });
  return result.content;
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
  context: ReplayMiddlewareContext
): Promise<LanguageModelV4StreamPart[]> {
  const result = await wrapStream({
    doGenerate: async () => generateResult([], mapFinishReason(undefined)),
    doStream: async () => ({ stream: readableParts(parts) }),
    params: { providerOptions: providerOptions(context) },
    protocol: glm5Protocol(),
  });
  return collectStream(result.stream);
}

export function replayStream(
  parts: LanguageModelV4StreamPart[],
  mode: ReplayParserMode,
  context: ReplayMiddlewareContext
): Promise<LanguageModelV4StreamPart[]> {
  if (mode === "native") {
    return Promise.resolve(parts);
  }
  return runGlm5Stream(parts, context);
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

function rechunkStreamDeltas(
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

function normalizedLifecyclePart(
  part: LanguageModelV4StreamPart,
  textIds: Map<string, string>,
  toolIds: Map<string, string>
): NormalizedStreamSnapshot["lifecycle"][number] | null {
  switch (part.type) {
    case "text-start":
    case "text-end":
      return { id: normalizedId(textIds, part.id, "text"), type: part.type };
    case "text-delta":
      return {
        delta: part.delta,
        id: normalizedId(textIds, part.id, "text"),
        type: part.type,
      };
    case "tool-input-start":
      return {
        ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
        id: normalizedId(toolIds, part.id, "tool"),
        ...(part.providerExecuted === undefined
          ? {}
          : { providerExecuted: part.providerExecuted }),
        ...(part.title === undefined ? {} : { title: part.title }),
        toolName: part.toolName,
        type: part.type,
      };
    case "tool-input-delta":
      return {
        delta: part.delta,
        id: normalizedId(toolIds, part.id, "tool"),
        type: part.type,
      };
    case "tool-input-end":
      return { id: normalizedId(toolIds, part.id, "tool"), type: part.type };
    case "tool-call":
      return {
        ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
        id: normalizedId(toolIds, part.toolCallId, "tool"),
        input: part.input,
        ...(part.providerExecuted === undefined
          ? {}
          : { providerExecuted: part.providerExecuted }),
        toolName: part.toolName,
        type: part.type,
      };
    default:
      return null;
  }
}

function appendLifecyclePart(
  lifecycle: NormalizedStreamSnapshot["lifecycle"],
  part: NormalizedStreamSnapshot["lifecycle"][number]
): void {
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
}

function lifecycleCalls(
  lifecycle: NormalizedStreamSnapshot["lifecycle"]
): NormalizedStreamSnapshot["calls"] {
  return lifecycle.flatMap((part) =>
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
}

/** Normalize only generated IDs and adjacent delta segmentation. */
function normalizeCallTextLifecycle(
  parts: LanguageModelV4StreamPart[]
): NormalizedStreamSnapshot {
  const lifecycle: NormalizedStreamSnapshot["lifecycle"] = [];
  const textIds = new Map<string, string>();
  const toolIds = new Map<string, string>();
  for (const part of parts) {
    const normalized = normalizedLifecyclePart(part, textIds, toolIds);
    if (normalized) {
      appendLifecyclePart(lifecycle, normalized);
    }
  }
  const text = lifecycle
    .flatMap((part) => (part.type === "text-delta" ? [String(part.delta)] : []))
    .join("");
  return { calls: lifecycleCalls(lifecycle), lifecycle, text };
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

export async function validateGlm5ChunkInvariance(options: {
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
    const output = await runGlm5Stream(rechunked, {
      errors,
      tools: options.tools,
    });
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
