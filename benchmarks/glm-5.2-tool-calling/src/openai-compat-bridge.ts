import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { benchmarkTransport } from "./benchmark-model-call";
import {
  type BridgeCapture,
  type CapturePolicy,
  isTransientUpstreamError as classifyTransientUpstreamError,
  createOpenAICompatGenerate as createSharedGenerate,
  createStartOpenAICompatBridge,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSIENT_RETRIES,
  DEFAULT_TRANSIENT_RETRY_DELAY_MS,
  type OpenAICompatBridgeOptions as SharedBridgeOptions,
  type RunningOpenAICompatBridge as SharedRunningBridge,
  startSharedOpenAICompatBridge,
} from "./openai-compat-bridge-shared";
import {
  bridgeArmFromModel as parseBridgeArm,
  parseOpenAICompatRequest as parseSharedRequest,
  type OpenAICompatBridgeArm as SharedBridgeArm,
} from "./openai-compat-request-parsing";
import {
  credentialSafeError,
  credentialSafeText,
  ProviderCapture,
} from "./provider-capture";

export type OpenAICompatBridgeArm = SharedBridgeArm;
export interface OpenAICompatBridgeOptions extends SharedBridgeOptions {}
export interface RunningOpenAICompatBridge extends SharedRunningBridge {}

export const bridgeArmFromModel = parseBridgeArm;
export const createOpenAICompatGenerate = createSharedGenerate;
export const isTransientUpstreamError = classifyTransientUpstreamError;
export const parseOpenAICompatRequest = parseSharedRequest;

interface CliCapture extends BridgeCapture {
  readonly fetch: typeof fetch;
  readonly prepare: (resume: boolean) => void;
}

interface CliCaptureOptions {
  readonly arms: ReadonlySet<string>;
  readonly enabled: boolean;
  readonly output: string;
  readonly secretValues: readonly string[];
}

interface CliCaptureConstructor {
  new (options: CliCaptureOptions): CliCapture;
}

export interface CliCapturePolicy extends CapturePolicy {
  readonly create: (options: CliCaptureOptions) => CliCapture;
}

export function createCliCapturePolicy(
  Capture: CliCaptureConstructor,
  safeError: CapturePolicy["safeError"],
  safeText: CapturePolicy["safeText"]
): CliCapturePolicy {
  return {
    create: (options) => new Capture(options),
    safeError,
    safeText,
  };
}

const capturePolicy = createCliCapturePolicy(
  ProviderCapture,
  credentialSafeError,
  credentialSafeText
);

export const startOpenAICompatBridge =
  createStartOpenAICompatBridge(capturePolicy);

function envInteger(name: string, fallback: number, minimum: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < minimum) {
    const requirement = minimum === 0 ? "non-negative" : "positive";
    throw new Error(`${name} must be a ${requirement} integer`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function runOpenAICompatBridgeCli(
  policy: CliCapturePolicy
): Promise<RunningOpenAICompatBridge> {
  const apiKey = requireEnv("FREEROUTER_API_KEY");
  const baseURL =
    process.env.FREEROUTER_BASE_URL ??
    "https://freerouter.minpeter.workers.dev/v1";
  const modelId = process.env.OPENAI_BRIDGE_MODEL ?? "zai-org/glm-5.2";
  const outputRoot = resolve(
    process.env.OPENAI_BRIDGE_OUTPUT ?? "/tmp/glm52-official-bridge"
  );
  const resume = process.env.OPENAI_BRIDGE_RESUME === "1";
  const capture = policy.create({
    arms: new Set(["native", "glm5"]),
    enabled: process.env.OPENAI_BRIDGE_RAW_CAPTURE !== "0",
    output: resolve(outputRoot, "provider-raw.jsonl"),
    secretValues: [apiKey],
  });
  capture.prepare(resume);
  const requestLogOutput = resolve(outputRoot, "requests.jsonl");
  mkdirSync(dirname(requestLogOutput), { recursive: true });
  if (!resume) {
    writeFileSync(requestLogOutput, "");
  }
  const provider = createOpenAICompatible({
    apiKey,
    baseURL,
    fetch: capture.fetch,
    name: "freerouter-official-tool-benchmarks",
  });
  const transport = benchmarkTransport(process.env.OPENAI_BRIDGE_TRANSPORT);
  const bridge = await startSharedOpenAICompatBridge(
    {
      capture,
      host: process.env.OPENAI_BRIDGE_HOST ?? "127.0.0.1",
      maxOutputTokens: envInteger(
        "OPENAI_BRIDGE_MAX_OUTPUT_TOKENS",
        DEFAULT_MAX_OUTPUT_TOKENS,
        1
      ),
      modelFactory: (requestedModel) => provider(requestedModel),
      modelId,
      port: envInteger("OPENAI_BRIDGE_PORT", 8790, 1),
      requestLogOutput,
      secretValues: [apiKey],
      suite: process.env.OPENAI_BRIDGE_SUITE ?? "official-tool-benchmark",
      timeoutMs: envInteger("OPENAI_BRIDGE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1),
      transientRetries: envInteger(
        "OPENAI_BRIDGE_TRANSIENT_RETRIES",
        DEFAULT_TRANSIENT_RETRIES,
        0
      ),
      transientRetryDelayMs: envInteger(
        "OPENAI_BRIDGE_TRANSIENT_RETRY_DELAY_MS",
        DEFAULT_TRANSIENT_RETRY_DELAY_MS,
        0
      ),
      transport,
    },
    policy
  );
  console.log(
    JSON.stringify({
      model: modelId,
      origin: bridge.origin,
      outputRoot,
      status: "listening",
      transport,
    })
  );
  return bridge;
}

export function runOpenAICompatBridgeCliWhenMain(
  moduleUrl: string,
  policy: CliCapturePolicy
): void {
  const [, entrypoint] = process.argv;
  if (entrypoint && moduleUrl === pathToFileURL(entrypoint).href) {
    runOpenAICompatBridgeCli(policy).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}

runOpenAICompatBridgeCliWhenMain(import.meta.url, capturePolicy);
