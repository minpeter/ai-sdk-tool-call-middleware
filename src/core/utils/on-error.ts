import type {
  ParserOptions,
  ProtocolMetadataJsonValue,
} from "../protocols/protocol-interface";

export type OnErrorFn = NonNullable<ParserOptions["onError"]>;

export type ProviderBoundaryValue =
  | ProtocolMetadataJsonValue
  | OnErrorFn
  | symbol;

export interface ProviderBoundaryRecord {
  readonly [key: string]: ProviderBoundaryValue;
}

interface ProviderOnErrorOptions {
  readonly toolCallMiddleware?: {
    readonly onError?: OnErrorFn;
  };
}

function isProviderBoundaryRecord(
  value: ProviderOnErrorOptions | ProviderBoundaryRecord | ProviderBoundaryValue
): value is ProviderBoundaryRecord {
  return typeof value === "object" && value !== null;
}

export function extractOnErrorOption(
  providerOptions?: ProviderOnErrorOptions | ProviderBoundaryValue
): { readonly onError: OnErrorFn } | undefined {
  if (!isProviderBoundaryRecord(providerOptions)) {
    return;
  }
  const middlewareOptions = providerOptions.toolCallMiddleware;
  if (!isProviderBoundaryRecord(middlewareOptions)) {
    return;
  }
  const { onError } = middlewareOptions;
  return typeof onError === "function" ? { onError } : undefined;
}
