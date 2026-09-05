import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { expect } from "vitest";

type ToolInputDelta = Extract<
  LanguageModelV4StreamPart,
  { type: "tool-input-delta" }
>;

export function createRecordingController(
  parts: LanguageModelV4StreamPart[]
): TransformStreamDefaultController<LanguageModelV4StreamPart> {
  return {
    desiredSize: null,
    enqueue(part: LanguageModelV4StreamPart) {
      parts.push(part);
    },
    error() {
      throw new Error("controller error is not expected in this test");
    },
    terminate() {
      throw new Error("controller termination is not expected in this test");
    },
  };
}

export function selectToolInputDeltas(
  parts: readonly LanguageModelV4StreamPart[]
): ToolInputDelta[] {
  return parts.filter(
    (part): part is ToolInputDelta => part.type === "tool-input-delta"
  );
}

export function expectSingleToolInputDelta(
  parts: readonly LanguageModelV4StreamPart[],
  expected: string
): void {
  const deltas = selectToolInputDeltas(parts);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.delta).toBe(expected);
}
