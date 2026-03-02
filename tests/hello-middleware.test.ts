import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { requireTransformParams } from "../src/__tests__/test-helpers";
import { createHelloToolMiddleware } from "../src/examples/hello-tool-middleware";

describe("createHelloToolMiddleware", () => {
  it("exposes the middleware interface", () => {
    const middleware = createHelloToolMiddleware();

    expect(middleware.specificationVersion).toBe("v3");
    expect(typeof middleware.wrapStream).toBe("function");
    expect(typeof middleware.wrapGenerate).toBe("function");
    expect(typeof middleware.transformParams).toBe("function");
  });

  it("injects a friendly system prompt containing tool names", async () => {
    const middleware = createHelloToolMiddleware({
      promptIntro: "Hello Tools!",
    });
    const transformParams = requireTransformParams(middleware.transformParams);
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Gets the weather for a given city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
    ];

    const out = await transformParams({
      params: {
        prompt: [],
        tools,
      },
    } as any);

    const system = out.prompt[0];
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toContain("Hello Tools!");
    expect(text).toContain("get_weather");
  });
});
