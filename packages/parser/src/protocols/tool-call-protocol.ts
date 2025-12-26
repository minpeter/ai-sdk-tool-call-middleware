import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";

/**
 * ToolCallProtocol
 *
 * A pluggable strategy that defines how tools are surfaced to a model, how
 * tool calls are rendered into provider-facing text, and how model output is
 * parsed back into the AI SDK v2 content/stream primitives.
 *
 * Implementations can choose any wire format (e.g. XML, JSON-with-tags, etc.)
 * as long as they respect the contract below:
 * - Static formatting helpers (`formatTools`, `formatToolCall`, `formatToolResponse`)
 *   are used to construct strings that the model will read.
 * - Parsing helpers (`parseGeneratedText`, `createStreamParser`) must convert
 *   model output back into structured `LanguageModelV3Content` parts, emitting
 *   `text` for regular content and `tool-call` for detected tool invocations.
 */
export interface ToolCallProtocol {
  /**
   * Produces a provider-facing string that describes all available tools.
   *
   * Typical usage is to serialize each tool's `name`, `description`, and
   * JSON schema and inject that text into a system prompt using the supplied
   * `toolSystemPromptTemplate`.
   *
   * Implementations should be resilient to empty inputs.
   *
   * @param tools List of tools that can be invoked by the model.
   * @param toolSystemPromptTemplate Function that receives the serialized
   *                                 tools and returns the final prompt text.
   * @returns A string to be embedded into the model's system prompt.
   */
  formatTools({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV3FunctionTool[];
    toolSystemPromptTemplate: (tools: string) => string;
  }): string;

  /**
   * Renders a single tool invocation into provider-facing text.
   *
   * Implementations may accept `toolCall.input` as a JSON string or as an
   * object (some runtimes normalize prior to calling). The result should be a
   * string that the model can understand and that the paired parser can later
   * recognize and recover as a `tool-call`.
   *
   * @param toolCall The tool call to format for the model.
   * @returns A textual representation of the tool call (e.g., an XML element).
   */
  formatToolCall(toolCall: LanguageModelV3ToolCall): string;

  /**
   * Formats a tool result payload so the model can consume it as plain text.
   *
   * This is commonly used to echo tool outputs back to the model in a format
   * symmetrical to `formatToolCall`.
   *
   * @param toolResult The result part produced after executing a tool.
   * @returns Textual representation of the tool result for the model.
   */
  formatToolResponse(toolResult: LanguageModelV3ToolResultPart): string;

  /**
   * Parses a fully generated text (non-streaming) response from the model and
   * converts it into a sequence of `LanguageModelV3Content` parts.
   *
   * Implementations should:
   * - Detect tool-call segments addressed to known `tools` and emit
   *   `{ type: "tool-call", toolName, input }` parts.
   * - Emit `{ type: "text", text }` parts for any non-tool segments.
   * - Call `options.onError` and fall back to emitting the original text if a
   *   segment cannot be parsed into a valid tool call.
   *
   * @param text The model output to parse.
   * @param tools The list of tools that may be invoked.
   * @param options Optional error callback for non-fatal parsing issues.
   * @returns A list of structured content parts derived from the text.
   */
  parseGeneratedText({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: LanguageModelV3FunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): LanguageModelV3Content[];

  /**
   * Creates a TransformStream that converts streaming model deltas
   * (`LanguageModelV3StreamPart`) into a normalized sequence of stream parts,
   * including `text-start`/`text-delta`/`text-end` and `tool-call` events.
   *
   * The stream parser should:
   * - Buffer text until a complete tool-call segment can be recognized, then
   *   emit a `tool-call` part and properly close/open text segments around it.
   * - Be robust to partial/incomplete fragments commonly seen in streaming.
   * - Invoke `options.onError` and pass through the original text when a
   *   segment cannot be parsed into a valid tool call.
   *
   * @param tools The list of tools that may be invoked by the model.
   * @param options Optional error callback for non-fatal streaming issues.
   * @returns A TransformStream that accepts and emits `LanguageModelV3StreamPart`s.
   */
  createStreamParser({
    tools,
    options,
  }: {
    tools: LanguageModelV3FunctionTool[];
    options?: {
      onError?: (message: string, metadata?: Record<string, unknown>) => void;
    };
  }): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>;

  /**
   * Optionally returns the exact substrings that would be parsed as tool-calls
   * from the provided text for this protocol.
   * Used for debug logging in parse mode.
   */
  extractToolCallSegments?: ({
    text,
    tools,
  }: {
    text: string;
    tools: LanguageModelV3FunctionTool[];
  }) => string[];
}

export function isProtocolFactory(
  protocol: ToolCallProtocol | (() => ToolCallProtocol)
): protocol is () => ToolCallProtocol {
  return typeof protocol === "function";
}
