import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  BridgeInputError,
  createTau2BridgeGenerate as createBridgeGenerate,
  parseTau2BridgeRequest as parseBridgeRequest,
  type Tau2BridgeRequest as RoutingRequest,
  type Tau2BridgeResponse as RoutingResponse,
} from "./tau2-bridge-routing";

export interface Tau2BridgeRequest extends RoutingRequest {}

export interface Tau2BridgeResponse extends RoutingResponse {}

export interface Tau2BridgeOptions {
  bodyLimitBytes?: number;
  host?: string;
  maxOutputTokens?: number;
  modelFactory: (modelId: string) => LanguageModelV4;
  modelId: string;
  port?: number;
  timeoutMs?: number;
}

export interface RunningTau2Bridge {
  close: () => Promise<void>;
  host: string;
  origin: string;
  port: number;
}

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export const parseTau2BridgeRequest = parseBridgeRequest;

export function createTau2BridgeGenerate(
  options: Pick<
    Required<Tau2BridgeOptions>,
    "maxOutputTokens" | "modelFactory" | "modelId" | "timeoutMs"
  >
) {
  return createBridgeGenerate(options);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

async function readJsonBody(
  request: IncomingMessage,
  limitBytes: number
): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limitBytes) {
      throw new BridgeInputError("request body is too large", { status: 413 });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new BridgeInputError("request body is empty");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new BridgeInputError("request body is not valid JSON", {
      cause: error,
    });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

export async function startTau2Bridge(
  options: Tau2BridgeOptions
): Promise<RunningTau2Bridge> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("tau2 bridge only permits a loopback host");
  }
  const configured = {
    bodyLimitBytes: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    host,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    modelFactory: options.modelFactory,
    modelId: options.modelId,
    port: options.port ?? 8787,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const generate = createTau2BridgeGenerate(configured);
  const server = createServer(async (request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: "loopback clients only" });
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, {
        arms: ["native", "glm5"],
        model: configured.modelId,
        status: "ok",
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/generate") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    try {
      const body = await readJsonBody(request, configured.bodyLimitBytes);
      sendJson(response, 200, await generate(body));
    } catch (error) {
      const status = error instanceof BridgeInputError ? error.status : 502;
      const message =
        error instanceof BridgeInputError
          ? error.message
          : "model generation failed";
      sendJson(response, status, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(configured.port, configured.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const displayHost = configured.host === "::1" ? "[::1]" : configured.host;
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    host: configured.host,
    origin: `http://${displayHost}:${address.port}`,
    port: address.port,
  };
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
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

export async function runTau2BridgeCli(): Promise<RunningTau2Bridge> {
  const apiKey = requireEnv("FREEROUTER_API_KEY");
  const baseURL =
    process.env.FREEROUTER_BASE_URL ??
    "https://freerouter.minpeter.workers.dev/v1";
  const modelId = process.env.TAU2_BRIDGE_MODEL ?? "zai-org/glm-5.2";
  const provider = createOpenAICompatible({
    apiKey,
    baseURL,
    name: "freerouter-tau2",
  });
  const bridge = await startTau2Bridge({
    host: process.env.TAU2_BRIDGE_HOST ?? "127.0.0.1",
    maxOutputTokens: envPositiveInt(
      "TAU2_BRIDGE_MAX_OUTPUT_TOKENS",
      DEFAULT_MAX_OUTPUT_TOKENS
    ),
    modelFactory: (requestedModel) => provider(requestedModel),
    modelId,
    port: envPositiveInt("TAU2_BRIDGE_PORT", 8787),
    timeoutMs: envPositiveInt("TAU2_BRIDGE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  });
  console.log(
    JSON.stringify({
      model: modelId,
      origin: bridge.origin,
      status: "listening",
    })
  );
  return bridge;
}

const [, entrypoint] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runTau2BridgeCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
