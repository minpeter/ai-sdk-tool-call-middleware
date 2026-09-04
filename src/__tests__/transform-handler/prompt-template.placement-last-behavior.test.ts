import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { createOperationTools } from "../fixtures/function-tools";
import { requireTransformParams } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const model = new MockLanguageModelV4();

function transformLast(
  params: LanguageModelV4CallOptions,
  toolSystemPromptTemplate: (tools: LanguageModelV4FunctionTool[]) => string
) {
  const middleware = createToolMiddleware({
    placement: "last",
    protocol: hermesProtocol,
    toolSystemPromptTemplate,
  });
  return requireTransformParams(middleware.transformParams)({
    type: "generate",
    model,
    params,
  });
}

describe("placement last behaviour (default)", () => {
  it("does not append empty system message when rendered system prompt is empty", async () => {
    const out = await transformLast(
      {
        prompt: [{ role: "user", content: [{ type: "text", text: "A" }] }],
        tools: [],
      },
      () => ""
    );

    expect(out.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "A" }] },
    ]);
  });

  it("default last: appends system at end when no system exists", async () => {
    const tools = createOperationTools();
    const out = await transformLast(
      {
        prompt: [
          { role: "user", content: [{ type: "text", text: "A" }] },
          { role: "user", content: [{ type: "text", text: "B" }] },
        ],
        tools,
      },
      (availableTools) => `SYS:${availableTools}`
    );

    const last = out.prompt.at(-1);
    expect(last?.role).toBe("system");
    expect(String(last?.content)).toContain("SYS:");
    // users merged regardless of placement
    const userMsgs = out.prompt.filter((message) => message.role === "user");
    expect(userMsgs).toHaveLength(1);
    const mergedText = userMsgs[0].content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");
    expect(mergedText).toContain("A");
    expect(mergedText).toContain("B");
  });

  it("last: merges with existing system at non-zero index (keeps one system)", async () => {
    const tools = createOperationTools();
    const out = await transformLast(
      {
        prompt: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "system", content: "BASE" },
          { role: "user", content: [{ type: "text", text: "world" }] },
        ],
        tools,
      },
      (availableTools) => `SYS:${availableTools}`
    );

    const systems = out.prompt.filter((message) => message.role === "system");
    expect(systems).toHaveLength(1);
    const [system] = systems;
    const text = String(system.content);
    expect(text.startsWith("BASE")).toBe(true);
    expect(text).toContain("SYS:");
  });
});
