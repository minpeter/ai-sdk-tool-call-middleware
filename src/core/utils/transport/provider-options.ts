import type {
  LanguageModelV4FunctionTool,
  SharedV4ProviderOptions,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { ToolCallMiddlewareDebugSummary } from "../diagnostics/debug-summary";
import { extractOnErrorOption, type OnErrorFn } from "../diagnostics/on-error";
import {
  type DecodeOriginalToolsOptions,
  decodeOriginalTools as decodeOriginalToolsImpl,
  type EncodedOriginalTool,
  encodeOriginalTools as encodeOriginalToolsImpl,
  lookupCachedDecodedOriginalTools,
} from "./original-tools-cache";

export type { ToolCallMiddlewareDebugSummary } from "../diagnostics/debug-summary";

/**
 * Caller-facing configuration supplied via `providerOptions.toolCallMiddleware`.
 */
export interface ToolCallMiddlewareUserOptions {
  debugSummary?: ToolCallMiddlewareDebugSummary;
  emitRawToolCallTextOnError?: boolean;
  onError?: OnErrorFn;
}

/**
 * Internal middleware transport state written by `transformParams` and consumed
 * by `wrapGenerate` / `wrapStream`. Isolated under `_internal` so user options
 * and internal pipeline metadata never share the same key space.
 *
 * @internal
 */
export interface ToolCallMiddlewareInternalState {
  droppedProviderTools?: string[];
  originalTools?: EncodedOriginalTool[];
  toolChoice?: { type: string; toolName?: string };
}

export interface ToolCallMiddlewareProviderOptions {
  toolCallMiddleware?: ToolCallMiddlewareUserOptions & {
    /** @internal */
    _internal?: ToolCallMiddlewareInternalState;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getToolCallMiddlewareOptions(
  providerOptions?: unknown
): Record<string, unknown> {
  if (!isRecord(providerOptions)) {
    return {};
  }

  const { toolCallMiddleware } = providerOptions;
  if (!isRecord(toolCallMiddleware)) {
    return {};
  }

  return toolCallMiddleware;
}

/** @internal */
export function extractToolCallParserOptions(providerOptions?: unknown): {
  emitRawToolCallTextOnError?: boolean;
  onError?: OnErrorFn;
} {
  const middlewareOptions = getToolCallMiddlewareOptions(providerOptions);
  const onErrorOptions = extractOnErrorOption(providerOptions);
  const parserOptions: {
    emitRawToolCallTextOnError?: boolean;
    onError?: OnErrorFn;
  } = {};

  if (onErrorOptions?.onError) {
    parserOptions.onError = onErrorOptions.onError;
  }
  if (typeof middlewareOptions.emitRawToolCallTextOnError === "boolean") {
    parserOptions.emitRawToolCallTextOnError =
      middlewareOptions.emitRawToolCallTextOnError;
  }

  return parserOptions;
}

/** @internal */
export function stripToolCallMiddlewareProviderOptions<
  T extends { providerOptions?: unknown },
>(params: T): T {
  if (!isRecord(params.providerOptions)) {
    return params;
  }
  if (!Object.hasOwn(params.providerOptions, "toolCallMiddleware")) {
    return params;
  }

  const { toolCallMiddleware: _removed, ...restProviderOptions } =
    params.providerOptions;

  return {
    ...params,
    providerOptions:
      Object.keys(restProviderOptions).length > 0
        ? restProviderOptions
        : undefined,
  };
}

/** @internal */
export function getMiddlewareInternalState(
  providerOptions?: unknown
): ToolCallMiddlewareInternalState {
  const middlewareOptions = getToolCallMiddlewareOptions(providerOptions);
  const internal = middlewareOptions._internal;
  if (!isRecord(internal)) {
    return {};
  }
  return internal as ToolCallMiddlewareInternalState;
}

export function mergeToolCallMiddlewareOptions(
  providerOptions: unknown,
  overrides: Record<string, unknown>
): SharedV4ProviderOptions {
  return {
    ...(isRecord(providerOptions) ? providerOptions : {}),
    toolCallMiddleware: {
      ...getToolCallMiddlewareOptions(providerOptions),
      ...overrides,
    },
  } as SharedV4ProviderOptions;
}

/**
 * Replace `_internal` wholesale for the current request so stale internal
 * metadata from an earlier step or reused `providerOptions` never leaks across
 * requests.
 *
 * @internal
 */
export function setMiddlewareInternalState(
  providerOptions: unknown,
  state: ToolCallMiddlewareInternalState
): SharedV4ProviderOptions {
  return mergeToolCallMiddlewareOptions(providerOptions, {
    _internal: { ...state },
  });
}

/** @internal */
export function mergeMiddlewareInternalState(
  providerOptions: unknown,
  overrides: Partial<ToolCallMiddlewareInternalState>
): SharedV4ProviderOptions {
  return mergeToolCallMiddlewareOptions(providerOptions, {
    _internal: {
      ...getMiddlewareInternalState(providerOptions),
      ...overrides,
    },
  });
}

/**
 * Names of provider tools dropped by transformParams, so the wrap handlers
 * can surface a spec warning instead of discarding them silently.
 */
export function getDroppedProviderTools(providerOptions: unknown): string[] {
  const dropped = getMiddlewareInternalState(providerOptions)
    .droppedProviderTools as unknown;
  if (!Array.isArray(dropped)) {
    return [];
  }
  return dropped.filter((name): name is string => typeof name === "string");
}

/**
 * Prompt-based tool calling can only express function tools; provider tools
 * are dropped in transformParams and surfaced as spec warnings by wrap handlers.
 *
 * @internal
 */
export function createDroppedProviderToolWarnings(
  providerOptions: unknown
): SharedV4Warning[] {
  return getDroppedProviderTools(providerOptions).map(
    (name): SharedV4Warning => ({
      type: "unsupported",
      feature: `provider tool ${name}`,
      details:
        "Prompt-based tool-call middleware only supports function tools; the provider tool was removed from the request.",
    })
  );
}

/** @internal */
export function getToolChoiceExpectedToolName(
  providerOptions: unknown
): string | undefined {
  const { toolChoice } = getMiddlewareInternalState(providerOptions);
  return typeof toolChoice?.toolName === "string"
    ? toolChoice.toolName
    : undefined;
}

export function encodeOriginalTools(
  tools: LanguageModelV4FunctionTool[] | undefined
): Array<{ name: string; inputSchema: string }> {
  return encodeOriginalToolsImpl(tools);
}

export function decodeOriginalTools(
  originalTools: EncodedOriginalTool[] | undefined,
  options?: DecodeOriginalToolsOptions
): LanguageModelV4FunctionTool[] {
  return decodeOriginalToolsImpl(originalTools, options);
}

export const originalToolsSchema = {
  encode: encodeOriginalTools,
  decode: decodeOriginalTools,
};

/** @internal */
export function decodeOriginalToolsForMiddleware(
  providerOptions: ToolCallMiddlewareProviderOptions | undefined,
  options?: DecodeOriginalToolsOptions
): LanguageModelV4FunctionTool[] {
  return lookupCachedDecodedOriginalTools(
    getMiddlewareInternalState(providerOptions).originalTools,
    options
  );
}

export function decodeOriginalToolsFromProviderOptions(
  providerOptions: ToolCallMiddlewareProviderOptions | undefined,
  options?: DecodeOriginalToolsOptions
): LanguageModelV4FunctionTool[] {
  return decodeOriginalTools(
    getMiddlewareInternalState(providerOptions).originalTools,
    options
  );
}

export function extractToolNamesFromOriginalTools(
  originalTools:
    | Array<{
        name: string;
        inputSchema: string; // stringified JSONSchema7
      }>
    | undefined
): string[] {
  return originalTools?.map((t) => t.name) || [];
}

export function isToolChoiceActive(params: {
  providerOptions?: ToolCallMiddlewareProviderOptions;
}): boolean {
  const { toolChoice } = getMiddlewareInternalState(params.providerOptions);
  return !!(
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice.type === "tool" || toolChoice.type === "required")
  );
}

export function isToolChoiceNone(params: {
  providerOptions?: ToolCallMiddlewareProviderOptions;
}): boolean {
  return (
    getMiddlewareInternalState(params.providerOptions).toolChoice?.type ===
    "none"
  );
}
