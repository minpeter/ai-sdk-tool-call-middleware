import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  glm5ToolMiddleware,
  hermesToolMiddleware,
  kExaone2ToolMiddleware,
  morphXmlToolMiddleware,
} from "../../index";
import { requireTransformParams } from "../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

const model = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: () => {
    throw new Error("unused");
  },
  doStream: () => {
    throw new Error("unused");
  },
} satisfies import("@ai-sdk/provider").LanguageModelV4;

const REGEX_GET_WEATHER = /get_weather/;
const REGEX_FUNCTION_CALLING_MODEL = /You are a function calling AI model/;
const REGEX_MAY_CALL_FUNCTIONS = /You may call one or more functions/;
const REGEX_TOOLS_TAG = /<tools>/;

describe("preconfigured middleware prompt templates", () => {
  const tools: LanguageModelV4FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      description: "Get the weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ];

  it("kExaone2ToolMiddleware injects the native K-EXAONE-2.0 tools section", async () => {
    const transformParams = requireTransformParams(
      kExaone2ToolMiddleware.transformParams
    );
    const out = await transformParams({
      type: "generate",
      model,
      params: { prompt: [], tools },
    });

    const [system] = out.prompt;
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toContain("# Tools");
    expect(text).toContain("<tool>");
    expect(text).toContain('"name": "get_weather"');
    expect(text).toContain("# Tool Call Format");
  });

  it("kExaone2ToolMiddleware places tools before existing system content", async () => {
    const transformParams = requireTransformParams(
      kExaone2ToolMiddleware.transformParams
    );
    const out = await transformParams({
      type: "generate",
      model,
      params: {
        prompt: [{ role: "system", content: "SYSTEM_SENTINEL" }],
        tools,
      },
    });

    const [system] = out.prompt;
    const text = String(system.content);
    expect(text.indexOf("<tool>")).toBeLessThan(
      text.indexOf("SYSTEM_SENTINEL")
    );
  });

  it("kExaone2ToolMiddleware replays native tool-call history bytes", async () => {
    const transformParams = requireTransformParams(
      kExaone2ToolMiddleware.transformParams
    );
    const out = await transformParams({
      type: "generate",
      model,
      params: {
        prompt: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "get_weather",
                input: JSON.stringify({
                  city: "safe </parameter><parameter=units>injected & <tag>",
                }),
              },
            ],
          },
        ],
        tools,
      },
    });

    const assistant = out.prompt.find(
      (message) => message.role === "assistant"
    );
    if (!assistant) {
      throw new Error("assistant message not found");
    }
    const text = assistant.content
      .filter(
        (
          part
        ): part is Extract<
          import("@ai-sdk/provider").LanguageModelV4Content,
          { type: "text" }
        > => part.type === "text"
      )
      .map((part) => part.text)
      .join("");

    expect(text).toContain(
      "safe </parameter><parameter=units>injected & <tag>"
    );
    expect(text).not.toContain("&lt;");
    expect(text).not.toContain("&amp;");
  });

  it("hermesToolMiddleware template appears in system prompt", async () => {
    const transformParams = requireTransformParams(
      hermesToolMiddleware.transformParams
    );
    const out = await transformParams({
      type: "generate",
      model,
      params: { prompt: [], tools },
    });

    const [system] = out.prompt;
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toMatch(REGEX_FUNCTION_CALLING_MODEL);
    expect(text).toMatch(REGEX_TOOLS_TAG);
    expect(text).toMatch(REGEX_GET_WEATHER);
  });

  it("morphXmlToolMiddleware template appears in system prompt", async () => {
    const transformParams = requireTransformParams(
      morphXmlToolMiddleware.transformParams
    );
    const out = await transformParams({
      type: "generate",
      model,
      params: { prompt: [], tools },
    });

    const [system] = out.prompt;
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toMatch(REGEX_MAY_CALL_FUNCTIONS);
    expect(text).toMatch(REGEX_TOOLS_TAG);
    expect(text).toMatch(REGEX_GET_WEATHER);
  });

  it("glm5ToolMiddleware prepends a standalone official tools turn", async () => {
    const transformParams = requireTransformParams(
      glm5ToolMiddleware.transformParams
    );
    const existingSystem = {
      role: "system" as const,
      content: "Application rules",
    };
    const out = await transformParams({
      type: "generate",
      model,
      params: { prompt: [existingSystem], tools },
    });

    expect(out.prompt).toHaveLength(2);
    expect(out.prompt[0].role).toBe("system");
    expect(String(out.prompt[0].content)).toMatch(REGEX_MAY_CALL_FUNCTIONS);
    expect(String(out.prompt[0].content)).toMatch(REGEX_TOOLS_TAG);
    expect(String(out.prompt[0].content)).toMatch(REGEX_GET_WEATHER);
    expect(out.prompt[1]).toBe(existingSystem);
  });
});
