import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PROVIDER_CAPTURE_FORMAT_VERSION = 1;

export interface CapturedFunctionTool {
  description?: string;
  inputSchema: unknown;
  name: string;
  originalName?: string;
}

export interface ProviderCaptureContext {
  arm: string;
  attempt: number;
  caseId?: string;
  category?: string;
  jobKey: string;
  language?: string;
  /**
   * Benchmark suite identifier.  This used to be limited to the three
   * hand-written pilot runners.  The official full-suite bridge is shared by
   * BFCL, ACEBench, MCPMark, tau3, and any additional official harness, so the
   * capture format must preserve their suite names without losing type safety
   * at every new adapter.
   */
  suite: string;
  taskId?: string;
  tools: CapturedFunctionTool[];
  transport: "generate" | "stream";
  trial: number;
  turn?: number;
}

export interface ProviderCaptureRecord {
  capturedAt: string;
  captureId: string;
  context: ProviderCaptureContext;
  formatVersion: typeof PROVIDER_CAPTURE_FORMAT_VERSION;
  request: {
    body: string | null;
    headers: Record<string, string>;
    method: string;
    url: string;
  };
  response?: {
    body: string;
    headers: Record<string, string>;
    status: number;
    statusText: string;
  };
  transportError?: string;
}

interface ActiveCapture {
  context: ProviderCaptureContext;
  requestIds: string[];
}

interface ProviderCaptureOptions {
  arms: ReadonlySet<string>;
  enabled: boolean;
  fetchImpl?: typeof fetch;
  output: string;
  secretValues?: readonly string[];
}

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "user-agent",
]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "cf-ray",
  "content-length",
  "content-type",
  "date",
  "server",
  "x-request-id",
]);
const SECRET_QUERY_NAME =
  /(?:api[_-]?key|authorization|credential|password|secret|token)/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/giu;
