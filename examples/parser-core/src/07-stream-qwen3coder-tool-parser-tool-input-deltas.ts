import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { qwen3coder_tool_parser } from "@ai-sdk-tool/parser";

const tool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get weather information",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      unit: { type: "string" },
    },
    required: ["location"],
  },
};

function createInputStream(chunks: string[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue({
          type: "text-delta",
          id: "demo",
          delta: chunk,
        });
      }
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: 0,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 0,
            text: undefined,
            reasoning: undefined,
          },
        },
      });
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const reader = stream.getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
  }
  return parts;
}

function formatPart(part: LanguageModelV3StreamPart) {
  if (part.type === "text-delta") {
    return `text-delta("${part.delta.replace(/\n/g, "\\n")}")`;
  }
  if (part.type === "tool-input-start") {
    return `tool-input-start(id=${part.id}, name=${part.toolName})`;
  }
  if (part.type === "tool-input-delta") {
    return `tool-input-delta(id=${part.id}, delta="${part.delta.replace(/\n/g, "\\n")}")`;
  }
  if (part.type === "tool-input-end") {
    return `tool-input-end(id=${part.id})`;
  }
  if (part.type === "tool-call") {
    return `tool-call(id=${part.toolCallId}, name=${part.toolName}, input=${part.input})`;
  }
  return part.type;
}

async function main() {
  const protocol = qwen3coder_tool_parser();
  const transformer = protocol.createStreamParser({ tools: [tool] });

  const chunks = [
    "Before ",
    "<tool_call>\n  <function=get_weather>\n    <parameter=location>Seo",
    "ul</parameter>\n    <parameter=unit>celsius</parameter>\n  </function>\n</tool_call>",
    " After",
  ];

  const parsedStream = createInputStream(chunks).pipeThrough(
    transformer as unknown as TransformStream
  );
  const parts = await readAll(parsedStream);

  console.log("\n[Qwen3CoderToolParser stream parts]");
  for (const part of parts) {
    console.log(`- ${formatPart(part)}`);
  }

  const toolCall = parts.find((p) => p.type === "tool-call") as
    | Extract<LanguageModelV3StreamPart, { type: "tool-call" }>
    | undefined;
  if (!toolCall) {
    throw new Error("Expected a tool-call part");
  }

  const joinedDeltas = parts
    .filter(
      (
        p
      ): p is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => p.type === "tool-input-delta" && p.id === toolCall.toolCallId
    )
    .map((p) => p.delta)
    .join("");

  console.log("\n[Joined tool-input-delta]");
  console.log(joinedDeltas);
  console.log("\n[Final tool-call input]");
  console.log(toolCall.input);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
