import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";

export type ResolvedProtocolToolCall =
  | { ok: true; toolName: string; input: string }
  | { ok: false; error: unknown };

export type ProtocolToolCallResolver = (
  toolCallJson: string,
  tools: LanguageModelV4FunctionTool[]
) => ResolvedProtocolToolCall;
