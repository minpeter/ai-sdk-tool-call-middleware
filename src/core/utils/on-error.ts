import type { ParserOptions } from "../protocols/protocol-interface";

export type ProviderBoundaryValue =
  | object
  | CallableFunction
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined;

export type ProviderBoundaryRecord = Record<string, ProviderBoundaryValue>;

export type OnErrorFn = NonNullable<ParserOptions["onError"]>;

export type OnErrorValue =
  | OnErrorFn
  | Exclude<ProviderBoundaryValue, null | undefined | false>;

function isProviderBoundaryRecord<Value>(
  value: Value
): value is Value & ProviderBoundaryRecord {
  return typeof value === "object" && value !== null;
}

export function extractOnErrorOption(
  providerOptions?:
    | {
        readonly toolCallMiddleware?: {
          readonly onError?: OnErrorFn;
          readonly toolChoice?: { readonly type: string };
        };
      }
    | {
        readonly toolCallMiddleware?: {
          readonly toolChoice?: { readonly type: string };
        };
      }
): { readonly onError: OnErrorFn } | undefined;
export function extractOnErrorOption<ProviderOptions>(
  providerOptions?: ProviderOptions
): { readonly onError: OnErrorValue } | undefined;
export function extractOnErrorOption<ProviderOptions>(
  providerOptions?: ProviderOptions
): { readonly onError: OnErrorValue } | undefined {
  if (!isProviderBoundaryRecord(providerOptions)) {
    return;
  }
  const middlewareOptions = providerOptions.toolCallMiddleware;
  if (!isProviderBoundaryRecord(middlewareOptions)) {
    return;
  }
  const { onError } = middlewareOptions;
  return onError ? { onError } : undefined;
}
