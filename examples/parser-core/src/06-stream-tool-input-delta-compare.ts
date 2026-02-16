import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { jsonProtocol } from "../../../src/core/protocols/json-protocol";
import { xmlProtocol } from "../../../src/core/protocols/xml-protocol";
import { yamlProtocol } from "../../../src/core/protocols/yaml-protocol";

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

const scenarios = [
  {
    name: "JSON protocol",
    parser: jsonProtocol().createStreamParser({ tools: [tool] }),
    chunks: [
      "Before ",
      '<tool_call>{"na',
      'me":"get_weather","arg',
      'uments":{"location":"Seo',
      'ul","unit":"celsius"}}',
      "</tool_call>",
      " After",
    ],
    rawSnapshot: [
      'tool-input-delta(id=example, delta="{"location":"Seo")',
      'tool-input-delta(id=example, delta="ul","unit":"celsius"}")',
    ],
  },
  {
    name: "XML protocol",
    parser: xmlProtocol().createStreamParser({ tools: [tool] }),
    chunks: [
      "Before ",
      "<get_weather>\n<location>Seo",
      "ul</location>\n<unit>celsius</unit>\n",
      "</get_weather>",
      " After",
    ],
    rawSnapshot: [
      'tool-input-delta(id=example, delta="\\n")',
      'tool-input-delta(id=example, delta="<location>Seoul</location>\\n<unit>ce")',
      'tool-input-delta(id=example, delta="lsius</unit>\\n")',
    ],
  },
  {
    name: "YAML protocol",
    parser: yamlProtocol().createStreamParser({ tools: [tool] }),
    chunks: [
      "Before ",
      "<get_weather>\nlocation: Seo",
      "ul\nunit: celsius\n",
      "</get_weather>",
      " After",
    ],
    rawSnapshot: [
      'tool-input-delta(id=example, delta="\\n")',
      'tool-input-delta(id=example, delta="location: Seoul\\nu")',
      'tool-input-delta(id=example, delta="nit: celsius\\n")',
    ],
  },
];

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

function printComparison(name: string, allParts: LanguageModelV3StreamPart[]) {
  const legacyView = allParts.filter(
    (part) =>
      part.type !== "tool-input-start" &&
      part.type !== "tool-input-delta" &&
      part.type !== "tool-input-end"
  );

  console.log(`\n=== ${name} ===`);
  console.log("\n[Legacy view: tool-call only]");
  for (const part of legacyView) {
    console.log(`- ${formatPart(part)}`);
  }

  console.log("\n[Current view: parsed-object streaming tool input]");
  for (const part of allParts) {
    console.log(`- ${formatPart(part)}`);
  }
}

async function main() {
  for (const scenario of scenarios) {
    const parsedStream = createInputStream(scenario.chunks).pipeThrough(
      scenario.parser as unknown as TransformStream
    );
    const parts = await readAll(parsedStream);
    printComparison(scenario.name, parts);
    console.log("\n[Raw delta snapshot (before XML/YAML object-delta change)]");
    for (const line of scenario.rawSnapshot) {
      console.log(`- ${line}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
