import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { kExaone236BToolMiddleware } from "../../preconfigured-middleware";
import { requireTransformParams } from "../test-helpers";

const tools = [
  {
    type: "function",
    name: "edge_probe",
    description: "Probe exact JSON rendering.",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "number" },
      },
      required: ["value"],
    },
  },
] satisfies LanguageModelV4FunctionTool[];

describe("kExaone236BToolMiddleware", () => {
  it("rejects unsafe tool declaration metadata before provider invocation", async () => {
    const doGenerate = vi.fn();
    const model = wrapLanguageModel({
      model: {
        specificationVersion: "v4",
        provider: "test",
        modelId: "test",
        supportedUrls: {},
        doGenerate,
        doStream: vi.fn(),
      },
      middleware: kExaone236BToolMiddleware,
    });

    await expect(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Run." }] }],
        tools: [
          {
            type: "function",
            name: "unsafe</tool>name",
            description: "Unsafe declaration.",
            inputSchema: { type: "object" },
          },
        ],
      })
    ).rejects.toThrow(
      "K-EXAONE tool names and descriptions must not contain <tool> or </tool>."
    );
    expect(doGenerate).not.toHaveBeenCalled();
  });

  const transformParams = requireTransformParams(
    kExaone236BToolMiddleware.transformParams
  );

  it("emits tool_declare first and preserves native structured history", async () => {
    // Given
    let capturedBody: unknown;
    const provider = createOpenAICompatible({
      name: "friendli-capture",
      apiKey: "test-key",
      baseURL: "https://capture.invalid/v1",
      fetch: (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("Expected a JSON request body");
        }
        capturedBody = JSON.parse(init.body);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "response-1",
              created: 0,
              model: "probe-model",
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: "done" },
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          )
        );
      },
    });
    const model = wrapLanguageModel({
      model: provider.chatModel("probe-model"),
      middleware: kExaone236BToolMiddleware,
    });

    // When
    await model.doGenerate({
      prompt: [
        { role: "system", content: "SYSTEM_SENTINEL" },
        {
          role: "user",
          content: [{ type: "text", text: "Run the probe." }],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "reasoning sentinel" },
            { type: "text", text: "I will inspect it." },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "edge_probe",
              input: { value: 1 },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "edge_probe",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Continue." }],
        },
      ],
      tools,
    });

    // Then
    expect(capturedBody).toMatchObject({
      messages: [
        {
          role: "tool_declare",
          content:
            '# Tools\n<tool>{"type": "function", "function": {"name": "edge_probe", "description": "Probe exact JSON rendering.", "parameters": {"properties": {"value": {"type": "number"}}, "required": ["value"], "type": "object"}}}</tool>\n',
        },
        {
          role: "system",
          content:
            '# Tool Call Format\nWhen calling a tool, output exactly one JSON object inside <tool_call> tags:\n<tool_call>{"name":"example_tool_name","arguments":{"arg1":"value1"}}</tool_call>\nUse the declared tool name and argument keys.\n',
        },
        { role: "system", content: "SYSTEM_SENTINEL" },
        { role: "user", content: "Run the probe." },
        {
          role: "assistant",
          content: "I will inspect it.",
          reasoning_content: "reasoning sentinel",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "edge_probe",
                arguments: '{"value":1}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: '{"ok":true}',
        },
        { role: "user", content: "Continue." },
      ],
    });
    expect(capturedBody).not.toHaveProperty("tools");
  });

  it.each([
    { label: "required", toolChoice: { type: "required" as const } },
    {
      label: "specific",
      toolChoice: { type: "tool" as const, toolName: "edge_probe" },
    },
  ])("injects declarations for $label tool choice", async ({ toolChoice }) => {
    const transformed = await transformParams({
      type: "generate",
      model: {} as never,
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "Probe." }] }],
        tools,
        toolChoice,
      },
    });

    expect(transformed.prompt.slice(0, 2)).toEqual([
      {
        role: "system",
        content: expect.stringContaining("# Tools"),
        providerOptions: {
          openaiCompatible: {
            role: "tool_declare",
          },
        },
      },
      {
        role: "system",
        content: expect.stringContaining("# Tool Call Format"),
      },
    ]);
    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();
  });

  it("preserves structured history without declarations for none", async () => {
    const prompt = [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "edge_probe",
            input: { value: 1 },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "call-1",
            toolName: "edge_probe",
            output: { type: "json" as const, value: { ok: true } },
          },
        ],
      },
    ];

    const transformed = await transformParams({
      type: "generate",
      model: {} as never,
      params: {
        prompt,
        tools,
        toolChoice: { type: "none" },
      },
    });

    expect(transformed.prompt).toEqual(prompt);
    expect(transformed.tools).toEqual([]);
    expect(transformed.toolChoice).toBeUndefined();
  });

  it("rejects provider-defined tools through the preset", async () => {
    await expect(
      transformParams({
        type: "generate",
        model: {} as never,
        params: {
          prompt: [],
          tools: [
            ...tools,
            {
              type: "provider",
              id: "openai.web_search",
              name: "web_search",
              args: {},
            },
          ],
        },
      })
    ).rejects.toThrow(
      "Provider-defined tools are not supported by this middleware"
    );
  });
});
