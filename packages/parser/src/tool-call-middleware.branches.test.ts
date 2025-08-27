import { describe, it, expect, vi } from "vitest";
import { createToolMiddleware } from "./tool-call-middleware";
import { jsonMixProtocol } from "./protocols/json-mix-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("createToolMiddleware branches", () => {
  it("wrapGenerate returns tool-call content when toolChoice active", async () => {
    const mw = createToolMiddleware({
      protocol: jsonMixProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"n","arguments":{}}' }],
    });
    const result = await mw.wrapGenerate!({
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
