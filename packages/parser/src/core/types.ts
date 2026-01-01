export interface CoreToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
}

export interface CoreToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

export interface CoreTextPart {
  type: "text";
  text: string;
}

export type CoreContentPart =
  | CoreTextPart
  | (CoreToolCall & { type: "tool-call" });

export type CoreStreamPart =
  | { type: "text-delta"; textDelta: string; id?: string }
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

export interface CoreFunctionTool {
  type: "function";
  name: string;
  description?: string;
  inputSchema: unknown;
}
