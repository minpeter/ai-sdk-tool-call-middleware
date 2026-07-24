import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeArmFromModel,
  createOpenAICompatGenerate,
  isTransientUpstreamError,
  parseOpenAICompatRequest,
  type RunningOpenAICompatBridge,
  startOpenAICompatBridge,
} from "./openai-compat-bridge";

const OPENAI_SAFE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAPPED_TOOL_DIGEST_SUFFIX = /_([0-9a-f]{12})(?:_\d+)?$/u;

const ZERO_USAGE = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 12,
  },
  outputTokens: { reasoning: undefined, text: 5, total: 5 },
};

function generated(
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
    doStream: () => Promise.reject(new Error("streaming is not used here")),
    modelId: "fixture-model",
    provider: "fixture",
    specificationVersion: "v4",
    supportedUrls: {},
  };
}

function body(model: string) {
  return {
    messages: [{ content: "서울 날씨를 확인해 줘", role: "user" }],
    model,
    temperature: 0,
    tools: [
      {
        function: {
          description: "도시 날씨 조회",
          name: "날씨.API.get-current",
          parameters: {
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          },
        },
        type: "function",
      },
    ],
  };
}

function isBindPermissionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

describe("official OpenAI compatibility benchmark bridge", () => {
  let bridge: RunningOpenAICompatBridge | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("routes explicit model aliases and rejects ambiguous model names", () => {
    expect(bridgeArmFromModel("glm52-native")).toBe("native");
    expect(bridgeArmFromModel("openai/glm52-prompt-only")).toBe("glm5");
    expect(bridgeArmFromModel("glm52-simulator")).toBe("native");
    expect(() => bridgeArmFromModel("glm52-native-plus")).toThrow(
      "has been removed"
    );
    expect(() => bridgeArmFromModel("zai-org/glm-5.2")).toThrow(
      "explicit native or prompt-only"
    );
  });

  it("keeps names reversible while the GLM arm sends no API tools", async () => {
    const observed: LanguageModelV4CallOptions[] = [];
    let callIndex = 0;
    let mappedName: string | undefined;
    const model = fixtureModel((options) => {
      observed.push(options);
      callIndex += 1;
      if (callIndex === 1) {
        mappedName = options.tools?.[0]?.name;
        if (!mappedName) {
          throw new Error("missing fixture tool");
        }
        return generated(
          [
            {
              input: '{"city":"Seoul"}',
              toolCallId: "native-1",
              toolName: mappedName,
              type: "tool-call",
            },
          ],
          "tool-calls"
        );
      }
      if (!mappedName) {
        throw new Error("missing mapped fixture tool");
      }
      return generated(
        [
          {
            text: `<tool_call>${mappedName}<arg_key>city</arg_key><arg_value>Seoul</arg_value></tool_call>`,
            type: "text",
          },
        ],
        "stop"
      );
    });
    const generate = createOpenAICompatGenerate({
      maxOutputTokens: 4096,
      modelFactory: () => model,
      modelId: "fixture-model",
      timeoutMs: 120_000,
      transport: "generate",
    });

    const native = await generate(body("glm52-native"));
    const promptOnly = await generate(body("glm52-prompt-only"));

    expect(native.response.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        tool_calls: [
          {
            function: {
              arguments: '{"city":"Seoul"}',
              name: "날씨.API.get-current",
            },
          },
        ],
      },
    });
    expect(promptOnly.response.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        tool_calls: [{ function: { name: "날씨.API.get-current" } }],
      },
    });
    expect(observed).toHaveLength(2);
    expect(observed[0].tools?.[0]?.name).toMatch(OPENAI_SAFE_TOOL_NAME);
    expect(observed[1]?.tools).toEqual([]);
    expect(observed[1]?.toolChoice).toBeUndefined();
    expect(JSON.stringify(observed[1]?.prompt)).toContain(mappedName);
  });

  it("recovers exact original, digest-suffix, and digest-free tool names", async () => {
    const originalName = "NewsMagazines.News.getVideoNews";
    let callIndex = 0;
    const model = fixtureModel((options) => {
      const safeName = options.tools?.[0]?.name;
      if (!safeName) {
        throw new Error("missing fixture tool");
      }
      callIndex += 1;
      let returnedName = originalName;
      if (callIndex === 2) {
        const digest = MAPPED_TOOL_DIGEST_SUFFIX.exec(safeName)?.[1];
        if (!digest) {
          throw new Error("missing mapped tool digest");
        }
        returnedName = `model_mutated_the_stem_${digest}`;
      } else if (callIndex === 3) {
        returnedName = safeName.replace(MAPPED_TOOL_DIGEST_SUFFIX, "");
      }
      return generated(
        [
          {
            input: '{"category":"world"}',
            toolCallId: `recovered-${callIndex}`,
            toolName: returnedName,
            type: "tool-call",
          },
        ],
        "tool-calls"
      );
    });
    const generate = createOpenAICompatGenerate({
      maxOutputTokens: 4096,
      modelFactory: () => model,
      modelId: "fixture-model",
      timeoutMs: 120_000,
      transport: "generate",
    });
    const request = body("glm52-native");
    request.tools[0].function.name = originalName;

    const exactOriginal = await generate(request);
    const digestSuffix = await generate(request);
    const stemWithoutDigest = await generate(request);

    for (const result of [exactOriginal, digestSuffix, stemWithoutDigest]) {
      expect(
        result.response.choices[0]?.message.tool_calls?.[0]?.function
      ).toMatchObject({ name: originalName });
    }
    expect(exactOriginal.parserErrors).toEqual([
      expect.stringContaining("exact original name"),
    ]);
    expect(digestSuffix.parserErrors).toEqual([
      expect.stringContaining("unique digest suffix"),
    ]);
    expect(stemWithoutDigest.parserErrors).toEqual([
      expect.stringContaining("unique stem without digest"),
    ]);
  });

  it("passes unmapped names and malformed arguments through for benchmark scoring", async () => {
    const malformedArguments = '{"age": ,}';
    const model = fixtureModel(() =>
      generated(
        [
          {
            input: malformedArguments,
            toolCallId: "invalid-model-call",
            toolName: "model_returned_an_unknown_tool",
            type: "tool-call",
          },
        ],
        "tool-calls"
      )
    );
    const generate = createOpenAICompatGenerate({
      maxOutputTokens: 4096,
      modelFactory: () => model,
      modelId: "fixture-model",
      timeoutMs: 120_000,
      transport: "generate",
    });

    const result = await generate(body("glm52-native"));

    expect(
      result.response.choices[0]?.message.tool_calls?.[0]?.function
    ).toEqual({
      arguments: malformedArguments,
      name: "model_returned_an_unknown_tool",
    });
    expect(result.parserErrors).toEqual([
      expect.stringContaining("tool-name pass-through"),
      expect.stringContaining("tool-input pass-through"),
    ]);
  });

  it("preserves OpenAI assistant-call/tool-result history", () => {
    const request = body("glm52-prompt-only");
    request.messages = [
      { content: "서울 날씨를 확인해 줘", role: "user" },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"city":"Seoul"}',
              name: "날씨.API.get-current",
            },
            id: "call-1",
            type: "function",
          },
        ],
      },
      { content: "sunny", role: "tool", tool_call_id: "call-1" },
    ] as never;
    const parsed = parseOpenAICompatRequest(request);
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[1]).toMatchObject({ role: "assistant" });
    expect(parsed.messages[2]).toMatchObject({ role: "tool" });
  });

  it("preserves malformed assistant-call arguments in later-turn history", async () => {
    const request = body("glm52-native");
    request.messages = [
      { content: "서울 날씨를 확인해 줘", role: "user" },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"city": ,}',
              name: "날씨.API.get-current",
            },
            id: "malformed-history-call",
            type: "function",
          },
        ],
      },
      {
        content: "The tool arguments could not be parsed.",
        role: "tool",
        tool_call_id: "malformed-history-call",
      },
      { content: "다시 시도해 줘", role: "user" },
    ] as never;

    const parsed = parseOpenAICompatRequest(request);
    expect(parsed.historyParserErrors).toEqual([
      expect.stringContaining("history tool-input preservation"),
    ]);
    expect(JSON.stringify(parsed.messages)).toContain(
      "__bridge_malformed_tool_arguments__"
    );

    const model = fixtureModel(() =>
      generated([{ text: "continued", type: "text" }], "stop")
    );
    const generate = createOpenAICompatGenerate({
      maxOutputTokens: 4096,
      modelFactory: () => model,
      modelId: "fixture-model",
      timeoutMs: 120_000,
      transport: "generate",
    });
    const result = await generate(request);
    expect(result.response.choices[0]?.message.content).toBe("continued");
    expect(result.parserErrors).toEqual([
      expect.stringContaining("history tool-input preservation"),
    ]);
  });

  it("preserves missing history tool results as bounded sentinels", async () => {
    const request = body("glm52-native");
    request.messages = [
      { content: "서울 날씨를 확인해 줘", role: "user" },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"city":"Seoul"}',
              name: "날씨.API.get-current",
            },
            id: "missing-result-call",
            type: "function",
          },
        ],
      },
      { content: "결과 없이 다음 턴으로 진행해 줘", role: "user" },
    ] as never;

    const parsed = parseOpenAICompatRequest(request);
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[2]).toMatchObject({
      content: [
        {
          toolCallId: "missing-result-call",
          type: "tool-result",
        },
      ],
      role: "tool",
    });
    expect(JSON.stringify(parsed.messages[2])).toContain(
      "__bridge_missing_tool_result__"
    );
    expect(parsed.historyParserErrors).toEqual([
      expect.stringContaining("missing-tool-result preservation"),
    ]);

    const model = fixtureModel(() =>
      generated([{ text: "continued", type: "text" }], "stop")
    );
    const generate = createOpenAICompatGenerate({
      maxOutputTokens: 4096,
      modelFactory: () => model,
      modelId: "fixture-model",
      timeoutMs: 120_000,
      transport: "generate",
    });
    const result = await generate(request);
    expect(result.response.choices[0]?.message.content).toBe("continued");
    expect(result.parserErrors).toEqual([
      expect.stringContaining("missing-tool-result preservation"),
    ]);
  });

  it("preserves demo history for tools omitted from the current tool list", () => {
    const request = body("glm52-prompt-only");
    request.messages = [
      { content: "demonstration", role: "user" },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"query":"demo"}',
              name: "legacy.demo.search",
            },
            id: "demo-call-1",
            type: "function",
          },
        ],
      },
      { content: "demo result", role: "tool", tool_call_id: "demo-call-1" },
      { content: "서울 날씨를 확인해 줘", role: "user" },
    ] as never;

    const parsed = parseOpenAICompatRequest(request);
    expect(parsed.toolMappings).toHaveLength(1);
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[1]).toMatchObject({
      content: [
        {
          toolCallId: "demo-call-1",
          type: "tool-call",
        },
      ],
      role: "assistant",
    });
    expect(parsed.messages[2]).toMatchObject({
      content: [
        {
          toolCallId: "demo-call-1",
          type: "tool-result",
        },
      ],
      role: "tool",
    });
  });

  it("rejects client-side streaming before any model call", () => {
    expect(() =>
      parseOpenAICompatRequest({ ...body("glm52-native"), stream: true })
    ).toThrow("client-side SSE is unsupported");
  });

  it("classifies only transient upstream failures for bridge retries", () => {
    expect(isTransientUpstreamError({ statusCode: 429 })).toBe(true);
    expect(isTransientUpstreamError({ statusCode: 503 })).toBe(true);
    expect(isTransientUpstreamError({ name: "TimeoutError" })).toBe(true);
    expect(isTransientUpstreamError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientUpstreamError({ statusCode: 400 })).toBe(false);
    expect(isTransientUpstreamError(new Error("invalid tool arguments"))).toBe(
      false
    );
  });

  it("links every transient attempt to one bridge request", async ({
    skip,
  }) => {
    let modelCalls = 0;
    const model = fixtureModel(() => {
      modelCalls += 1;
      if (modelCalls < 3) {
        throw Object.assign(new Error("temporary upstream outage"), {
          statusCode: 503,
        });
      }
      return generated([{ text: "recovered", type: "text" }], "stop");
    });
    const attempts: Array<{ attempt: number; jobKey: string }> = [];
    let linkedIds: string[] | undefined;
    const capture = {
      flush: () => Promise.resolve(),
      run<T>(
        context: { attempt: number; jobKey: string },
        requestIds: string[],
        operation: () => T
      ): T {
        attempts.push({ attempt: context.attempt, jobKey: context.jobKey });
        linkedIds ??= requestIds;
        expect(requestIds).toBe(linkedIds);
        requestIds.push(`capture-${context.attempt}`);
        return operation();
      },
    };
    try {
      bridge = await startOpenAICompatBridge({
        capture: capture as never,
        modelFactory: () => model,
        modelId: "fixture-model",
        port: 0,
        transientRetries: 2,
        transientRetryDelayMs: 0,
      });
    } catch (error) {
      if (isBindPermissionError(error)) {
        skip();
        return;
      }
      throw error;
    }

    const response = await fetch(`${bridge.origin}/v1/chat/completions`, {
      body: JSON.stringify(body("glm52-prompt-only")),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(modelCalls).toBe(3);
    expect(attempts.map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
    expect(new Set(attempts.map(({ jobKey }) => jobKey)).size).toBe(1);
    expect(linkedIds).toEqual(["capture-1", "capture-2", "capture-3"]);
  });

  it("does not retry invalid client input", async ({ skip }) => {
    let modelCalls = 0;
    let captureRuns = 0;
    const model = fixtureModel(() => {
      modelCalls += 1;
      return generated([{ text: "unexpected", type: "text" }], "stop");
    });
    const capture = {
      flush: () => Promise.resolve(),
      run<T>(_context: unknown, _requestIds: string[], operation: () => T): T {
        captureRuns += 1;
        return operation();
      },
    };
    try {
      bridge = await startOpenAICompatBridge({
        capture: capture as never,
        modelFactory: () => model,
        modelId: "fixture-model",
        port: 0,
        transientRetries: 3,
        transientRetryDelayMs: 0,
      });
    } catch (error) {
      if (isBindPermissionError(error)) {
        skip();
        return;
      }
      throw error;
    }

    const response = await fetch(`${bridge.origin}/v1/chat/completions`, {
      body: JSON.stringify({ ...body("glm52-native"), stream: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(modelCalls).toBe(0);
    expect(captureRuns).toBe(0);
  });

  it("round trips an OpenAI chat completion over loopback TCP", async ({
    skip,
  }) => {
    const model = fixtureModel((options) => {
      const name = options.tools?.[0]?.name;
      if (!name) {
        throw new Error("missing fixture tool");
      }
      return generated(
        [
          {
            input: '{"city":"Seoul"}',
            toolCallId: "tcp-1",
            toolName: name,
            type: "tool-call",
          },
        ],
        "tool-calls"
      );
    });
    try {
      bridge = await startOpenAICompatBridge({
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
    const response = await fetch(`${bridge.origin}/v1/chat/completions`, {
      body: JSON.stringify(body("glm52-native")),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "날씨.API.get-current" }, id: "tcp-1" },
            ],
          },
        },
      ],
      object: "chat.completion",
    });
  });
});
