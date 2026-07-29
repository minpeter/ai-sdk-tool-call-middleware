import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTau2BridgeGenerate,
  parseTau2BridgeRequest,
  type RunningTau2Bridge,
  startTau2Bridge,
  type Tau2BridgeRequest,
} from "./tau2-bridge";

const ZERO_USAGE = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 12,
  },
  outputTokens: { reasoning: undefined, text: 5, total: 5 },
};

function generateResult(
  content: LanguageModelV4Content[],
  unified: "stop" | "tool-calls"
): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: { raw: unified, unified },
    usage: ZERO_USAGE,
    warnings: [],
  };
}

function fixtureModel(
  generate: (
    options: LanguageModelV4CallOptions
  ) => LanguageModelV4GenerateResult
): LanguageModelV4 {
  return {
    doGenerate: (options) => Promise.resolve(generate(options)),
    doStream: () =>
      Promise.reject(new Error("streaming is not used by the tau2 bridge")),
    modelId: "fixture-model",
    provider: "fixture",
    specificationVersion: "v4",
    supportedUrls: {},
  };
}

function request(arm: "glm5" | "native"): Tau2BridgeRequest {
  return {
    arm,
    messages: [{ content: "What is the weather in Seoul?", role: "user" }],
    model: "fixture-model",
    system: "Use the weather tool when the user asks about weather.",
    tools: [
      {
        description: "Get weather for a city",
        inputSchema: {
          properties: { city: { type: "string" } },
          required: ["city"],
          type: "object",
        },
        name: "get_weather",
      },
    ],
  };
}

function textOnlyRequest(arm: "glm5" | "native"): Tau2BridgeRequest {
  return {
    arm,
    messages: [{ content: "Explain the account policy.", role: "user" }],
    model: "fixture-model",
    system: "Answer from the supplied policy.",
    tools: [],
  };
}

