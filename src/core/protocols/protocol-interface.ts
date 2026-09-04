import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";

/**
 * Options for parsing tool calls and handling errors
 */
export type ProtocolMetadataJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Error
  | readonly ProtocolMetadataJsonValue[]
  | ProtocolMetadataJsonObject;

export interface ProtocolMetadataJsonObject {
  readonly [key: string]: ProtocolMetadataJsonValue;
}

export type ProtocolMetadataValue = ProtocolMetadataJsonValue;
export type ProtocolMetadata = ProtocolMetadataJsonObject;
export type ProtocolError = ProtocolMetadataJsonValue;

export interface ParserOptions {
  /**
   * When true, stream parsers may emit malformed raw tool-call text as
   * `text-delta` fallback on parse failure. Defaults to false to avoid leaking
   * protocol/internal markup to end users.
   */
  emitRawToolCallTextOnError?: boolean;
  onError?: (message: string, metadata?: ProtocolMetadata) => void;
}

export type ResolvedProtocolToolCall =
  | { ok: true; toolName: string; input: string }
  | { ok: false; error: ProtocolError };

export type ProtocolToolCallResolver = (
  toolCallJson: string,
  tools: LanguageModelV4FunctionTool[]
) => ResolvedProtocolToolCall;

export interface TCMProtocol {
  /**
   * Return false when protocol parsing has terminally consumed this text and
   * generic JSON recovery must not reinterpret its contents as tool calls.
   */
  allowsGeneratedTextJsonRecovery?: (text: string) => boolean;

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

export type TCMCoreProtocol = TCMProtocol;

export function isProtocolFactory(
  protocol: TCMProtocol | (() => TCMProtocol)
): protocol is () => TCMProtocol {
  return typeof protocol === "function";
}
