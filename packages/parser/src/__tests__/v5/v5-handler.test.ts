import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";
import { wrapStreamV5 } from "../../v5/stream-handler";

describe("V5 Stream Handler Deep Dive", () => {
  it("should show me exactly what is happening in the stream", async () => {
    const mockV3Stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", textDelta: "Hello" });
        controller.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        } as any);
        controller.close();
      },
    });

    const protocol = morphXmlProtocol();
    const parser = protocol.createStreamParser({ tools: [], options: {} });

    const parserReader = mockV3Stream.pipeThrough(parser).getReader();
    const parsedParts: any[] = [];
    while (true) {
      const { done, value } = await parserReader.read();
      if (done) {
        break;
      }
      parsedParts.push(value);
    }
    process.stdout.write(
      `Parser Output Parts: ${JSON.stringify(parsedParts, null, 2)}\n`
    );

    const mockV3Stream2 = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", textDelta: "Hello" });
        controller.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        } as any);
        controller.close();
      },
    });

    const result = await wrapStreamV5({
      protocol: morphXmlProtocol(),
      doStream: async () => ({ stream: mockV3Stream2 }),
      params: { providerOptions: {} },
    });

    const reader = result.stream.getReader();
    const finalParts: any[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      finalParts.push(value);
    }

    process.stdout.write(
      `Final V2 Parts: ${JSON.stringify(finalParts, null, 2)}\n`
    );

    expect(
      finalParts.some(
        (p: any) => p.type === "text-delta" && p.delta === "Hello"
      )
    ).toBe(true);
  });
});
