import type {
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { expect, type Mock, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import type {
  ToolInputSchema,
  ToolInputSchemaCandidate,
  ToolInputSchemaDefinition,
} from "../../../../schema/tool-input-schema";

export const jsonRepairParser = hermesProtocol();

export function makeTool(
  name: string,
  properties: Record<string, ToolInputSchemaDefinition>,
  additionalProperties?: boolean
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: {
      type: "object",
      properties,
      ...(additionalProperties === undefined ? {} : { additionalProperties }),
    } satisfies ToolInputSchema,
  };
}

// Intentionally accepts malformed schemas so tests can exercise runtime rejection.
export function makeSchemaTool(
  name: string,
  inputSchema: ToolInputSchemaCandidate
): LanguageModelV4FunctionTool {
  const tool: LanguageModelV4FunctionTool = {
    type: "function",
    name,
    inputSchema: {},
  };
  Object.defineProperty(tool, "inputSchema", {
    configurable: true,
    enumerable: true,
    value: inputSchema,
  });
  return tool;
}

type ToolCallContent = Extract<LanguageModelV4Content, { type: "tool-call" }>;
type ErrorSpy = Mock<NonNullable<ParserOptions["onError"]>>;

export function expectToolCall(
  output: LanguageModelV4Content[]
): ToolCallContent {
  const tool = output.find(
    (part): part is ToolCallContent => part.type === "tool-call"
  );
  expect(tool?.type).toBe("tool-call");
  if (!tool) {
    throw new Error("Expected tool call");
  }
  return tool;
}

export function expectOptionalToolCallInput(
  output: LanguageModelV4Content[],
  expected: JSONValue
): void {
  const tool = output.find((part) => part.type === "tool-call");
  expect(tool?.type).toBe("tool-call");
  expect(tool?.type === "tool-call" ? JSON.parse(tool.input) : null).toEqual(
    expected
  );
}

export function expectTruthyToolCall(
  output: LanguageModelV4Content[]
): ToolCallContent {
  const tool = output.find(
    (part): part is ToolCallContent => part.type === "tool-call"
  );
  expect(tool).toBeTruthy();
  if (!tool) {
    throw new Error("expected tool call");
  }
  return tool;
}

export function joinedText(output: LanguageModelV4Content[]): string {
  return output
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function parseWithError(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  options: Omit<ParserOptions, "onError"> = {}
): { onError: ErrorSpy; output: LanguageModelV4Content[] } {
  const onError = vi.fn<NonNullable<ParserOptions["onError"]>>();
  const output = jsonRepairParser.parseGeneratedText({
    text,
    tools,
    options: { ...options, onError },
  });
  return { onError, output };
}

export function expectNoToolCall(output: LanguageModelV4Content[]): void {
  expect(output.find((part) => part.type === "tool-call")).toBeUndefined();
}

export function expectRejectedOutput(
  output: LanguageModelV4Content[],
  onError: ErrorSpy
): void {
  expectNoToolCall(output);
  expect(onError).toHaveBeenCalled();
}

export function expectRejectedToolCall(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): void {
  const { onError, output } = parseWithError(text, tools);
  expectRejectedOutput(output, onError);
}

export function parseWithoutThrow(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  onError: NonNullable<ParserOptions["onError"]>
): LanguageModelV4Content[] {
  let output: LanguageModelV4Content[] = [];
  expect(() => {
    output = jsonRepairParser.parseGeneratedText({
      text,
      tools,
      options: { onError },
    });
  }).not.toThrow();
  return output;
}
