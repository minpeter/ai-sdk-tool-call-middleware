import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";

export const glm5Tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "ping",
    description: "Return service health.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get-weather",
    description: "Read the weather.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        "user-id": { type: "string" },
      },
      required: ["city"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "typed_action",
    description: "Exercise every supported argument type.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        truthy_text: { type: "string" },
        nullable_text: { type: "string" },
        count: { type: "integer" },
        enabled: { type: "boolean" },
        ratio: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        config: {
          type: "object",
          properties: {
            mode: { type: "string" },
            enabled: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "echo",
    description: "Echo a string.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "aggregate",
    description: "Aggregate structured values.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "integer" } },
        config: {
          type: "object",
          properties: {
            mode: { type: "string" },
            enabled: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["items", "config"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "open_action",
    description: "Accept arbitrary safe arguments.",
    inputSchema: { type: "object" },
  },
];

export interface NormalizedToolCall {
  input: unknown;
  toolName: string;
}

export function normalizeContentToolCalls(
  parts: LanguageModelV4Content[]
): NormalizedToolCall[] {
  return parts
    .filter(
      (part): part is Extract<LanguageModelV4Content, { type: "tool-call" }> =>
        part.type === "tool-call"
    )
    .map((part) => ({
      input: JSON.parse(part.input) as unknown,
      toolName: part.toolName,
    }));
}

export function normalizeStreamToolCalls(
  parts: LanguageModelV4StreamPart[]
): NormalizedToolCall[] {
  return parts
    .filter(
      (
        part
      ): part is Extract<LanguageModelV4StreamPart, { type: "tool-call" }> =>
        part.type === "tool-call"
    )
    .map((part) => ({
      input: JSON.parse(part.input) as unknown,
      toolName: part.toolName,
    }));
}

export function toolCallInput(
  parts: LanguageModelV4Content[],
  index = 0
): unknown {
  const calls = normalizeContentToolCalls(parts);
  const call = calls[index];
  if (!call) {
    throw new Error(`Expected tool call at index ${index}`);
  }
  return call.input;
}
