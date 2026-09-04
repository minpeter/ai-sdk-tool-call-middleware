import type { JSONSchema7, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { expect, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const protocol = hermesProtocol();

export interface StreamRepairResult {
  readonly onError: ReturnType<typeof vi.fn>;
  readonly parts: LanguageModelV4StreamPart[];
}

export async function runWriteStreamRepair(
  text: string,
  inputSchema: JSONSchema7,
  toolName = "write"
): Promise<StreamRepairResult> {
  const onError = vi.fn();
  const parts = await runProtocolTextStream({
    chunks: [text],
    id: "1",
    protocol,
    tools: [{ type: "function", name: toolName, inputSchema }],
    parserOptions: { onError },
  });
  return { onError, parts };
}

export function expectRejectedStreamRepair(result: StreamRepairResult): void {
  expect(selectToolCalls(result.parts)).toEqual([]);
  expect(selectToolInputTimeline(result.parts)).toEqual({
    starts: [],
    deltas: [],
    ends: [],
  });
  expect(result.onError).toHaveBeenCalled();
}

export function expectAcceptedStreamObject(
  result: StreamRepairResult,
  expected: object,
  requireTimeline = false
): void {
  const timeline = selectToolInputTimeline(result.parts);
  expect(parseToolCallObject(requireToolCall(result.parts))).toEqual(expected);
  if (requireTimeline) {
    expect(timeline.starts.length).toBeGreaterThan(0);
    expect(timeline.deltas.length).toBeGreaterThan(0);
    expect(timeline.ends.length).toBeGreaterThan(0);
  }
  expect(result.onError).not.toHaveBeenCalled();
}
