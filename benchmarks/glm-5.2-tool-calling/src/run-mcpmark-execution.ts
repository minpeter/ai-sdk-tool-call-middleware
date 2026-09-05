import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  jsonSchema,
  type ModelMessage,
  type ToolSet,
  wrapLanguageModel,
} from "ai";
import { runBenchmarkModel } from "./benchmark-model-call";
import {
  type McpCallResult,
  McpRpcError,
  McpStdioClient,
  type McpToolDefinition,
} from "./mcp-stdio-client";
import {
  createPristineSnapshot,
  hashTree,
  runOfficialVerifier,
  sha256Text,
  toolSchemaFingerprint,
} from "./mcpmark-filesystem-common";
import {
  captureArmsFromEnv,
  credentialSafeError,
  ProviderCapture,
} from "./provider-capture";
import type {
  AttemptCompletion,
  AttemptRecord,
  AttemptState,
  ExecutionSettings,
  FailureStage,
  Job,
  McpmarkExecutor,
  RunResult,
  ToolCallRecord,
  ToolResult,
  TurnContext,
} from "./run-mcpmark-reporting";
import {
  emptyVerification,
  shouldRetainAttempt,
} from "./run-mcpmark-reporting";

function makeTools(definitions: McpToolDefinition[]): ToolSet {
  const tools: ToolSet = {};
  for (const definition of definitions) {
    tools[definition.name] = {
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema),
    };
  }
  return tools;
}

function addFailure(
  state: AttemptState,
  stage: FailureStage,
  detail: string,
  retryable: boolean,
  turn?: number
): void {
  state.failures.push({
    detail: detail.slice(0, 8000),
    retryable,
    stage,
    turn,
  });
}

function syntheticRpcError(error: McpRpcError): McpCallResult {
  return {
    content: [{ type: "text", text: `Error: ${error.message}` }],
    isError: true,
    rpcError: { code: error.code, data: error.data, message: error.message },
  };
}