async function post(origin: string, body: unknown) {
  const response = await fetch(`${origin}/v1/generate`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return {
    body: (await response.json()) as Record<string, unknown>,
    status: response.status,
  };
}

function isBindPermissionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

describe("tau2 localhost prompt-only bridge", () => {
  let bridge: RunningTau2Bridge | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("runs native and prompt-only GLM arms in process", async () => {
    const observed: LanguageModelV4CallOptions[] = [];
    const requestedModels: string[] = [];
    let callIndex = 0;
    const model = fixtureModel((options) => {
      observed.push(options);
      callIndex += 1;
      if (callIndex === 1) {
        return generateResult(
          [
            {
              input: '{"city":"Seoul"}',
              toolCallId: "native-1",
              toolName: "get_weather",
              type: "tool-call",
            },
          ],
          "tool-calls"
        );
      }
      return generateResult(
        [
          {
            text: "<tool_call>get_weather<arg_key>city</arg_key><arg_value>Seoul</arg_value></tool_call>",
            type: "text",
          },
        ],
        "stop"
      );
    });
    const generate = createTau2BridgeGenerate({
      maxOutputTokens: 1024,
      modelFactory: (modelId) => {
        requestedModels.push(modelId);
        return model;
      },
      modelId: "fixture-model",
      timeoutMs: 120_000,
    });

    const native = await generate(request("native"));
    const glm5 = await generate(request("glm5"));

    expect(native).toMatchObject({
      arm: "native",
      finishReason: "tool-calls",
      parserErrors: [],
      text: "",
      toolCalls: [
        {
          arguments: { city: "Seoul" },
          id: "native-1",
          name: "get_weather",
        },
      ],
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    expect(glm5).toMatchObject({
      arm: "glm5",
      finishReason: "tool-calls",
      parserErrors: [],
      text: "",
    });
    expect(glm5.toolCalls).toEqual([
      expect.objectContaining({
        arguments: { city: "Seoul" },
        name: "get_weather",
      }),
    ]);
    expect(observed).toHaveLength(2);
    expect(observed[0].prompt.at(-1)).toMatchObject({ role: "user" });
    expect(observed[1].prompt.at(-1)).toMatchObject({ role: "user" });
    expect(observed[0].tools?.[0]).toMatchObject({
      name: "get_weather",
      type: "function",
    });
    expect(requestedModels).toEqual(["fixture-model", "fixture-model"]);
    expect(observed[1]?.tools).toEqual([]);
    expect(observed[1]?.toolChoice).toBeUndefined();
    expect(observed[1]?.maxOutputTokens).toBe(observed[0]?.maxOutputTokens);
    expect(observed[1]?.temperature).toBe(observed[0]?.temperature);
    expect(JSON.stringify(observed[1]?.prompt)).toContain("get_weather");
  });

  it("fails closed on an unsupported arm and mismatched tool history", () => {
    const badHistory = request("native");
    badHistory.messages = [
      {
        role: "assistant",
        toolCalls: [
          { arguments: { city: "Seoul" }, id: "call-1", name: "get_weather" },
        ],
      },
      {
        role: "tool",
        toolResults: [
          { content: "sunny", id: "wrong-id", name: "get_weather" },
        ],
      },
    ];
    expect(() =>
      parseTau2BridgeRequest(
        { ...request("native"), arm: "text" },
        "fixture-model"
      )
    ).toThrow("arm must be native or glm5");
    expect(() => parseTau2BridgeRequest(badHistory, "fixture-model")).toThrow(
      "messages[1].toolResults[0] does not match a preceding assistant tool call"
    );
    const zeroToolHistory = textOnlyRequest("glm5");
    zeroToolHistory.messages = [
      {
        role: "assistant",
        toolCalls: [
          { arguments: { city: "Seoul" }, id: "call-1", name: "get_weather" },
        ],
      },
    ];
    expect(() =>
      parseTau2BridgeRequest(zeroToolHistory, "fixture-model")
    ).toThrow("references an unknown tool");
  });

  it("supports zero-tool text-only requests in both arms", async () => {
    const observed: LanguageModelV4CallOptions[] = [];
    const model = fixtureModel((options) => {
      observed.push(options);
      return generateResult([{ text: "Policy answer.", type: "text" }], "stop");
    });
    const generate = createTau2BridgeGenerate({
      maxOutputTokens: 1024,
      modelFactory: () => model,
      modelId: "fixture-model",
      timeoutMs: 120_000,
    });

    const native = await generate(textOnlyRequest("native"));
    const glm5 = await generate(textOnlyRequest("glm5"));

    expect(native).toMatchObject({ text: "Policy answer.", toolCalls: [] });
    expect(glm5).toMatchObject({
      parserErrors: [],
      text: "Policy answer.",
      toolCalls: [],
    });
    expect(observed).toHaveLength(2);
    expect(observed[0].tools).toBeUndefined();
    expect(observed[1].tools).toEqual([]);
    expect(observed[1].toolChoice).toBeUndefined();
    expect(observed[1].prompt).toEqual(observed[0].prompt);
  });

  it("round trips over real loopback TCP when the sandbox permits it", async ({
    skip,
  }) => {
    const model = fixtureModel(() =>
      generateResult(
        [
          {
            input: '{"city":"Seoul"}',
            toolCallId: "tcp-1",
            toolName: "get_weather",
            type: "tool-call",
          },
        ],
        "tool-calls"
      )
    );
    try {
      bridge = await startTau2Bridge({
        modelFactory: () => model,
        modelId: "fixture-model",
        port: 0,
      });
    } catch (error) {
      if (isBindPermissionError(error)) {
        skip();
        return;
      }
      throw error;
    }

    const result = await post(bridge.origin, request("native"));
    expect(result).toMatchObject({
      body: {
        arm: "native",
        toolCalls: [{ id: "tcp-1", name: "get_weather" }],
      },
      status: 200,
    });
  });

  it("refuses a non-loopback bind", async () => {
    const model = fixtureModel(() =>
      generateResult([{ text: "unused", type: "text" }], "stop")
    );
    await expect(
      startTau2Bridge({
        host: "0.0.0.0",
        modelFactory: () => model,
        modelId: "fixture-model",
      })
    ).rejects.toThrow("only permits a loopback host");
  });
});
