import {
  isJSONObject,
  type JSONObject,
  type JSONSchema7Definition,
  type LanguageModelV4Content,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import type {
  ParserOptions,
  TCMProtocol,
} from "../../../core/protocols/protocol-interface";
import { parse as parseRJSON } from "../../../rjson";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../test-helpers";

type StreamProtocol = Pick<TCMProtocol, "createStreamParser">;
type GeneratedTextProtocol = Pick<TCMProtocol, "parseGeneratedText">;
type ToolInputStart = Extract<
  LanguageModelV4StreamPart,
  { type: "tool-input-start" }
>;
type ToolInputDelta = Extract<
  LanguageModelV4StreamPart,
  { type: "tool-input-delta" }
>;
type ToolInputEnd = Extract<
  LanguageModelV4StreamPart,
  { type: "tool-input-end" }
>;
type ToolCall = Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;
type TextDelta = Extract<LanguageModelV4StreamPart, { type: "text-delta" }>;

export interface ProtocolTextStreamFixture {
  readonly chunks: readonly string[];
  readonly id: string;
  readonly parserOptions?: ParserOptions;
  readonly protocol: StreamProtocol;
  readonly tools: LanguageModelV4FunctionTool[];
}

export interface ProtocolPartStreamFixture {
  readonly parserOptions?: ParserOptions;
  readonly parts: readonly LanguageModelV4StreamPart[];
  readonly protocol: StreamProtocol;
  readonly tools: LanguageModelV4FunctionTool[];
}

export interface GeneratedJsonRepairFixture {
  readonly parserOptions?: ParserOptions;
  readonly protocol: GeneratedTextProtocol;
  readonly text: string;
  readonly tools: LanguageModelV4FunctionTool[];
}

export interface ObjectDeltaFixture extends ProtocolTextStreamFixture {}
export interface StreamingEventFixture extends ProtocolTextStreamFixture {}
export interface LifecycleFixture extends ProtocolPartStreamFixture {}

export interface ToolInputTimeline {
  readonly deltas: readonly ToolInputDelta[];
  readonly ends: readonly ToolInputEnd[];
  readonly starts: readonly ToolInputStart[];
}

export interface ObjectDeltaObservation {
  readonly joinedInput: string;
  readonly parts: readonly LanguageModelV4StreamPart[];
  readonly text: string;
  readonly timeline: ToolInputTimeline;
  readonly toolCall: ToolCall;
}

export interface LifecycleObservation {
  readonly eventTypes: readonly LanguageModelV4StreamPart["type"][];
  readonly parts: readonly LanguageModelV4StreamPart[];
  readonly text: string;
  readonly timeline: ToolInputTimeline;
  readonly toolCalls: readonly ToolCall[];
}

function createProtocolTextStream(
  chunks: readonly string[],
  id: string
): ReadableStream<LanguageModelV4StreamPart> {
  const parts: LanguageModelV4StreamPart[] = chunks.map((delta) => ({
    type: "text-delta",
    id,
    delta,
  }));
  parts.push({
    type: "finish",
    finishReason: stopFinishReason,
    usage: zeroUsage,
  });
  return createProtocolPartStream(parts);
}

export function createProtocolPartStream(
  parts: readonly LanguageModelV4StreamPart[]
): ReadableStream<LanguageModelV4StreamPart> {
  const iterator = parts.values();
  return new ReadableStream<LanguageModelV4StreamPart>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
  });
}

export function createObjectTool(
  name: string,
  properties: Record<string, JSONSchema7Definition>,
  additionalProperties?: boolean,
  required?: string[]
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: {
      type: "object",
      properties,
      ...(required === undefined ? {} : { required }),
      ...(additionalProperties === undefined ? {} : { additionalProperties }),
    },
  };
}

export function collectProtocolStream(
  fixture: ProtocolPartStreamFixture
): Promise<LanguageModelV4StreamPart[]> {
  const parser = fixture.protocol.createStreamParser({
    tools: fixture.tools,
    options: fixture.parserOptions,
  });
  return convertReadableStreamToArray(
    pipeWithTransformer(createProtocolPartStream(fixture.parts), parser)
  );
}

export function runProtocolTextStream(
  fixture: ProtocolTextStreamFixture
): Promise<LanguageModelV4StreamPart[]> {
  const parser = fixture.protocol.createStreamParser({
    tools: fixture.tools,
    options: fixture.parserOptions,
  });
  return convertReadableStreamToArray(
    pipeWithTransformer(
      createProtocolTextStream(fixture.chunks, fixture.id),
      parser
    )
  );
}

export function selectToolInputTimeline(
  parts: readonly LanguageModelV4StreamPart[]
): ToolInputTimeline {
  return {
    starts: parts.filter(
      (part): part is ToolInputStart => part.type === "tool-input-start"
    ),
    deltas: parts.filter(
      (part): part is ToolInputDelta => part.type === "tool-input-delta"
    ),
    ends: parts.filter(
      (part): part is ToolInputEnd => part.type === "tool-input-end"
    ),
  };
}

export function selectToolCalls(
  parts: readonly LanguageModelV4StreamPart[]
): ToolCall[] {
  return parts.filter((part): part is ToolCall => part.type === "tool-call");
}

export function collectTextDeltas(
  parts: readonly LanguageModelV4StreamPart[]
): string {
  return parts
    .filter((part): part is TextDelta => part.type === "text-delta")
    .map((part) => part.delta)
    .join("");
}

export function requireToolCall(
  parts: readonly LanguageModelV4StreamPart[]
): ToolCall {
  const [toolCall] = selectToolCalls(parts);
  if (toolCall === undefined) {
    throw new TypeError("Tool-call event is required");
  }
  return toolCall;
}

export function parseToolCallObject(toolCall: ToolCall): JSONObject {
  const parsed = parseRJSON(toolCall.input, {
    duplicate: false,
    relaxed: false,
    tolerant: false,
  });
  if (!isJSONObject(parsed) || Array.isArray(parsed)) {
    throw new TypeError("Tool-call input must be an object");
  }
  return parsed;
}

export function runGeneratedJsonRepair(
  fixture: GeneratedJsonRepairFixture
): LanguageModelV4Content[] {
  return fixture.protocol.parseGeneratedText({
    text: fixture.text,
    tools: fixture.tools,
    options: fixture.parserOptions,
  });
}

export async function observeObjectDeltas(
  fixture: ObjectDeltaFixture
): Promise<ObjectDeltaObservation> {
  const parts = await runProtocolTextStream(fixture);
  const timeline = selectToolInputTimeline(parts);
  const toolCall = requireToolCall(parts);
  return {
    parts,
    timeline,
    toolCall,
    joinedInput: timeline.deltas.map((part) => part.delta).join(""),
    text: collectTextDeltas(parts),
  };
}

export function runStreamingEventCase(
  fixture: StreamingEventFixture
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream(fixture);
}

export async function observeLifecycle(
  fixture: LifecycleFixture
): Promise<LifecycleObservation> {
  const parts = await collectProtocolStream(fixture);
  return {
    parts,
    eventTypes: parts.map((part) => part.type),
    timeline: selectToolInputTimeline(parts),
    toolCalls: selectToolCalls(parts),
    text: collectTextDeltas(parts),
  };
}
