import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { jsonProtocol } from "../../core/protocols/json-protocol";
import { xmlProtocol } from "../../core/protocols/xml-protocol";
import { yamlProtocol } from "../../core/protocols/yaml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

type FixtureProtocol = "json" | "xml" | "yaml";
type FixtureMode = "generate" | "stream";

interface FixtureToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

interface FixtureExpected {
  shouldParse: boolean;
  toolCalls: FixtureToolCall[];
  expectedToolNames: string[];
  expectedFailureMode: string;
  preserveTextIncludes?: string[];
}

interface FixtureSample {
  id: string;
  protocol: FixtureProtocol;
  mode: FixtureMode;
  modelOutput: string;
  expected: FixtureExpected;
}

interface FixtureCase {
  caseId: string;
  samples: FixtureSample[];
}

interface ParsedOutput {
  toolCalls: FixtureToolCall[];
  textOutput: string;
}

function getFixtureCases(): FixtureCase[] {
  const fixtureDir = fileURLToPath(
    new URL("../fixtures/protocol-regressions", import.meta.url)
  );
  const fixtureFiles = readdirSync(fixtureDir)
    .filter((fileName) => fileName.endsWith(".fixture.json"))
    .sort();

  return fixtureFiles.map((fileName) => {
    const filePath = join(fixtureDir, fileName);
    return JSON.parse(readFileSync(filePath, "utf-8")) as FixtureCase;
  });
}

function getProtocol(protocol: FixtureProtocol) {
  if (protocol === "json") {
    return jsonProtocol();
  }
  if (protocol === "xml") {
    return xmlProtocol();
  }
  return yamlProtocol();
}

function createTool(name: string, inputSchema: Record<string, unknown>) {
  return {
    type: "function" as const,
    name,
    inputSchema,
  } satisfies LanguageModelV3FunctionTool;
}

function getCaseTools(caseId: string): LanguageModelV3FunctionTool[] {
  const weatherTool = createTool("get_weather", {
    type: "object",
    properties: {
      city: { type: "string" },
      unit: { type: "string", enum: ["celsius", "fahrenheit"] },
    },
    required: ["city", "unit"],
  });

  const createEventTool = createTool("create_event", {
    type: "object",
    properties: {
      title: { type: "string" },
      start_iso: { type: "string" },
      timezone: { type: "string" },
    },
    required: ["title", "start_iso"],
  });

  switch (caseId) {
    case "simple-weather":
      return [weatherTool];
    case "simple-calendar":
      return [createEventTool];
    case "basic-extraction":
      return [
        createTool("extract_facts", {
          type: "object",
          properties: {
            text: { type: "string" },
            max_facts: { type: "number" },
          },
          required: ["text", "max_facts"],
        }),
      ];
    case "agent-shell":
      return [
        createTool("shell", {
          type: "object",
          properties: {
            command: { type: "array", items: { type: "string" } },
            timeout_ms: { type: "number" },
          },
          required: ["command"],
        }),
      ];
    case "agent-file-write":
      return [
        createTool("write_file", {
          type: "object",
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" },
            overwrite: { type: "boolean" },
          },
          required: ["file_path", "contents", "overwrite"],
        }),
      ];
    case "multi-tool-weather-calendar":
      return [weatherTool, createEventTool];
    default:
      throw new Error(`No tools configured for caseId: ${caseId}`);
  }
}

function normalizeInput(input: unknown): Record<string, unknown> | null {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  return null;
}

function extractToolCalls(parts: LanguageModelV3Content[]): FixtureToolCall[] {
  return parts
    .filter(
      (part): part is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
        part.type === "tool-call"
    )
    .map((toolCall) => ({
      toolName: toolCall.toolName,
      input: normalizeInput(toolCall.input) ?? {},
    }));
}

function extractText(parts: LanguageModelV3Content[]): string {
  return parts
    .filter(
      (part): part is Extract<LanguageModelV3Content, { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

async function runSample(options: {
  caseId: string;
  sample: FixtureSample;
}): Promise<ParsedOutput> {
  const { caseId, sample } = options;
  const tools = getCaseTools(caseId);
  const protocol = getProtocol(sample.protocol);

  if (sample.mode === "generate") {
    const parts = protocol.parseGeneratedText({
      text: sample.modelOutput,
      tools,
      options: {},
    }) as LanguageModelV3Content[];

    return {
      toolCalls: extractToolCalls(parts),
      textOutput: extractText(parts),
    };
  }

  const transformer = protocol.createStreamParser({ tools, options: {} });
  const input = new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "text-delta",
        id: "fixture",
        delta: sample.modelOutput,
      });
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      controller.close();
    },
  });

  const output = await convertReadableStreamToArray(
    pipeWithTransformer(input, transformer)
  );

  const toolCalls = output
    .filter(
      (
        part
      ): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
        part.type === "tool-call"
    )
    .map((toolCall) => ({
      toolName: toolCall.toolName,
      input: normalizeInput(toolCall.input) ?? {},
    }));

  const textOutput = output
    .filter(
      (
        part
      ): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
        part.type === "text-delta"
    )
    .map((part) => part.delta)
    .join("");

  return { toolCalls, textOutput };
}

describe("protocol regression fixtures", () => {
  const fixtureCases = getFixtureCases();

  for (const fixtureCase of fixtureCases) {
    describe(fixtureCase.caseId, () => {
      for (const sample of fixtureCase.samples) {
        it(sample.id, async () => {
          const result = await runSample({
            caseId: fixtureCase.caseId,
            sample,
          });

          const parsedToolNames = result.toolCalls.map(
            (toolCall) => toolCall.toolName
          );
          expect(parsedToolNames).toEqual(sample.expected.expectedToolNames);

          if (sample.expected.shouldParse) {
            expect(result.toolCalls).toEqual(sample.expected.toolCalls);
            expect(sample.expected.expectedFailureMode).toBe("NONE");
            return;
          }

          expect(result.toolCalls).toHaveLength(0);
          expect(sample.expected.expectedFailureMode).not.toBe("NONE");

          for (const textSnippet of sample.expected.preserveTextIncludes ??
            []) {
            expect(result.textOutput).toContain(textSnippet);
          }
        });
      }
    });
  }
});
