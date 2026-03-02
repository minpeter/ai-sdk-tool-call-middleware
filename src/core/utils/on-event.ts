export type ToolCallMiddlewareEventType =
  | "transform-params.start"
  | "transform-params.complete"
  | "generate.start"
  | "generate.tool-choice"
  | "generate.complete"
  | "stream.start"
  | "stream.tool-choice"
  | "stream.tool-call"
  | "stream.finish";

export interface ToolCallMiddlewareEvent {
  metadata?: Record<string, unknown>;
  type: ToolCallMiddlewareEventType;
}

export type OnEventFn = (event: ToolCallMiddlewareEvent) => void;

interface ProviderOptionsWithOnEvent {
  toolCallMiddleware?: {
    onEvent?: OnEventFn;
  };
}

export function extractOnEventOption(
  providerOptions?: unknown
): { onEvent?: OnEventFn } | undefined {
  if (providerOptions && typeof providerOptions === "object") {
    const onEvent = (providerOptions as ProviderOptionsWithOnEvent)
      .toolCallMiddleware?.onEvent;
    return onEvent ? { onEvent } : undefined;
  }
  return;
}

export function emitMiddlewareEvent(
  onEvent: OnEventFn | undefined,
  event: ToolCallMiddlewareEvent
): void {
  if (!onEvent) {
    return;
  }

  try {
    onEvent(event);
  } catch {
    // Ignore observer-side failures to keep middleware path stable.
  }
}
