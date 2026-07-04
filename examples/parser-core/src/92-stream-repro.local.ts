/** Local repro: qwen3coder streaming tool-input-delta tag-fragment leak. */
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { qwen3CoderProtocol } from "../../../src/core/protocols/qwen3coder-protocol";

const tools = [
  {
    type: "function" as const,
    name: "list_dir",
    description: "List files.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

const text = `<tool_call>
<function=list_dir>
<parameter=path>
/src
</parameter>
</function>
</tool_call>`;

async function run(chunkSize: number) {
  const protocol = qwen3CoderProtocol();
  const transformer = protocol.createStreamParser({ tools, options: {} });
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  const source = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue({ type: "text-delta", id: "t", delta: c });
      }
      controller.enqueue({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      controller.close();
    },
  });
  const out = source.pipeThrough(transformer);
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const p of out) {
    parts.push(p);
  }
  const deltas = parts
    .filter((p) => p.type === "tool-input-delta")
    .map((p) => (p as { delta: string }).delta)
    .join("");
  const call = parts.find((p) => p.type === "tool-call") as
    | { input: string }
    | undefined;
  console.log(`chunkSize=${chunkSize}`);
  console.log("  deltas:", JSON.stringify(deltas));
  console.log("  final :", JSON.stringify(call?.input));
  console.log(
    "  match :",
    deltas && call ? JSON.stringify(deltas === call.input) : "n/a"
  );
}

for (const size of [1, 3, 7, 1000]) {
  await run(size);
}
