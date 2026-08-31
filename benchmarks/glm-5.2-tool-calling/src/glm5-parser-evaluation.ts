import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";

import { glm5Protocol } from "../../../src/core/protocols/glm5-protocol";
import type { Glm5DecodedCall } from "./glm5-reference-decoders";

export interface Glm5ProductionDecodeResult {
  accepted: boolean;
  calls: Glm5DecodedCall[];
  errors: string[];
  parser: "production-generate" | "production-stream";
  recoveries: string[];
  text: string;
}

const ZERO_USAGE = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 0,
  },
  outputTokens: { reasoning: undefined, text: undefined, total: 0 },
};

function errorMessage(
  message: string,
  metadata?: Record<string, unknown>
): string {
  const deterministicMetadata = metadata
    ? Object.fromEntries(
        Object.entries(metadata).filter(([key]) => key !== "toolCallId")
      )
    : undefined;
  return `${message}${deterministicMetadata ? ` ${JSON.stringify(deterministicMetadata)}` : ""}`;
}

function parseInput(
  input: string,
  errors: string[]
): Record<string, unknown> | null {
  try {
    const value = JSON.parse(input) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    errors.push("Production parser emitted non-object tool input.");
  } catch (error) {
    errors.push(
      `Production parser emitted invalid JSON input: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return null;
}

function contentResult(
  content: readonly LanguageModelV4Content[],
  errors: string[]
): Pick<Glm5ProductionDecodeResult, "calls" | "text"> {
  const calls: Glm5DecodedCall[] = [];
  const text: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      text.push(part.text);
    } else if (part.type === "tool-call") {
      const arguments_ = parseInput(part.input, errors);
      if (arguments_) {
        calls.push({ arguments: arguments_, name: part.toolName });
      }
    }
  }
  return { calls, text: text.join("") };
}

function streamResult(
  parts: readonly LanguageModelV4StreamPart[],
  errors: string[]
): Pick<Glm5ProductionDecodeResult, "calls" | "text"> {
  const calls: Glm5DecodedCall[] = [];
  const text: string[] = [];
  for (const part of parts) {
    if (part.type === "text-delta") {
      text.push(part.delta);
    } else if (part.type === "tool-call") {
      const arguments_ = parseInput(part.input, errors);
      if (arguments_) {
        calls.push({ arguments: arguments_, name: part.toolName });
      }
    }
  }
  return { calls, text: text.join("") };
}

export function decodeProductionGlm5Generate(
  text: string,
  tools: readonly LanguageModelV4FunctionTool[]
): Glm5ProductionDecodeResult {
  const errors: string[] = [];
  const recoveries: string[] = [];
  const content = glm5Protocol().parseGeneratedText({
    options: {
      onError: (message, metadata) => {
        const detail = errorMessage(message, metadata);
        if (message.startsWith("Recovered malformed")) {
          recoveries.push(detail);
        } else {
          errors.push(detail);
        }
      },
    },
    text,
    tools: [...tools],
  });
  const normalized = contentResult(content, errors);
  return {
    accepted: normalized.calls.length > 0,
    ...normalized,
    errors,
    parser: "production-generate",
    recoveries,
  };
}

export async function decodeProductionGlm5Stream(
  chunks: readonly string[],
  tools: readonly LanguageModelV4FunctionTool[]
): Promise<Glm5ProductionDecodeResult> {
  const errors: string[] = [];
  const recoveries: string[] = [];
  const transformer = glm5Protocol().createStreamParser({
    options: {
      onError: (message, metadata) => {
        const detail = errorMessage(message, metadata);
        if (message.startsWith("Recovered malformed")) {
          recoveries.push(detail);
        } else {
          errors.push(detail);
        }
      },
    },
    tools: [...tools],
  });
  const writer = transformer.writable.getWriter();
  const reader = transformer.readable.getReader();
  const parts: LanguageModelV4StreamPart[] = [];
  const collect = (async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      parts.push(result.value);
    }
  })();
  for (const chunk of chunks) {
    if (chunk) {
      await writer.write({
        delta: chunk,
        id: "reference-replay",
        type: "text-delta",
      });
    }
  }
  await writer.write({
    finishReason: { raw: undefined, unified: "stop" },
    type: "finish",
    usage: ZERO_USAGE,
  });
  await writer.close();
  await collect;
  const normalized = streamResult(parts, errors);
  return {
    accepted: normalized.calls.length > 0,
    ...normalized,
    errors,
    parser: "production-stream",
    recoveries,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

export function canonicalCalls(calls: readonly Glm5DecodedCall[]): string {
  return JSON.stringify(
    calls.map((call) => ({
      arguments: stableValue(call.arguments),
      name: call.name,
    }))
  );
}

export function callsExactlyEqual(
  left: readonly Glm5DecodedCall[],
  right: readonly Glm5DecodedCall[]
): boolean {
  return canonicalCalls(left) === canonicalCalls(right);
}

export function fixedWidthChunks(text: string, width: number): string[] {
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new Error("Chunk width must be a positive safe integer.");
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += width) {
    chunks.push(text.slice(index, index + width));
  }
  return chunks.length > 0 ? chunks : [""];
}

export function deterministicVariableChunks(
  text: string,
  seed: string
): string[] {
  let state = 2_166_136_261;
  for (const character of seed) {
    state =
      (Math.imul(state, 1_664_525) + character.charCodeAt(0) + 1_013_904_223) %
      4_294_967_296;
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) % 4_294_967_296;
    const width = 1 + (Math.abs(state) % 31);
    chunks.push(text.slice(cursor, cursor + width));
    cursor += width;
  }
  return chunks.length > 0 ? chunks : [""];
}
