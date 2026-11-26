import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { generateText, streamText, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { hermesProtocol } from "../../core/protocols/hermes/protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { mockFinishReason, zeroUsage } from "../test-helpers";

describe("interrupted tool calls through the AI SDK", () => {
  for (const mode of ["generate", "stream"] as const) {
    for (const toolChoice of [
      "auto",
      "required",
      { type: "tool", toolName: "get_weather" },
    ] as const) {
      for (const reason of ["stop", "interrupted"] as const) {
        const choiceLabel =
          typeof toolChoice === "string" ? toolChoice : toolChoice.toolName;
        it(`${mode}/${choiceLabel}: executes only a completed response (${reason})`, async () => {
          const json = '{"name":"get_weather","arguments":{"city":"Seoul"}}';
          const text =
            toolChoice === "auto" ? `<tool_call>${json}</tool_call>` : json;
          const finishReason = mockFinishReason(reason);
          const provider = new MockLanguageModelV4({
            doGenerate: {
              content: [{ type: "text", text }],
              finishReason,
              usage: zeroUsage,
              warnings: [],
            },
            doStream: () =>
              Promise.resolve({
                stream: new ReadableStream<LanguageModelV4StreamPart>({
                  start(controller) {
                    controller.enqueue({ type: "stream-start", warnings: [] });
                    controller.enqueue({ type: "text-start", id: "text" });
                    controller.enqueue({
                      type: "text-delta",
                      id: "text",
                      delta: text,
                    });
                    controller.enqueue({ type: "text-end", id: "text" });
                    controller.enqueue({
                      type: "finish",
                      finishReason,
                      usage: zeroUsage,
                    });
                    controller.close();
                  },
                }),
              }),
          });
          const execute = vi.fn(() => "Sunny");
          const options = {
            model: wrapLanguageModel({
              model: provider,
              middleware: createToolMiddleware({
                protocol: hermesProtocol(),
                promptStrategy: {
                  mode: "text",
                  template: () => "Use the supplied tools.",
                },
              }),
            }),
            prompt: "Check the weather in Seoul.",
            toolChoice,
            tools: {
              get_weather: tool({
                inputSchema: z.object({ city: z.string() }),
                execute,
              }),
            },
          };
          const result =
            mode === "generate"
              ? await generateText(options)
              : streamText(options);
          if ("consumeStream" in result) {
            await result.consumeStream();
          }

          expect(await result.toolCalls).toHaveLength(1);
          expect(await result.finishReason).toBe(
            reason === "interrupted" ? "interrupted" : "tool-calls"
          );
          expect(execute).toHaveBeenCalledTimes(
            reason === "interrupted" ? 0 : 1
          );
        });
      }
    }
  }
});