function createAttemptState(): AttemptState {
  return {
    agentEndedNormally: false,
    failures: [],
    fatalAgentFailure: false,
    finalText: "",
    parserErrors: [],
    rawCaptureIds: [],
    serverStderr: "",
    trajectory: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

export function createMcpmarkExecutor(
  settings: ExecutionSettings
): McpmarkExecutor {
  const normalizeError = (error: unknown): string =>
    credentialSafeError(error, [settings.apiKey]);
  const rawCapture = new ProviderCapture({
    arms: captureArmsFromEnv(
      process.env.MCPMARK_RAW_CAPTURE_ARMS ?? process.env.BENCH_RAW_CAPTURE_ARMS
    ),
    enabled:
      (process.env.MCPMARK_RAW_CAPTURE ?? process.env.BENCH_RAW_CAPTURE) !==
      "0",
    output: settings.out,
    secretValues: [settings.apiKey],
  });
  const provider = createOpenAICompatible({
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl,
    name: "freerouter",
    fetch: rawCapture.fetch,
  });

  function collectParserErrors(errors: string[]) {
    return {
      toolCallMiddleware: {
        onError: (message: string, metadata?: Record<string, unknown>) => {
          errors.push(
            `${message}${metadata ? ` ${JSON.stringify(metadata).slice(0, 2000)}` : ""}`
          );
        },
      },
    };
  }

  async function executeValidToolCall(
    call: Awaited<ReturnType<typeof runBenchmarkModel>>["toolCalls"][number],
    client: McpStdioClient,
    state: AttemptState,
    deadline: number,
    turn: number
  ): Promise<{ record: ToolCallRecord; result?: ToolResult }> {
    const callStartedAt = Date.now();
    const record: ToolCallRecord = {
      input: call.input,
      latencyMs: 0,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
    };
    try {
      const mcpResult = await client.callTool(
        call.toolName,
        call.input as Record<string, unknown>,
        Math.max(1, Math.min(settings.mcpTimeoutMs, deadline - Date.now()))
      );
      const serialized = JSON.stringify(mcpResult);
      record.latencyMs = Date.now() - callStartedAt;
      record.resultHash = sha256Text(serialized);
      record.resultIsError = mcpResult.isError === true;
      record.serializedResult = serialized;
      if (mcpResult.isError) {
        addFailure(
          state,
          "mcp",
          `Tool ${call.toolName} returned isError=true`,
          false,
          turn
        );
      }
      return {
        record,
        result: {
          output: { type: "text", value: serialized },
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          type: "tool-result",
        },
      };
    } catch (error) {
      record.latencyMs = Date.now() - callStartedAt;
      if (error instanceof McpRpcError) {
        const serialized = JSON.stringify(syntheticRpcError(error));
        record.resultHash = sha256Text(serialized);
        record.resultIsError = true;
        record.rpcError = error.message;
        record.serializedResult = serialized;
        addFailure(state, "mcp", error.message, false, turn);
        return {
          record,
          result: {
            output: { type: "text", value: serialized },
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            type: "tool-result",
          },
        };
      }
      const detail = normalizeError(error);
      record.rpcError = detail;
      if (Date.now() >= deadline) {
        addFailure(
          state,
          "attempt_timeout",
          `Agent attempt exceeded ${settings.attemptTimeoutMs}ms during MCP execution: ${detail}`,
          false,
          turn
        );
      } else {
        addFailure(state, "mcp", detail, true, turn);
      }
      state.fatalAgentFailure = true;
      return { record };
    }
  }

  async function executeToolCalls(
    result: Awaited<ReturnType<typeof runBenchmarkModel>>,
    client: McpStdioClient,
    state: AttemptState,
    deadline: number,
    turn: number,
    turnParserErrors: string[]
  ): Promise<{ records: ToolCallRecord[]; results: ToolResult[] }> {
    const records: ToolCallRecord[] = [];
    const results: ToolResult[] = [];
    for (const call of result.toolCalls) {
      if (call.invalid === true) {
        const detail = `Invalid AI SDK tool call ${call.toolName}: ${normalizeError(call.error)}`;
        const serialized = JSON.stringify({ error: detail });
        records.push({
          input: call.input,
          latencyMs: 0,
          resultHash: sha256Text(serialized),
          resultIsError: true,
          rpcError: detail,
          serializedResult: serialized,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        });
        state.parserErrors.push(detail);
        turnParserErrors.push(detail);
        addFailure(state, "parser", detail, false, turn);
        results.push({
          output: { type: "error-text", value: detail },
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          type: "tool-result",
        });
        continue;
      }
      if (Date.now() >= deadline) {
        addFailure(
          state,
          "attempt_timeout",
          `Agent attempt exceeded ${settings.attemptTimeoutMs}ms before MCP execution`,
          false,
          turn
        );
        state.fatalAgentFailure = true;
        records.push({
          input: call.input,
          latencyMs: 0,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        });
        break;
      }
      const executed = await executeValidToolCall(
        call,
        client,
        state,
        deadline,
        turn
      );
      records.push(executed.record);
      if (executed.result) {
        results.push(executed.result);
      }
      if (state.fatalAgentFailure) {
        break;
      }
    }
    return { records, results };
  }

  async function runAgent(
    job: Job,
    attemptNumber: number,
    state: AttemptState,
    deadline: number,
    definitions: McpToolDefinition[],
    client: McpStdioClient
  ): Promise<void> {
    const model = job.arm.middleware
      ? wrapLanguageModel({
          middleware: job.arm.middleware,
          model: provider(settings.model),
        })
      : provider(settings.model);
    const tools = makeTools(definitions);
    const captureTools = definitions.map(
      ({ description, inputSchema, name }) => ({
        description,
        inputSchema,
        name,
      })
    );
    const messages: ModelMessage[] = [
      { content: job.task.instruction, role: "user" },
    ];

    function recordProviderFailure(
      detail: string,
      turn: number,
      parserErrors: string[]
    ): void {
      state.parserErrors.push(...parserErrors);
      if (Date.now() >= deadline) {
        if (parserErrors.length > 0) {
          addFailure(state, "parser", parserErrors.join(" | "), false, turn);
        }
        addFailure(
          state,
          "attempt_timeout",
          `Agent attempt exceeded ${settings.attemptTimeoutMs}ms: ${detail}`,
          false,
          turn
        );
      } else if (parserErrors.length > 0) {
        addFailure(
          state,
          "parser",
          `${parserErrors.join(" | ")} | ${detail}`,
          false,
          turn
        );
      } else {
        addFailure(state, "provider", detail, true, turn);
      }
      state.fatalAgentFailure = true;
    }

    async function requestTurn(
      turn: number,
      turnParserErrors: string[]
    ): Promise<Awaited<ReturnType<typeof runBenchmarkModel>> | undefined> {
      try {
        return await rawCapture.run(
          {
            arm: job.arm.id,
            attempt: attemptNumber,
            category: job.task.category,
            jobKey: `${job.task.id}\u0000${job.arm.id}\u0000${job.trial}`,
            suite: "mcpmark",
            taskId: job.task.id,
            tools: captureTools,
            transport: settings.transport,
            trial: job.trial,
            turn,
          },
          state.rawCaptureIds,
          () =>
            runBenchmarkModel(
              {
                abortSignal: AbortSignal.timeout(
                  Math.max(
                    1,
                    Math.min(settings.providerTimeoutMs, deadline - Date.now())
                  )
                ),
                instructions: settings.systemPrompt,
                maxOutputTokens: settings.maxOutputTokens,
                maxRetries: 0,
                messages,
                model,
                providerOptions: job.arm.middleware
                  ? (collectParserErrors(turnParserErrors) as never)
                  : undefined,
                temperature: 0,
                toolChoice: "auto",
                tools,
              },
              settings.transport
            )
        );
      } catch (error) {
        if (error instanceof Error) {
          recordProviderFailure(normalizeError(error), turn, turnParserErrors);
        } else {
          recordProviderFailure(normalizeError(error), turn, turnParserErrors);
        }
        return undefined;
      }
    }

    async function recordTurn(
      result: Awaited<ReturnType<typeof runBenchmarkModel>>,
      context: TurnContext
    ): Promise<boolean> {
      state.parserErrors.push(...context.parserErrors);
      if (context.parserErrors.length > 0) {
        addFailure(
          state,
          "parser",
          context.parserErrors.join(" | "),
          false,
          context.turn
        );
      }
      state.usage.inputTokens += result.usage.inputTokens ?? 0;
      state.usage.outputTokens += result.usage.outputTokens ?? 0;
      state.usage.totalTokens += result.usage.totalTokens ?? 0;
      state.finalText = result.text;
      const assistantMessages = result.responseMessages.filter(
        (message) => message.role === "assistant"
      );
      messages.push(...assistantMessages);
      const executed = await executeToolCalls(
        result,
        client,
        state,
        deadline,
        context.turn,
        context.parserErrors
      );
      state.trajectory.push({
        assistantMessages,
        finishReason: result.finishReason,
        latencyMs: Date.now() - context.startedAt,
        parserErrors: context.parserErrors,
        rawFinishReason: result.rawFinishReason,
        text: result.text,
        toolCalls: executed.records,
        turn: context.turn,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
      });
      if (state.fatalAgentFailure) {
        return false;
      }
      if (result.toolCalls.length === 0) {
        state.agentEndedNormally = true;
        return false;
      }
      messages.push({ content: executed.results, role: "tool" });
      return true;
    }

    for (let turn = 1; turn <= settings.maxTurns; turn += 1) {
      if (Date.now() >= deadline) {
        addFailure(
          state,
          "attempt_timeout",
          `Agent attempt exceeded ${settings.attemptTimeoutMs}ms`,
          false,
          turn
        );
        state.fatalAgentFailure = true;
        break;
      }
      const turnStartedAt = Date.now();
      const turnParserErrors: string[] = [];
      const result = await requestTurn(turn, turnParserErrors);
      if (!result) {
        break;
      }
      const shouldContinue = await recordTurn(result, {
        parserErrors: turnParserErrors,
        startedAt: turnStartedAt,
        turn,
      });
      if (!shouldContinue) {
        break;
      }
    }
    if (!(state.agentEndedNormally || state.fatalAgentFailure)) {
      addFailure(
        state,
        "turn_limit",
        `Agent still requested tools after ${settings.maxTurns} turns`,
        false,
        settings.maxTurns
      );
    }
  }

  function hashResultTree(state: AttemptState): string | undefined {
    if (!(state.snapshot && existsSync(state.snapshot))) {
      return undefined;
    }
    try {
      return hashTree(state.snapshot);
    } catch (error) {
      if (error instanceof Error) {
        addFailure(
          state,
          "setup",
          `Could not hash result tree: ${normalizeError(error)}`,
          true
        );
      } else {
        addFailure(
          state,
          "setup",
          `Could not hash result tree: ${normalizeError(error)}`,
          true
        );
      }
      return undefined;
    }
  }

  function finishAttempt(context: AttemptCompletion): AttemptRecord {
    const { attemptNumber, job, startedAt, state } = context;
    const verification =
      state.snapshot && existsSync(state.snapshot)
        ? runOfficialVerifier(
            job.task,
            state.snapshot,
            settings.verifierTimeoutMs
          )
        : emptyVerification(
            "Official verifier could not run because no snapshot was available"
          );
    if (!verification.passed) {
      addFailure(
        state,
        "verification",
        verification.error ||
          verification.stderr ||
          verification.stdout ||
          "Official verifier returned non-zero",
        false
      );
    }
    const attempt: AttemptRecord = {
      agentEndedNormally: state.agentEndedNormally,
      attempt: attemptNumber,
      failures: state.failures,
      finalText: state.finalText,
      latencyMs: Date.now() - startedAt,
      mcpServerStderr: state.serverStderr,
      parserErrors: state.parserErrors,
      rawCaptureIds: state.rawCaptureIds,
      resultTreeHash: hashResultTree(state),
      schemaHash: state.schemaHash,
      snapshot: state.snapshot,
      snapshotRetained: false,
      trajectory: state.trajectory,
      usage: state.usage,
      verification,
    };
    attempt.snapshotRetained = shouldRetainAttempt(
      attempt,
      settings.snapshotRetention
    );
    if (state.snapshot && !attempt.snapshotRetained) {
      rmSync(state.snapshot, { force: true, recursive: true });
    }
    return attempt;
  }

  async function runAttempt(
    job: Job,
    attemptNumber: number,
    expectedSchemaHash: string
  ): Promise<AttemptRecord> {
    const startedAt = Date.now();
    const deadline = startedAt + settings.attemptTimeoutMs;
    const state = createAttemptState();
    let client: McpStdioClient | undefined;
    try {
      state.snapshot = createPristineSnapshot(
        join(settings.dataRoot, job.task.category),
        settings.snapshotRoot,
        `${job.task.category}-${job.task.taskId}-${job.arm.id}-trial${job.trial}-attempt${attemptNumber}`
      );
      client = await McpStdioClient.connect({
        allowedRoot: state.snapshot,
        requestTimeoutMs: settings.mcpTimeoutMs,
      });
      const definitions = await client.listTools();
      state.schemaHash = toolSchemaFingerprint(definitions);
      if (state.schemaHash !== expectedSchemaHash) {
        throw new Error(
          `MCP schema drift: expected ${expectedSchemaHash}, got ${state.schemaHash}`
        );
      }
      await runAgent(job, attemptNumber, state, deadline, definitions, client);
    } catch (error) {
      if (error instanceof Error) {
        addFailure(state, "setup", normalizeError(error), true);
      } else {
        addFailure(state, "setup", normalizeError(error), true);
      }
    } finally {
      state.serverStderr = client?.stderr() ?? "";
      await client?.close();
    }
    return finishAttempt({ attemptNumber, job, startedAt, state });
  }

  async function runJob(
    job: Job,
    expectedSchemaHash: string
  ): Promise<RunResult> {
    const startedAt = Date.now();
    const attempts: AttemptRecord[] = [];
    for (
      let attemptNumber = 1;
      attemptNumber <= settings.retries + 1;
      attemptNumber += 1
    ) {
      const attempt = await runAttempt(job, attemptNumber, expectedSchemaHash);
      attempts.push(attempt);
      const retryable = attempt.failures.some((failure) => failure.retryable);
      if (attempt.verification.passed || !retryable) {
        break;
      }
    }
    const finalAttempt = attempts.at(-1);
    if (!finalAttempt) {
      throw new Error("runJob produced no attempts");
    }
    return {
      arm: job.arm.id,
      attempts,
      category: job.task.category,
      failureStages: [
        ...new Set(
          attempts.flatMap((attempt) =>
            attempt.failures.map((failure) => failure.stage)
          )
        ),
      ],
      jobLatencyMs: Date.now() - startedAt,
      model: settings.model,
      taskId: job.task.id,
      transport: settings.transport,
      trial: job.trial,
      verificationPassed: finalAttempt.verification.passed,
    };
  }

  return { rawCapture, runJob };
}
