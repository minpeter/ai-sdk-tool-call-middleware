export interface TCMCoreToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
}

export interface TCMCoreToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

export interface TCMCoreTextPart {
  type: "text";
  text: string;
}

export type TCMCoreContentPart =
  | TCMCoreTextPart
  | (TCMCoreToolCall & { type: "tool-call" });

export type TCMCoreStreamPart =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; textDelta: string; delta?: string; id?: string }
  | { type: "text-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | {
      type: "tool-call-delta";
      toolCallId: string;
      toolName: string;
      argsTextDelta: string;
    }
  | { type: "error"; error: unknown }
  | {
      type: "finish";
      finishReason: string;
      usage?: { promptTokens: number; completionTokens: number };
    };

export interface TCMToolInputExample {
  input: Record<string, unknown>;
}

export interface TCMToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  inputExamples?: TCMToolInputExample[];
}

export interface TCMCoreFunctionTool {
  type: "function";
  name: string;
  description?: string;
  inputSchema: unknown;
  inputExamples?: TCMToolInputExample[];
}
