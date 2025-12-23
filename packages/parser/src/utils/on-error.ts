export type OnErrorFn = (
  message: string,
  metadata?: Record<string, unknown>
) => void;

interface ProviderOptionsWithOnError {
  toolCallMiddleware?: {
    onError?: OnErrorFn;
  };
}

export function extractOnErrorOption(
  providerOptions?: unknown
): { onError?: OnErrorFn } | undefined {
  if (providerOptions && typeof providerOptions === "object") {
    const onError = (providerOptions as ProviderOptionsWithOnError)
      .toolCallMiddleware?.onError;
    return onError ? { onError } : undefined;
  }
  return;
}
