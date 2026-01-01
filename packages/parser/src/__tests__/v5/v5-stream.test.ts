import { wrapLanguageModel } from "ai-v5";
import { describe, expect, it } from "vitest";
import { morphXmlToolMiddleware } from "../../v5/index";

describe("V5 Stream Compatibility", () => {
  it("should transform v3 stream to valid v2 stream", async () => {
    const mockModel: any = {
      specificationVersion: "v3",
      provider: "test",
      modelId: "test-model",
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Hello" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1 },
            });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: "hi", rawSettings: {} },
      }),
    };

    const wrappedModel = wrapLanguageModel({
      model: mockModel,
      middleware: morphXmlToolMiddleware as any,
    });

    const { stream } = await (wrappedModel as any).doStream({
      prompt: [],
      inputFormat: "messages",
      mode: { type: "regular" },
    });

    const reader = stream.getReader();
    const parts: any[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parts.push(value);
    }

    // console.log("Transformed V2 Parts:", JSON.stringify(parts, null, 2));

    expect(parts.some((p: any) => p.type === "text-start")).toBe(true);
    expect(
      parts.some((p: any) => p.type === "text-delta" && p.delta === "Hello")
    ).toBe(true);
  });
});
