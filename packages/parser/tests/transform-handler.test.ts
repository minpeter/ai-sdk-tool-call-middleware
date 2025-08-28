import { describe, it, expect, vi } from "vitest";
import {
  gemmaToolMiddleware,
  hermesToolMiddleware,
  xmlToolMiddleware,
} from "@/index";
import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";

import { createToolMiddleware } from "@/tool-call-middleware";
import { jsonMixProtocol } from "@/protocols/json-mix-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("index prompt templates", () => {
  const tools: LanguageModelV2FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      description: "Get the weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ];

  it("gemmaToolMiddleware template appears in system prompt", async () => {
    const out = await (gemmaToolMiddleware.transformParams as any)!({
      params: { prompt: [], tools },
    } as any);

    const system = out.prompt[0];
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toMatch(/You have access to functions/);
    expect(text).toMatch(/```tool_call/);
    expect(text).toMatch(/get_weather/);
  });

  it("hermesToolMiddleware template appears in system prompt", async () => {
    const out = await (hermesToolMiddleware.transformParams as any)!({
      params: { prompt: [], tools },
    } as any);

    const system = out.prompt[0];
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toMatch(/You are a function calling AI model/);
    expect(text).toMatch(/<tools>/);
    expect(text).toMatch(/get_weather/);
  });

  it("xmlToolMiddleware template appears in system prompt", async () => {
    const out = await (xmlToolMiddleware.transformParams as any)!({
      params: { prompt: [], tools },
    } as any);

    const system = out.prompt[0];
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toMatch(/KorinAI/);
    expect(text).toMatch(/<tools>/);
    expect(text).toMatch(/get_weather/);
  });
});

describe("createToolMiddleware error branches", () => {
  const mw = createToolMiddleware({
    protocol: jsonMixProtocol,
    toolSystemPromptTemplate: t => `T:${t}`,
  });

  it("throws when toolChoice none is used", async () => {
    await expect(
      mw.transformParams!({
        params: { prompt: [], toolChoice: { type: "none" } },
      } as any)
    ).rejects.toThrow(/none/);
  });

  it("throws when specific tool not found", async () => {
    await expect(
      mw.transformParams!({
        params: {
          prompt: [],
          tools: [],
          toolChoice: { type: "tool", toolName: "missing" },
        },
      } as any)
    ).rejects.toThrow(/not found/);
  });

  it("throws when provider-defined tool is selected", async () => {
    await expect(
      mw.transformParams!({
        params: {
          prompt: [],
          tools: [{ type: "provider-defined", id: "x" } as any],
          toolChoice: { type: "tool", toolName: "x" },
        },
      } as any)
    ).rejects.toThrow(/Provider-defined tools/);
  });

  it("throws when required toolChoice is set but no tools are provided", async () => {
    await expect(
      mw.transformParams!({
        params: { prompt: [], tools: [], toolChoice: { type: "required" } },
      } as any)
    ).rejects.toThrow(
      /Tool choice type 'required' is set, but no tools are provided/
    );
  });
});

describe("createToolMiddleware positive paths", () => {
  it("transformParams injects system prompt and merges consecutive user texts", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: t => `SYS:${t}`,
    });
    const tools = [
      {
        type: "function",
        name: "op",
        description: "desc",
        inputSchema: { type: "object" },
      },
    ];
    const out = await mw.transformParams!({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "A" }] },
          { role: "user", content: [{ type: "text", text: "B" }] },
        ],
        tools,
      },
    } as any);
    expect(out.prompt[0].role).toBe("system");
    expect(String(out.prompt[0].content)).toContain("SYS:");
    // merged two user messages
    const mergedUser = out.prompt[1];
    expect(mergedUser.role).toBe("user");
    const text = (mergedUser.content as any[])
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");
    expect(text).toContain("A");
    expect(text).toContain("B");
  });
});

describe("non-stream assistant->user merge formatting with object input", () => {
  it("gemma: formats assistant tool-call (object input) and tool result into user text", async () => {
    const mw = gemmaToolMiddleware;

    const out = await mw.transformParams!({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "get_weather",
                // simulate provider giving parsed object input
                input: JSON.stringify({ city: "Seoul" }),
              } as any,
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "tc1",
                output: { ok: true },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as any);

    // last message is the tool result
    console.debug(out.prompt[out.prompt.length - 1]);

    const assistantMsg = out.prompt.find((m: any) => m.role === "assistant")!;
    const assistantText = (assistantMsg.content as any[])
      .map((c: any) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(assistantText).toMatch(/tool_call/);

    const userMsgs = out.prompt.filter((m: any) => m.role === "user");
    const userCombined = userMsgs
      .map((u: any) =>
        u.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
      )
      .join("\n");

    expect(userCombined).toMatch(/tool_response/);
  });

  it("hermes: formats assistant tool-call (object input) and tool result into user text", async () => {
    const mw = hermesToolMiddleware;
    const out = await mw.transformParams!({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "get_weather",
                input: JSON.stringify({ city: "Seoul" }),
              } as any,
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "tc1",
                output: { ok: true },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as any);

    // last message is the tool result
    console.debug(out.prompt[out.prompt.length - 1]);

    const assistantMsg = out.prompt.find((m: any) => m.role === "assistant")!;
    const assistantText = (assistantMsg.content as any[])
      .map((c: any) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(assistantText).toMatch(/<tool_call>/);

    const userMsgs = out.prompt.filter((m: any) => m.role === "user");
    const userCombined = userMsgs
      .map((u: any) =>
        u.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
      )
      .join("\n");
    expect(userCombined).toMatch(/<tool_response>/);
  });

  it("xml: formats assistant tool-call (object input) and tool result into user text", async () => {
    const mw = xmlToolMiddleware;
    const out = await mw.transformParams!({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "get_weather",
                input: JSON.stringify({ city: "Seoul" }),
              } as any,
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "tc1",
                output: { ok: true },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as any);

    // last message is the tool result
    console.debug(out.prompt[out.prompt.length - 1]);

    const assistantMsg = out.prompt.find((m: any) => m.role === "assistant")!;
    const assistantText = (assistantMsg.content as any[])
      .map((c: any) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(assistantText).toMatch(/<get_weather>/);

    const userMsgs = out.prompt.filter((m: any) => m.role === "user");
    const userCombined = userMsgs
      .map((u: any) =>
        u.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
      )
      .join("\n");
    expect(userCombined).toMatch(/<tool_response>/);
  });
});

describe("transformParams", () => {
  it("should transform params with tools into prompt", async () => {
    const middleware = createToolMiddleware({
      protocol: jsonMixProtocol({}),
      toolSystemPromptTemplate: (tools: string) => `You have tools: ${tools}`,
    });

    const params = {
      prompt: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "test" }],
        },
      ],
      tools: [
        {
          type: "function" as const,
          name: "getTool",
          description: "Gets a tool",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
        },
      ],
    };

    const result = await middleware.transformParams!({ params } as any);
    expect(result.prompt).toBeDefined();
    expect(result.tools).toEqual([]);
    expect(result.toolChoice).toBeUndefined();
  });
});

describe("transformParams merges adjacent user messages", () => {
  it("merges two consecutive user messages into one with newline", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: t => `T:${t}`,
    });

    const out = await mw.transformParams!({
      params: {
        prompt: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
        tools: [],
      },
    } as any);

    // After inserting system, the merged user should be at index 1
    const user = out.prompt.find(m => m.role === "user")!;
    const text = user.content.map((c: any) => c.text).join("");
    expect(text).toBe("first\nsecond");
  });

  it("condenses multiple tool_response messages into single user text content", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: t => `T:${t}`,
    });

    const out = await mw.transformParams!({
      params: {
        prompt: [
          {
            role: "tool" as const,
            content: [
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "a",
                output: {
                  type: "json",
                  value: {
                    city: "New York",
                    temperature: 25,
                    condition: "sunny",
                  },
                },
              },
              {
                type: "tool-result",
                toolName: "get_weather",
                toolCallId: "b",
                output: {
                  type: "json",
                  value: {
                    city: "Los Angeles",
                    temperature: 58,
                    condition: "sunny",
                  },
                },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function" as const,
            name: "get_weather",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      },
    } as any);

    const userMsgs = out.prompt.filter(m => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const user = userMsgs[0] as any;
    // Single text content only
    expect(user.content.filter((c: any) => c.type === "text")).toHaveLength(1);
    const text = user.content[0].text as string;
    // Contains two tool_response blocks
    expect((text.match(/<tool_response>/g) || []).length).toBe(2);
    expect(user.content.length).toBe(1);
  });
});

describe("transformParams convertToolPrompt mapping and merge", () => {
  const mw = createToolMiddleware({
    protocol: jsonMixProtocol,
    toolSystemPromptTemplate: t => `TOOLS:${t}`,
  });

  it("converts assistant tool-call and tool role messages, merges adjacent user texts, and preserves providerOptions", async () => {
    const params = {
      prompt: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "hello" }],
        },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "t1",
              input: "{}",
            },
            { type: "text", text: "aside" },
            { foo: "bar" } as any,
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result",
              toolName: "t1",
              toolCallId: "tc1",
              output: { ok: true },
            },
            { toolName: "t1", toolCallId: "tc1", output: { alt: 1 } } as any,
          ],
        },
      ],
      tools: [
        {
          type: "function" as const,
          name: "t1",
          description: "desc",
          inputSchema: { type: "object" },
        },
      ],
      providerOptions: { toolCallMiddleware: { existing: true } },
    };

    const out = await mw.transformParams!({ params } as any);
    expect(out.prompt[0].role).toBe("system");
    // Assistant remains assistant with formatted tool call text
    const assistantMsg = out.prompt.find(m => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
    const assistantText = assistantMsg!.content
      .map(c => (c.type === "text" ? (c as any).text : ""))
      .join("");
    expect(assistantText).toMatch(/<tool_call>/);

    // Tool role becomes user text; original user remains user; they are not adjacent so not merged
    const userMsgs = out.prompt.filter(m => m.role === "user");
    expect(userMsgs.length).toBe(2);
    const userCombined = userMsgs
      .map(u =>
        u.content.map(c => (c.type === "text" ? (c as any).text : "")).join("")
      )
      .join("\n");
    expect(userCombined).toContain("hello");
    expect(userCombined).toMatch(/<tool_response>/);

    // tools cleared; toolNames propagated into providerOptions
    expect(out.tools).toEqual([]);
    const toolNames = (out.providerOptions as any).toolCallMiddleware.toolNames;
    expect(toolNames).toEqual(["t1"]);
    // existing provider option preserved
    expect((out.providerOptions as any).toolCallMiddleware.existing).toBe(true);
  });

  it("condenses multiple text parts in a single user message into one", async () => {
    const params = {
      prompt: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "line1" },
            { type: "text" as const, text: "line2" },
          ],
        },
      ],
      tools: [],
    };

    const out = await mw.transformParams!({ params } as any);
    const userMsgs = out.prompt.filter(m => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    const onlyText = userMsgs[0].content.every((c: any) => c.type === "text");
    expect(onlyText).toBe(true);
    expect(userMsgs[0].content).toHaveLength(1);
    expect((userMsgs[0].content[0] as any).text).toBe("line1\nline2");
  });

  it("preserves assistant reasoning parts and formats tool-call", async () => {
    const params = {
      prompt: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc1",
              toolName: "t1",
              input: "{}",
            },
            {
              type: "reasoning" as const,
              content: [{ type: "text", text: "thinking..." }],
            } as any,
          ],
        },
      ],
      tools: [
        {
          type: "function" as const,
          name: "t1",
          description: "desc",
          inputSchema: { type: "object" },
        },
      ],
    };

    const out = await mw.transformParams!({ params } as any);
    const assistant = out.prompt.find(m => m.role === "assistant")! as any;
    // Should contain both formatted tool_call text and original reasoning block
    const hasReasoning = assistant.content.some(
      (c: any) => c.type === "reasoning"
    );
    expect(hasReasoning).toBe(true);
    const assistantText = assistant.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(assistantText).toMatch(/<tool_call>/);
    // Ensure the reasoning's inner text remains
    const reasoning = assistant.content.find(
      (c: any) => c.type === "reasoning"
    );
    expect(
      (reasoning as any).content?.map((p: any) => p.text).join("")
    ).toContain("thinking...");
  });
});

describe(".....", () => {
  it("transformParams throws on toolChoice type none", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: () => "",
    });
    await expect(
      mw.transformParams!({
        params: { prompt: [], tools: [], toolChoice: { type: "none" } },
      } as any)
    ).rejects.toThrow(/none/);
  });

  it("transformParams validates specific tool selection and builds JSON schema", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const tools = [
      {
        type: "function",
        name: "t1",
        description: "d",
        inputSchema: { type: "object", properties: { a: { type: "string" } } },
      },
    ];
    const result = await mw.transformParams!({
      params: {
        prompt: [],
        tools,
        toolChoice: { type: "tool", toolName: "t1" },
      },
    } as any);
    expect(result.responseFormat).toMatchObject({ type: "json", name: "t1" });
    expect(
      (result.providerOptions as any).toolCallMiddleware.toolChoice
    ).toEqual({ type: "tool", toolName: "t1" });
  });

  it("transformParams required builds if/then/else schema", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const tools = [
      {
        type: "function",
        name: "a",
        description: "",
        inputSchema: { type: "object" },
      },
      {
        type: "function",
        name: "b",
        description: "",
        inputSchema: { type: "object" },
      },
    ];
    const result = await mw.transformParams!({
      params: { prompt: [], tools, toolChoice: { type: "required" } },
    } as any);
    expect(result.responseFormat).toMatchObject({ type: "json" });
    expect(
      (result.providerOptions as any).toolCallMiddleware.toolChoice
    ).toEqual({ type: "required" });
  });
});