const BEARER_CREDENTIAL = /\bbearer\s+[^\s,"'<>}]+/giu;
const LABELED_CREDENTIAL =
  /((?:api[_-]?key|authorization|credential|password|secret|token)[^\s:=,"']{0,32}\s*[:=]\s*)([^\s,"'<>}]+)/giu;
const JSON_CREDENTIAL =
  /("(?:[^"\\]|\\.)*(?:api[_-]?key|authorization|credential|password|secret|token)(?:[^"\\]|\\.)*"\s*:\s*")((?:[^"\\]|\\.)*)(")/giu;

function redactExactSecrets(
  input: string,
  secretValues: readonly string[]
): string {
  return secretValues
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length)
    .reduce((output, secret) => output.replaceAll(secret, "[REDACTED]"), input);
}

export function credentialSafeText(
  input: string,
  secretValues: readonly string[] = []
): string {
  const structurallyRedacted = input
    .replace(URL_IN_TEXT, (candidate) => {
      try {
        return sanitizeUrl(candidate);
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(JSON_CREDENTIAL, "$1[REDACTED]$3")
    .replace(BEARER_CREDENTIAL, "Bearer [REDACTED]")
    .replace(LABELED_CREDENTIAL, "$1[REDACTED]");
  return redactExactSecrets(structurallyRedacted, secretValues);
}

export function credentialSafeError(
  error: unknown,
  secretValues: readonly string[] = []
): string {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 4000)
      : String(error).slice(0, 4000);
  return credentialSafeText(detail, secretValues);
}

function sanitizeUrl(input: RequestInfo | URL): string {
  let raw: string;
  if (input instanceof Request) {
    raw = input.url;
  } else if (input instanceof URL) {
    raw = input.toString();
  } else {
    raw = String(input);
  }
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_NAME.test(name)) {
      url.searchParams.delete(name);
    }
  }
  url.hash = "";
  return url.toString();
}

export function credentialFreeUrl(input: string): string {
  return sanitizeUrl(input);
}

function sanitizedHeaders(
  input: HeadersInit | undefined,
  allowlist: ReadonlySet<string>
): Record<string, string> {
  if (!input) {
    return {};
  }
  return Object.fromEntries(
    [...new Headers(input).entries()].filter(([name]) => allowlist.has(name))
  );
}

function requestHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Record<string, string> {
  const headers = new Headers(input instanceof Request ? input.headers : {});
  if (init?.headers) {
    for (const [name, value] of new Headers(init.headers)) {
      headers.set(name, value);
    }
  }
  return sanitizedHeaders(headers, REQUEST_HEADER_ALLOWLIST);
}

function requestBody(init: RequestInit | undefined): string | null {
  const body = init?.body;
  if (body === undefined || body === null) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return `[${body.constructor.name}]`;
}

export function captureArmsFromEnv(value?: string): ReadonlySet<string> {
  const arms = (value ?? "native,glm5")
    .split(",")
    .map((arm) => arm.trim())
    .filter(Boolean);
  return new Set(arms);
}

export class ProviderCapture {
  readonly fetch: typeof fetch;
  readonly output: string;

  private readonly arms: ReadonlySet<string>;
  private readonly enabled: boolean;
  private readonly pending = new Set<Promise<void>>();
  private readonly secretValues: readonly string[];
  private readonly storage = new AsyncLocalStorage<ActiveCapture>();

  constructor(options: ProviderCaptureOptions) {
    this.arms = options.arms;
    this.enabled = options.enabled;
    this.output = resolve(options.output);
    this.secretValues = options.secretValues ?? [];
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.fetch = async (input, init) => {
      const active = this.storage.getStore();
      if (!(this.enabled && active && this.arms.has(active.context.arm))) {
        return fetchImpl(input, init);
      }

      const captureId = randomUUID();
      active.requestIds.push(captureId);
      const base: Omit<ProviderCaptureRecord, "response" | "transportError"> = {
        captureId,
        capturedAt: new Date().toISOString(),
        context: active.context,
        formatVersion: PROVIDER_CAPTURE_FORMAT_VERSION,
        request: {
          body:
            requestBody(init) === null
              ? null
              : credentialSafeText(requestBody(init) ?? "", this.secretValues),
          headers: Object.fromEntries(
            Object.entries(requestHeaders(input, init)).map(([name, value]) => [
              name,
              credentialSafeText(value, this.secretValues),
            ])
          ),
          method:
            init?.method ?? (input instanceof Request ? input.method : "GET"),
          url: credentialSafeText(sanitizeUrl(input), this.secretValues),
        },
      };

      try {
        const response = await fetchImpl(input, init);
        const clone = response.clone();
        this.track(
          clone
            .text()
            .then((body) => {
              this.append({
                ...base,
                response: {
                  body: credentialSafeText(body, this.secretValues),
                  headers: sanitizedHeaders(
                    clone.headers,
                    RESPONSE_HEADER_ALLOWLIST
                  ),
                  status: clone.status,
                  statusText: credentialSafeText(
                    clone.statusText,
                    this.secretValues
                  ),
                },
              });
            })
            .catch((error) => {
              this.append({
                ...base,
                transportError: credentialSafeError(error, this.secretValues),
              });
            })
        );
        return response;
      } catch (error) {
        this.append({
          ...base,
          transportError: credentialSafeError(error, this.secretValues),
        });
        throw error;
      }
    };
  }

  prepare(resume: boolean, requirePriorCapture = false): void {
    if (!this.enabled) {
      return;
    }
    mkdirSync(dirname(this.output), { recursive: true });
    if (resume && requirePriorCapture && !existsSync(this.output)) {
      throw new Error(
        `Cannot resume linked results: prior provider capture is missing at ${this.output}`
      );
    }
    if (!resume) {
      writeFileSync(this.output, "");
    }
  }

  run<T>(
    context: ProviderCaptureContext,
    requestIds: string[],
    operation: () => T
  ): T {
    return this.storage.run({ context, requestIds }, operation);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  metadata(): {
    arms: string[];
    enabled: boolean;
    formatVersion: number;
    output: string | null;
  } {
    return {
      arms: [...this.arms],
      enabled: this.enabled,
      formatVersion: PROVIDER_CAPTURE_FORMAT_VERSION,
      output: this.enabled ? this.output : null,
    };
  }

  private append(record: ProviderCaptureRecord): void {
    appendFileSync(this.output, `${JSON.stringify(record)}\n`);
  }

  private track(promise: Promise<void>): void {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise));
  }
}
