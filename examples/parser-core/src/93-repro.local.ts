/** Local repro of live-model malformed variants, no network. */
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { qwen3CoderProtocol } from "../../../src/core/protocols/qwen3coder-protocol";

const writeFileTools = [
  {
    type: "function" as const,
    name: "write_file",
    description: "Write a file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
];

const sendTools = [
  {
    type: "function" as const,
    name: "send_message",
    description: "Send a chat message.",
    inputSchema: {
      type: "object",
      properties: { recipient: { type: "string" }, body: { type: "string" } },
      required: ["recipient", "body"],
    },
  },
];

const cases: Array<{ label: string; text: string; tools: typeof sendTools }> = [
  {
    label: "V1 qwen2.5: schema-property tags inside <function=>",
    tools: writeFileTools,
    text: `<tool_call>
<function=write_file>
<path>
fizzbuzz.py
</path>
<content>
"""
Classic interview question
"""

def fizzbuzz(n):
    if n % 15 == 0:
        return "FizzBuzz"
    return str(n)
</content>
</function>`,
  },
  {
    label: "V2 glm: <tool_call>function=NAME> missing '<'",
    tools: sendTools,
    text: `<tool_call>function=send_message>
<parameter=recipient>
민석
</parameter>
<parameter=body>
안녕하세요! 오늘 회의는 3시입니다 🚀 <중요>
</parameter>
</function>`,
  },
  {
    label: "V3 glm: bare tool name + property tags + </NAME> close",
    tools: writeFileTools,
    text: `<tool_call>write_file
<path>fizzbuzz.py</path>
<content>"""
FizzBuzz implementation. classic interview question.
"""

def fizzbuzz(n):
    return str(n)
</content>
</write_file>`,
  },
  {
    label: "V4 llama: <function>NAME</function> + nameless params",
    tools: sendTools,
    text: `<tool_call>
<function>send_message</function>
<parameter>recipient</parameter>
민석
<parameter>body</parameter>
안녕하세요! 오늘 회의는 3시입니다 🚀 <중요>
</function>
</tool_call>`,
  },
];

async function streamParse(
  text: string,
  tools: typeof sendTools,
  chunkSize: number
) {
  const protocol = qwen3CoderProtocol();
  const transformer = protocol.createStreamParser({ tools, options: {} });
  const source = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) {
        controller.enqueue({
          type: "text-delta",
          id: "t",
          delta: text.slice(i, i + chunkSize),
        });
      }
      controller.enqueue({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      controller.close();
    },
  });
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const p of source.pipeThrough(transformer)) parts.push(p);
  return parts;
}

for (const c of cases) {
  console.log(`\n===== ${c.label}`);
  const p = qwen3CoderProtocol();
  const errors: string[] = [];
  const out = p.parseGeneratedText({
    text: c.text,
    tools: c.tools,
    options: { onError: (m: string) => errors.push(m) },
  });
  const calls = out.filter((o) => o.type === "tool-call");
  console.log(
    "GEN :",
    calls.length > 0
      ? calls
          .map(
            (call) => `${(call as { toolName: string }).toolName} ${(call as { input: string }).input.slice(0, 120)}`
          )
          .join(" | ")
      : `NO CALL (errors: ${errors.join("; ")})`
  );

  for (const size of [1, 5, 1000]) {
    const parts = await streamParse(c.text, c.tools, size);
    const streamCalls = parts.filter((x) => x.type === "tool-call");
    const deltas = parts
      .filter((x) => x.type === "tool-input-delta")
      .map((x) => (x as { delta: string }).delta)
      .join("");
    console.log(
      `STRM(${size}):`,
      streamCalls.length > 0
        ? streamCalls
            .map(
              (call) => `${(call as { toolName: string }).toolName} ${(call as { input: string }).input.slice(0, 100)}`
            )
            .join(" | ")
        : "NO CALL",
      `deltasOk=${
        streamCalls.length === 1
          ? JSON.stringify(deltas === (streamCalls[0] as { input: string }).input)
          : "n/a"
      }`
    );
  }
}
