import { beforeEach, describe, expect, it, vi } from "vitest";

import { jsonProtocol } from "../core/protocols/json-protocol";
import { createToolMiddleware } from "../tool-call-middleware";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("createToolMiddleware branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("wrapGenerate returns tool-call content when toolChoice active", async () => {
    const mw = createToolMiddleware({
      protocol: jsonProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"n","arguments":{}}' }],
    });
    if (!mw.wrapGenerate) {
      throw new Error("wrapGenerate is not defined");
    }
    const result = await mw.wrapGenerate({
      doGenerate,
      params: {
        prompt: [],
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "required" } },
        },
      },
    } as any);
    expect(result.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "n",
      input: "{}",
    });
  });

  it("wrapStream handles toolChoice 'required' via stream handler", async () => {
    const mw = createToolMiddleware({
      protocol: jsonProtocol,
      toolSystemPromptTemplate: () => "",
    });

    if (!mw.wrapStream) {
      throw new Error("wrapStream is not defined");
    }
    const result = await mw.wrapStream({
      doStream: vi.fn().mockResolvedValue({
        stream: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      }),
      doGenerate: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"name":"n","arguments":{}}' }],
      }),
      params: {
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "required" } },
        },
      },
    } as any);
    expect(result.stream).toBeDefined();
  });

  it("wrapGenerate toolChoice path coerces arguments with decoded tool schema", async () => {
    const mw = createToolMiddleware({
      protocol: jsonProtocol,
      toolSystemPromptTemplate: () => "",
    });

    if (!mw.wrapGenerate) {
      throw new Error("wrapGenerate is not defined");
    }
    const result = await mw.wrapGenerate({
      doGenerate: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"name":"calc","arguments":{"a":"10","b":"false"}}',
          },
        ],
      }),
      params: {
        providerOptions: {
          toolCallMiddleware: {
            toolChoice: { type: "required" },
            originalTools: [
              {
                name: "calc",
                inputSchema:
                  '{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"boolean"}}}',
              },
            ],
          },
        },
      },
    } as any);
    expect(result.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "calc",
      input: '{"a":10,"b":false}',
    });
  });

  it("wrapStream handles toolChoice 'tool' via stream handler", async () => {
    const mw = createToolMiddleware({
      protocol: jsonProtocol,
      toolSystemPromptTemplate: () => "",
    });

    if (!mw.wrapStream) {
      throw new Error("wrapStream is not defined");
    }
    const result = await mw.wrapStream({
      doStream: vi.fn().mockResolvedValue({
        stream: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      }),
      doGenerate: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"name":"x","arguments":{}}' }],
      }),
      params: {
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "tool", toolName: "x" } },
        },
      },
    } as any);
    expect(result.stream).toBeDefined();
  });

  it("wrapGenerate does not throw when originalTools contains malformed schema JSON", async () => {
    const mw = createToolMiddleware({
      protocol: jsonProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const onError = vi.fn();
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '<tool_call>{"name":"n","arguments":{"x":"1"}}</tool_call>',
        },
      ],
    });

    if (!mw.wrapGenerate) {
      throw new Error("wrapGenerate is not defined");
    }
    const result = await mw.wrapGenerate({
      doGenerate,
      params: {
        prompt: [],
        providerOptions: {
          toolCallMiddleware: {
            originalTools: [{ name: "n", inputSchema: "{" }],
            onError,
          },
        },
      },
    } as any);

    expect(onError).toHaveBeenCalled();
    expect(result.content.some((part: any) => part.type === "tool-call")).toBe(
      true
    );
  });
});
