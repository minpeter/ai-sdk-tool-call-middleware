import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { requireTransformParams } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

function unusedModelMethod(): never {
  throw new Error("unused");
}

describe("createToolMiddleware transformParams positive paths", () => {
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: unusedModelMethod,
    doStream: unusedModelMethod,
  };

  it("transformParams injects system prompt and merges consecutive user texts", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      placement: "first",
      toolSystemPromptTemplate: (t) => `SYS:${t}`,
    });
    const tools = [
      {
        type: "function",
        name: "op",
        description: "desc",
        inputSchema: { type: "object" },
      },
    ] satisfies LanguageModelV4FunctionTool[];
    const params = {
      prompt: [
        { role: "user", content: [{ type: "text", text: "A" }] },
        { role: "user", content: [{ type: "text", text: "B" }] },
      ],
      tools,
    } satisfies LanguageModelV4CallOptions;
    const transformParams = requireTransformParams(mw.transformParams);
    const out = await transformParams({ type: "generate", params, model });
    expect(out.prompt[0].role).toBe("system");
    expect(String(out.prompt[0].content)).toContain("SYS:");
    // merged two user messages
    const [, mergedUser] = out.prompt;
    expect(mergedUser?.role).toBe("user");
    if (mergedUser?.role !== "user") {
      throw new TypeError("Expected a merged user prompt message");
    }
    const text = mergedUser.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");
    expect(text).toContain("A");
    expect(text).toContain("B");
  });
});
