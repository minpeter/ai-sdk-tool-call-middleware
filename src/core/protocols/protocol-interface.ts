import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";

export type {
  ProtocolToolCallResolver,
  ResolvedProtocolToolCall,
} from "../../shared/tool-call-resolver";

/**
 * Options for parsing tool calls and handling errors
 */
export interface ParserOptions {
  /**
   * When true, stream parsers may emit malformed raw tool-call text as
   * `text-delta` fallback on parse failure. Defaults to false to avoid leaking
   * protocol/internal markup to end users.
   */
  emitRawToolCallTextOnError?: boolean;
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface TCMProtocol {
  /**
   * Return false when protocol parsing has terminally consumed this text and
   * generic fallback recovery must not reinterpret its contents as tool calls.
   */
  allowsFallbackRecovery?: (text: string) => boolean;

  createStreamParser: ({
    tools,
    options,
  }: {
    tools: LanguageModelV4FunctionTool[];
    options?: ParserOptions;
  }) => TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>;

  extractToolCallSegments?: ({
    text,
    tools,
  }: {
    text: string;
    tools: LanguageModelV4FunctionTool[];
  }) => string[];

  formatToolCall: (toolCall: LanguageModelV4ToolCall) => string;
  formatTools: ({
    tools,
    toolSystemPromptTemplate,
  }: {
    tools: LanguageModelV4FunctionTool[];
    toolSystemPromptTemplate: (tools: LanguageModelV4FunctionTool[]) => string;
  }) => string;

  /**
   * Optional O(n) fast-path predicate returning true only when `text` is
   * provably plain text containing neither protocol markup nor recoverable
   * fallback tool-call candidates.
   *
   * `parseGeneratedText` always runs first (protocols may short-circuit
   * internally with the same predicate); when `parseGeneratedText` emits no
   * tool calls and this predicate returns true, generic fallback recovery is
   * skipped.
   */
  isDefinitelyPlainGeneratedText?: (text: string) => boolean;

  parseGeneratedText: ({
    text,
    tools,
    options,
  }: {
    text: string;
    tools: LanguageModelV4FunctionTool[];
    options?: ParserOptions;
  }) => LanguageModelV4Content[];
}

export function isProtocolFactory(
  protocol: TCMProtocol | (() => TCMProtocol)
): protocol is () => TCMProtocol {
  return typeof protocol === "function";
}
