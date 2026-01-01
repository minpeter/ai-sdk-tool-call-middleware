import { streamText, wrapLanguageModel } from "ai-v5";
import { jsonMixProtocol } from "./core/protocols/json-mix-protocol";
import { createToolMiddleware } from "./v5/index";

// Mock V2 Model that emits V2 stream parts
const mockModel = {
  specificationVersion: "v1", // LanguageModelV1 (AI SDK v5)
  provider: "test",
  modelId: "test-model",
  defaultObjectGenerationMode: "json",
  doStream: async () => ({
    stream: new ReadableStream({
      start(controller) {
        // V1/V2 stream simulation
        controller.enqueue({ type: "text-delta", textDelta: "Hello" });
        controller.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5 },
        });
        controller.close();
      },
    }),
    rawCall: { rawPrompt: null, rawSettings: {} },
  }),
};

// Middleware setup
const middleware = createToolMiddleware({
  protocol: jsonMixProtocol(),
  toolSystemPromptTemplate: (tools) => `Tools: ${tools}`,
});

async function run() {
  console.log("Running pure ai@5 test...");

  try {
    // IMPORTANT: Our middleware expects a V3 model internally if we use the V6 handler logic wrapped in V5 adapter.
    // But here we are testing the V5 handler directly.
    // The createToolMiddlewareV5 actually expects to wrap a model.
    // Wait, createToolMiddlewareV5 returns a middleware object { wrapStream, ... }

    // We need to simulate how opencode uses it.
    // opencode uses: wrapLanguageModel({ model: baseModel, middleware: customMiddleware })

    const wrapped = wrapLanguageModel({
      // biome-ignore lint/suspicious/noExplicitAny: test mock object doesn't implement full interface
      model: mockModel as any,
      middleware,
    });

    const result = await streamText({
      model: wrapped,
      prompt: "say hi",
    });

    for await (const part of result.fullStream) {
      console.log("Stream Part:", part);
    }

    const text = await result.text;
    console.log("Final Text:", text);
  } catch (error) {
    console.error("Error:", error);
  }
}

run();
