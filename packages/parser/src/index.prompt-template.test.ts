import { describe, it, expect } from "vitest";
import {
  gemmaToolMiddleware,
  hermesToolMiddleware,
  xmlToolMiddleware,
} from "./index";
import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";

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
