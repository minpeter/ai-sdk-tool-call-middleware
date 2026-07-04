import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";

// Malformed-but-recoverable shapes captured verbatim from live models
// (Qwen2.5-7B, GLM-4.7, Llama 3.1 8B) running under the Qwen3Coder prompt.

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

const sendMessageTools = [
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

// Qwen2.5-7B: parameters emitted as bare schema-property tags instead of
// <parameter=NAME> tags; container never closed.
const SCHEMA_PROPERTY_TAGS_OUTPUT = `<tool_call>
<function=write_file>
<path>
fizzbuzz.py
</path>
<content>
"""doc"""

def fizzbuzz(n):
    return str(n)
</content>
</function>`;

// GLM-4.7: call opener missing its leading '<'.
const MISSING_LT_OUTPUT = `<tool_call>function=send_message>
<parameter=recipient>
민석
</parameter>
<parameter=body>
안녕하세요! 오늘 회의는 3시입니다 🚀 <중요>
</parameter>
</function>`;

// GLM-4.7: bare tool name directly after <tool_call>, schema-property tags,
// closed with </NAME>.
const BARE_NAME_OUTPUT = `<tool_call>write_file
<path>fizzbuzz.py</path>
<content>"""doc"""

def fizzbuzz(n):
    return str(n)
</content>
</write_file>`;

// Llama 3.1 8B: tool name as element text with an immediate close, followed
// by nameless parameter tags.
const NAME_AS_TEXT_OUTPUT = `<tool_call>
<function>send_message</function>
<parameter>recipient</parameter>
민석
<parameter>body</parameter>
안녕하세요! 오늘 회의는 3시입니다 🚀 <중요>
</function>
</tool_call>`;

function toChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

const cases = [
  {
    name: "schema-property parameter tags (Qwen2.5)",
    text: SCHEMA_PROPERTY_TAGS_OUTPUT,
    tools: writeFileTools,
    toolName: "write_file",
    expectInput: (input: Record<string, unknown>) => {
      expect(input.path).toBe("fizzbuzz.py");
      expect(input.content).toContain("def fizzbuzz(n):");
      expect(input.content).toContain('"""doc"""');
    },
  },
  {
    name: "call opener missing leading '<' (GLM-4.7)",
    text: MISSING_LT_OUTPUT,
    tools: sendMessageTools,
    toolName: "send_message",
    expectInput: (input: Record<string, unknown>) => {
      expect(input).toEqual({
        recipient: "민석",
        body: "안녕하세요! 오늘 회의는 3시입니다 🚀 <중요>",
      });
    },
  },
  {
    name: "bare tool name plus </NAME> close (GLM-4.7)",
    text: BARE_NAME_OUTPUT,
    tools: writeFileTools,
    toolName: "write_file",
    expectInput: (input: Record<string, unknown>) => {
      expect(input.path).toBe("fizzbuzz.py");
      expect(input.content).toContain("def fizzbuzz(n):");
    },
  },
  {
    name: "tool name as call-tag element text (Llama 3.1 8B)",
    text: NAME_AS_TEXT_OUTPUT,
    tools: sendMessageTools,
    toolName: "send_message",
    expectInput: (input: Record<string, unknown>) => {
      expect(input).toEqual({
        recipient: "민석",
        body: "안녕하세요! 오늘 회의는 3시입니다 🚀 <중요>",
      });
    },
  },
];

describe("qwen3CoderProtocol live-variant salvage", () => {
  for (const testCase of cases) {
    it(`recovers ${testCase.name} in parseGeneratedText`, () => {
      const p = qwen3CoderProtocol();
      const out = p.parseGeneratedText({
        text: testCase.text,
        tools: testCase.tools,
      });

      const call = out.find((part) => part.type === "tool-call");
      if (call?.type !== "tool-call") {
        throw new Error("Expected tool-call part");
      }
      expect(call.toolName).toBe(testCase.toolName);
      testCase.expectInput(JSON.parse(call.input));
    });

    for (const chunkSize of [1, 7]) {
      it(`recovers ${testCase.name} when streamed with chunk size ${chunkSize}`, async () => {
        const p = qwen3CoderProtocol();
        const out = await convertReadableStreamToArray(
          pipeWithTransformer(
            createChunkedStream(toChunks(testCase.text, chunkSize)),
            p.createStreamParser({ tools: testCase.tools })
          )
        );

        const call = out.find((part) => part.type === "tool-call");
        if (call?.type !== "tool-call") {
          throw new Error("Expected streamed tool-call part");
        }
        expect(call.toolName).toBe(testCase.toolName);
        testCase.expectInput(JSON.parse(call.input));

        const joinedDeltas = out
          .filter(
            (part) =>
              part.type === "tool-input-delta" && part.id === call.toolCallId
          )
          .map((part) => (part as { delta: string }).delta)
          .join("");
        expect(joinedDeltas).toBe(call.input);

        const leakedText = out
          .filter((part) => part.type === "text-delta")
          .map((part) => (part as { delta: string }).delta)
          .join("");
        expect(leakedText).not.toContain("<tool_call");
        expect(leakedText).not.toContain("<parameter");
      });
    }
  }

  it("streamed progress deltas never leak closing-tag fragments", async () => {
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call>\n<function=write_file>\n<parameter=path>\n/src\n</parameter>\n</function>\n</tool_call>";
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream(toChunks(text, 1)),
        p.createStreamParser({ tools: writeFileTools })
      )
    );
    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected streamed tool-call part");
    }
    const joinedDeltas = out
      .filter(
        (part) =>
          part.type === "tool-input-delta" && part.id === call.toolCallId
      )
      .map((part) => (part as { delta: string }).delta)
      .join("");
    expect(joinedDeltas).toBe(call.input);
    expect(joinedDeltas).not.toContain("</parameter");
    expect(JSON.parse(call.input)).toEqual({ path: "/src" });
  });

  it("holds back a split surrogate pair from progress deltas", async () => {
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call>\n<function=send_message>\n<parameter=recipient>\n민석\n</parameter>\n<parameter=body>\ngo 🚀 now\n</parameter>\n</function>\n</tool_call>";
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream(toChunks(text, 1)),
        p.createStreamParser({ tools: sendMessageTools })
      )
    );
    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected streamed tool-call part");
    }
    const joinedDeltas = out
      .filter(
        (part) =>
          part.type === "tool-input-delta" && part.id === call.toolCallId
      )
      .map((part) => (part as { delta: string }).delta)
      .join("");
    expect(joinedDeltas).toBe(call.input);
    expect(JSON.parse(call.input)).toEqual({
      recipient: "민석",
      body: "go 🚀 now",
    });
  });
});

describe("qwen3CoderProtocol value-element wrapper salvage", () => {
  it("unwraps a literal <value> element around a parameter value", () => {
    const tools = [
      {
        type: "function" as const,
        name: "set_alarm",
        description: "Set an alarm.",
        inputSchema: {
          type: "object",
          properties: { volume: { type: "number" } },
          required: ["volume"],
        },
      },
    ];
    const p = qwen3CoderProtocol();
    const out = p.parseGeneratedText({
      text: "<tool_call>\n<function=set_alarm>\n<parameter=volume>\n<value>0.8</value>\n</parameter>\n</function>\n</tool_call>",
      tools,
    });
    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(JSON.parse(call.input)).toEqual({ volume: 0.8 });
  });
});
