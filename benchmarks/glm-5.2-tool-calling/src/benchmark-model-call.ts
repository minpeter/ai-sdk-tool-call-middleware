import { generateText, streamText } from "ai";

export type BenchmarkTransport = "generate" | "stream";

export function benchmarkTransport(value?: string): BenchmarkTransport {
  const transport = value ?? "generate";
  if (transport === "generate" || transport === "stream") {
    return transport;
  }
  throw new Error("benchmark transport must be generate or stream");
}

export async function runBenchmarkModel(
  options: Parameters<typeof generateText>[0],
  transport: BenchmarkTransport
) {
  if (transport === "generate") {
    const result = await generateText(options);
    return {
      finishReason: result.finishReason,
      rawFinishReason: result.rawFinishReason,
      responseMessages: result.responseMessages,
      text: result.text,
      toolCalls: result.toolCalls,
      usage: result.usage,
    };
  }

  const result = streamText(options);
  const [
    finishReason,
    rawFinishReason,
    responseMessages,
    text,
    toolCalls,
    usage,
  ] = await Promise.all([
    result.finishReason,
    result.rawFinishReason,
    result.responseMessages,
    result.text,
    result.toolCalls,
    result.usage,
  ]);
  return {
    finishReason,
    rawFinishReason,
    responseMessages,
    text,
    toolCalls,
    usage,
  };
}
