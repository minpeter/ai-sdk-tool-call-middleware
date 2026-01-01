import { streamText, wrapLanguageModel } from "ai-v5";
import { morphXmlToolMiddleware } from "./src/v5";

// Mock Language Model that emits XML stream with random IDs
const createMockModel = (chunks: string[]): any => {
  return {
    specificationVersion: "v1",
    provider: "mock-v5",
    modelId: "mock-model",
    defaultObjectGenerationMode: "json",
    doStream: async () => {
      const stream = new ReadableStream({
        async start(controller) {
          // Simulate random ID for text parts
          const randomId = "text-" + Math.random().toString(36).substring(7);

          for (const chunk of chunks) {
            controller.enqueue({
              type: "text-delta",
              textDelta: chunk,
            });
            await new Promise((r) => setTimeout(r, 10));
          }
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 0, completionTokens: 0 },
          });
          controller.close();
        },
      });
      return { stream, rawCall: { rawPrompt: "", rawSettings: {} } };
    },
    doGenerate: async () => {
      throw new Error("Not implemented");
    },
  };
};

async function runTest() {
  console.log("--- Starting V5 Pure Test --");

  const model = wrapLanguageModel({
    model: createMockModel(["Hi", " there", "!"]),
    middleware: morphXmlToolMiddleware as any,
  });

  try {
    const result = await streamText({
      model,
      prompt: "Say hi",
    });

    for await (const part of result.fullStream) {
      console.log("Part type:", part.type, "ID:", (part as any).id);
    }
    console.log("--- Test Finished Successfully ---");
  } catch (error) {
    console.error("--- Test Failed ---");
    console.error(error);
    process.exit(1);
  }
}

runTest();
