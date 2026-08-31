import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONTENT_LENGTH_PREFIX = /^Content-Length:/i;
const CONTENT_LENGTH_HEADER = /^Content-Length:\s*(\d+)\s*$/im;
const SECRET_ENVIRONMENT_NAME =
  /(?:api[_-]?key|authorization|credential|password|secret|token)/i;

function mcpChildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined && !SECRET_ENVIRONMENT_NAME.test(name)
    )
  );
}

export const FILESYSTEM_MCP_PACKAGE =
  "@modelcontextprotocol/server-filesystem@2025.12.18";

export interface McpToolDefinition {
  annotations?: Record<string, unknown>;
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
  outputSchema?: Record<string, unknown>;
  title?: string;
}

export interface McpCallResult {
  content?: Record<string, unknown>[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

interface JsonRpcResponse {
  error?: {
    code: number;
    data?: unknown;
    message: string;
  };
  id: number | string;
  jsonrpc: "2.0";
  result?: unknown;
}

interface JsonRpcServerRequest {
  id: number | string;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface PendingRequest {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: NodeJS.Timeout;
}

export class McpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method: string;

  constructor(
    method: string,
    detail: { code: number; data?: unknown; message: string }
  ) {
    super(`MCP ${method} failed (${detail.code}): ${detail.message}`);
    this.name = "McpRpcError";
    this.code = detail.code;
    this.data = detail.data;
    this.method = method;
  }
}

export class McpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTransportError";
  }
}

export interface McpStdioClientOptions {
  allowedRoot: string;
  command?: string;
  packageSpec?: string;
  requestTimeoutMs?: number;
}

/**
 * Minimal MCP stdio JSON-RPC client used by the benchmark harness.
 *
 * MCP's stdio transport is newline-delimited JSON. The parser also accepts
 * Content-Length framing so a framing change cannot silently corrupt a run.
 */
export class McpStdioClient {
  readonly allowedRoot: string;
  readonly packageSpec: string;
  readonly requestTimeoutMs: number;

  private buffer = Buffer.alloc(0);
  private readonly child: ChildProcessWithoutNullStreams;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private stderrBuffer = "";

  private constructor(options: McpStdioClientOptions) {
    this.allowedRoot = options.allowedRoot;
    this.packageSpec = options.packageSpec ?? FILESYSTEM_MCP_PACKAGE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.child = spawn(
      options.command ?? "npx",
      ["-y", this.packageSpec, this.allowedRoot],
      {
        // The filesystem server does not need provider credentials. Keep them
        // out of the third-party child process even when the runner has them.
        env: mcpChildEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf8")}`.slice(
        -65_536
      );
    });
    this.child.on("error", (error) => {
      this.failAll(
        new McpTransportError(`Filesystem MCP process error: ${error.message}`)
      );
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.failAll(
          new McpTransportError(
            `Filesystem MCP process exited (code=${String(code)}, signal=${String(signal)}). stderr: ${this.stderr().slice(-2000)}`
          )
        );
      }
    });
  }

  static async connect(
    options: McpStdioClientOptions
  ): Promise<McpStdioClient> {
    const client = new McpStdioClient(options);
    try {
      await client.request("initialize", {
        capabilities: {},
        clientInfo: {
          name: "glm-5.2-tool-calling-mcpmark-harness",
          version: "1.0.0",
        },
        protocolVersion: "2024-11-05",
      });
      client.notify("notifications/initialized", {});
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async callTool(
    name: string,
    argumentsValue: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<McpCallResult> {
    return (await this.request(
      "tools/call",
      {
        arguments: argumentsValue,
        name,
      },
      timeoutMs
    )) as McpCallResult;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.request("tools/list", {
        ...(cursor ? { cursor } : {}),
      })) as {
        nextCursor?: string;
        tools?: McpToolDefinition[];
      };
      if (!Array.isArray(result.tools)) {
        throw new McpTransportError("MCP tools/list returned no tools array");
      }
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  stderr(): string {
    return this.stderrBuffer.trim();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failAll(new McpTransportError("MCP client closed"));
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }

    const exited = new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
    });
    this.child.kill("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!graceful && this.child.exitCode === null) {
      this.child.kill("SIGKILL");
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new McpTransportError("MCP client is closed"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpTransportError(`MCP ${method} timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
      this.pending.set(id, { method, reject, resolve, timeout });
      try {
        this.write({ id, jsonrpc: "2.0", method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(
          error instanceof Error ? error : new McpTransportError(String(error))
        );
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new McpTransportError("MCP stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.consumeMessage()) {
        // Consume every complete frame currently buffered.
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.failAll(
        new McpTransportError(`Invalid MCP stdout framing: ${detail}`)
      );
      this.child.kill("SIGTERM");
    }
  }

  private consumeMessage(): boolean {
    while (
      this.buffer.length > 0 &&
      (this.buffer[0] === 0x0a || this.buffer[0] === 0x0d)
    ) {
      this.buffer = this.buffer.subarray(1);
    }
    if (this.buffer.length === 0) {
      return false;
    }

    const prefix = this.buffer
      .subarray(0, Math.min(this.buffer.length, 32))
      .toString("ascii");
    if (CONTENT_LENGTH_PREFIX.test(prefix)) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary === -1) {
        return false;
      }
      const header = this.buffer.subarray(0, boundary).toString("ascii");
      const match = CONTENT_LENGTH_HEADER.exec(header);
      if (!match) {
        throw new Error(`Malformed Content-Length header: ${header}`);
      }
      const length = Number.parseInt(match[1], 10);
      const payloadStart = boundary + 4;
      if (this.buffer.length < payloadStart + length) {
        return false;
      }
      const payload = this.buffer
        .subarray(payloadStart, payloadStart + length)
        .toString("utf8");
      this.buffer = this.buffer.subarray(payloadStart + length);
      this.handlePayload(payload);
      return true;
    }

    const newline = this.buffer.indexOf(0x0a);
    if (newline === -1) {
      return false;
    }
    const payload = this.buffer.subarray(0, newline).toString("utf8").trim();
    this.buffer = this.buffer.subarray(newline + 1);
    if (payload) {
      this.handlePayload(payload);
    }
    return true;
  }

  private handlePayload(payload: string): void {
    const message = JSON.parse(payload) as
      | JsonRpcResponse
      | JsonRpcServerRequest
      | Record<string, unknown>;
    if (
      "method" in message &&
      typeof message.method === "string" &&
      "id" in message &&
      (typeof message.id === "number" || typeof message.id === "string")
    ) {
      this.handleServerRequest(message as JsonRpcServerRequest);
      return;
    }
    if (
      !("id" in message) ||
      (typeof message.id !== "number" && typeof message.id !== "string")
    ) {
      return;
    }

    const response = message as JsonRpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new McpRpcError(pending.method, response.error));
      return;
    }
    pending.resolve(response.result);
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    if (request.method === "ping") {
      this.write({ id: request.id, jsonrpc: "2.0", result: {} });
      return;
    }
    if (request.method === "roots/list") {
      this.write({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          roots: [
            {
              name: "benchmark-snapshot",
              uri: pathToFileURL(this.allowedRoot).href,
            },
          ],
        },
      });
      return;
    }
    this.write({
      error: { code: -32_601, message: "Method not found" },
      id: request.id,
      jsonrpc: "2.0",
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
