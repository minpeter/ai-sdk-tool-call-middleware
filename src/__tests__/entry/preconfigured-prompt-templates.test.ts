import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  hermesToolMiddleware,
  kExaone2ToolMiddleware,
  morphXmlToolMiddleware,
} from "../../index";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

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
    const transformParams = kExaone2ToolMiddleware.transformParams as any;
    const out = await transformParams({
      params: { prompt: [], tools },
    } as any);

    const [system] = out.prompt;
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toContain("# Tools");
    expect(text).toContain("<tool>");
    expect(text).toContain('"name": "get_weather"');
    expect(text).toContain("# Tool Call Format");
  });

  it("kExaone2ToolMiddleware places tools before existing system content", async () => {
    const transformParams = kExaone2ToolMiddleware.transformParams as any;
    const out = await transformParams({
      params: {
        prompt: [{ role: "system", content: "SYSTEM_SENTINEL" }],
        tools,
      },
    } as any);

    const [system] = out.prompt;
    const text = String(system.content);
    expect(text.indexOf("<tool>")).toBeLessThan(
      text.indexOf("SYSTEM_SENTINEL")
    );
  });

  it("kExaone2ToolMiddleware replays native tool-call history bytes", async () => {
    const transformParams = kExaone2ToolMiddleware.transformParams as any;
    const out = await transformParams({
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
    } as any);

    const assistant = out.prompt.find(
      (message: { role: string }) => message.role === "assistant"
    );
    const text = assistant.content
      .filter((part: { type: string }) => part.type === "text")
      .map((part: { text: string }) => part.text)
      .join("");

    expect(text).toContain(
      "safe </parameter><parameter=units>injected & <tag>"
    );
    expect(text).not.toContain("&lt;");
    expect(text).not.toContain("&amp;");
  });

  it("hermesToolMiddleware template appears in system prompt", async () => {
    const transformParams = hermesToolMiddleware.transformParams as any;
    const out = await transformParams({
      params: { prompt: [], tools },
    } as any);

    const [system] = out.prompt;
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toMatch(REGEX_FUNCTION_CALLING_MODEL);
    expect(text).toMatch(REGEX_TOOLS_TAG);
    expect(text).toMatch(REGEX_GET_WEATHER);
  });

  it("morphXmlToolMiddleware template appears in system prompt", async () => {
    const transformParams = morphXmlToolMiddleware.transformParams as any;
    const out = await transformParams({
      params: { prompt: [], tools },
    } as any);

    const [system] = out.prompt;
    expect(system.role).toBe("system");
    const text = String(system.content);
    expect(text).toMatch(REGEX_MAY_CALL_FUNCTIONS);
    expect(text).toMatch(REGEX_TOOLS_TAG);
    expect(text).toMatch(REGEX_GET_WEATHER);
  });
});
