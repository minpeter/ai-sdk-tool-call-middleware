import type { JSONValue } from "@ai-sdk/provider";
import { expect } from "vitest";
import {
  expectRejectedOutput,
  expectToolCall,
  makeSchemaTool,
  parseWithError,
} from "./json-repair-harness";

export type GeneratedRepairResult = ReturnType<typeof parseWithError>;

export function runGeneratedRepair(
  text: string,
  toolName: string,
  inputSchema: JSONValue
): GeneratedRepairResult {
  return parseWithError(text, [makeSchemaTool(toolName, inputSchema)]);
}

export function requireGeneratedToolCall(
  result: GeneratedRepairResult
): ReturnType<typeof expectToolCall> {
  return expectToolCall(result.output);
}

export function expectRejectedGeneratedRepair(
  result: GeneratedRepairResult
): void {
  expectRejectedOutput(result.output, result.onError);
}

export function expectAcceptedGeneratedInput(
  result: GeneratedRepairResult,
  expected: JSONValue
): void {
  expect(JSON.parse(requireGeneratedToolCall(result).input)).toEqual(expected);
  expect(result.onError).not.toHaveBeenCalled();
}
