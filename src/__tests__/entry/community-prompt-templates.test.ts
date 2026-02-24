import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  sijawaraConciseXmlToolMiddleware,
  sijawaraDetailedXmlToolMiddleware,
  uiTarsToolMiddleware,
} from "../../community";

function requireTransformParams(value: unknown): (args: {
  params: {
    prompt: LanguageModelV3Prompt;
    tools: LanguageModelV3FunctionTool[];
  };
}) =>
  | Promise<{ prompt: LanguageModelV3Prompt }>
  | { prompt: LanguageModelV3Prompt } {
  if (typeof value !== "function") {
    throw new Error("transformParams is required for middleware");
  }

  return value as (args: {
    params: {
      prompt: LanguageModelV3Prompt;
      tools: LanguageModelV3FunctionTool[];
    };
  }) =>
    | Promise<{ prompt: LanguageModelV3Prompt }>
    | {
        prompt: LanguageModelV3Prompt;
      };
}

describe("community middleware prompt templates", () => {
  it("uiTarsToolMiddleware renders Input Examples in system prompt", async () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "computer",
        description: "UI automation tool",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string" },
            coordinate: {
              type: "array",
              items: { type: "number" },
            },
          },
          required: ["action"],
        },
        inputExamples: [
          {
            input: {
              action: "left_click",
              coordinate: [100, 200],
            },
          },
        ],
      } satisfies LanguageModelV3FunctionTool & {
        inputExamples: Array<{ input: unknown }>;
      },
    ];

    const transformParams = requireTransformParams(
      uiTarsToolMiddleware.transformParams
    );
    const out = await transformParams({
      params: { prompt: [], tools },
    });

    const system = out.prompt[0];
    expect(system?.role).toBe("system");
    const text = String(system?.content ?? "");
    expect(text).toContain("# Input Examples");
    expect(text).toContain("Tool: computer");
    expect(text).toContain("<tool_call>");
    expect(text).toContain("<function=computer>");
  });

  it("sijawaraDetailedXmlToolMiddleware renders Input Examples", async () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
        inputExamples: [
          {
            input: {
              city: "Seoul",
            },
          },
        ],
      } satisfies LanguageModelV3FunctionTool & {
        inputExamples: Array<{ input: unknown }>;
      },
    ];

    const transformParams = requireTransformParams(
      sijawaraDetailedXmlToolMiddleware.transformParams
    );
    const out = await transformParams({
      params: { prompt: [], tools },
    });

    const system = out.prompt[0];
    expect(system?.role).toBe("system");
    const text = String(system?.content ?? "");
    expect(text).toContain("# Input Examples");
    expect(text).toContain("Tool: get_weather");
    expect(text).toContain("<get_weather>");
    expect(text).toContain("<city>Seoul</city>");
  });

  it("sijawaraConciseXmlToolMiddleware renders Input Examples", async () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
        inputExamples: [
          {
            input: {
              city: "Busan",
            },
          },
        ],
      } satisfies LanguageModelV3FunctionTool & {
        inputExamples: Array<{ input: unknown }>;
      },
    ];

    const transformParams = requireTransformParams(
      sijawaraConciseXmlToolMiddleware.transformParams
    );
    const out = await transformParams({
      params: { prompt: [], tools },
    });

    const system = out.prompt[0];
    expect(system?.role).toBe("system");
    const text = String(system?.content ?? "");
    expect(text).toContain("# Input Examples");
    expect(text).toContain("Tool: get_weather");
    expect(text).toContain("<get_weather>");
    expect(text).toContain("<city>Busan</city>");
  });

  it("sijawaraDetailedXmlToolMiddleware falls back safely for invalid XML keys", async () => {
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
        inputExamples: [
          {
            input: {
              "bad key": "Seoul",
            },
          },
        ],
      } satisfies LanguageModelV3FunctionTool & {
        inputExamples: Array<{ input: unknown }>;
      },
    ];

    const transformParams = requireTransformParams(
      sijawaraDetailedXmlToolMiddleware.transformParams
    );
    const out = await transformParams({
      params: { prompt: [], tools },
    });

    const system = out.prompt[0];
    expect(system?.role).toBe("system");
    const text = String(system?.content ?? "");
    expect(text).toContain("# Input Examples");
    expect(text).toContain('<get_weather>{"bad key":"Seoul"}</get_weather>');
    expect(text).not.toContain("<bad key>");
  });
});
