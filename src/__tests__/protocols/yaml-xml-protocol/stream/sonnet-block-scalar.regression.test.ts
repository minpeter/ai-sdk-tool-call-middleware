import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  createInterleavedStream,
  extractToolInputTimeline,
  runProtocolStreamParser,
} from "../../cross-protocol/tool-input/streaming-events.shared";

const writeFileTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "write_file",
  description: "Write a source file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
};

const saveListTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "save_list",
  inputSchema: {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "string" } },
    },
    required: ["items"],
  },
};

// Exact semantic text-delta boundaries captured from a live
// anthropic/claude-sonnet-4.5 FreeRouter response. The provider emitted a raw
// event immediately before every one of these deltas.
const SONNET_45_TEXT_DELTAS = [
  "<write",
  "_file>\npath",
  ": fiz",
  "zbuzz.py\ncontent: |",
  "\n  ",
  '"""',
  "\n  FizzBuzz implementation",
  " -",
  " a",
  " classic interview question.",
  "\n  \n  Prints numbers from",
  " 1 to n, but for",
  " multiples of ",
  '3 prints "Fizz",',
  '\n  for multiples of 5 prints "Buzz", and for',
  " multiples of both prints",
  ' "FizzBuzz".\n  ',
  '"""',
  "\n  \n  ",
  "\n  def fizzbuzz(n):",
  "\n      ",
  '"""\n      Returns the',
  " F",
  "izzBuzz value",
  " for a",
  " given number.",
  "\n      \n      Args:\n          ",
  "n:",
  " An",
  " integer to",
  " evaluate",
  "\n          \n      Returns:\n          ",
  '"',
  "F",
  'izzBuzz" if',
  " n is divis",
  "ible by both",
  " 3 and 5,",
  '\n          "Fizz" if',
  " n is divisible by",
  ' 3,\n          "Buzz',
  '" if n is divisible by ',
  "5,\n          str(n)",
  " otherwise",
  '\n      """\n      if n %',
  " 3",
  " == 0 and n %",
  " 5 == 0:",
  '\n          return "FizzBuzz"',
  "\n      elif n % 3 ",
  '== 0:\n          return "',
  'Fizz"\n      elif n',
  " % 5 == 0:",
  '\n          return "Buzz"',
  "\n      else:\n          return str(",
  "n)\n  \n  ",
  "\n  if",
  ' __name__ == "__main__":',
  "\n      for",
  " i in range(1, 31",
  "):\n          print(fizzbuzz",
  "(i))",
  "\n</content",
  ">\n</write_file>",
] as const;

function interleaveRawEvents(chunks: readonly string[]) {
  return chunks.flatMap<LanguageModelV4StreamPart>((delta) => [
    {
      type: "raw",
      rawValue: { choices: [{ delta: { content: delta } }] },
    },
    { type: "text-delta", id: "sonnet-text", delta },
  ]);
}

function expectOneConsistentCall(parts: LanguageModelV4StreamPart[]) {
  const timeline = extractToolInputTimeline(parts);
  const calls = parts.filter((part) => part.type === "tool-call");

  expect(timeline.starts).toHaveLength(1);
  expect(timeline.ends).toHaveLength(1);
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call?.type !== "tool-call") {
    throw new Error("Expected one tool call");
  }

  expect(timeline.starts[0]?.id).toBe(call.toolCallId);
  expect(timeline.ends[0]?.id).toBe(call.toolCallId);
  expect(timeline.deltas.every((delta) => delta.id === call.toolCallId)).toBe(
    true
  );
  expect(timeline.deltas.map((delta) => delta.delta).join("")).toBe(call.input);
  expect(() => JSON.parse(call.input)).not.toThrow();
  return JSON.parse(call.input) as Record<string, unknown>;
}

describe("yamlXmlProtocol Sonnet block-scalar streaming regression", () => {
  it("replays the exact Sonnet 4.5 chunk sequence without tag leakage or delta mismatch", async () => {
    const onError = vi.fn();
    const parts = await runProtocolStreamParser({
      protocol: yamlXmlProtocol(),
      tools: [writeFileTool],
      parserOptions: { onError },
      stream: createInterleavedStream(
        interleaveRawEvents(SONNET_45_TEXT_DELTAS)
      ),
    });

    const input = expectOneConsistentCall(parts);
    expect(onError).not.toHaveBeenCalled();
    expect(input.path).toBe("fizzbuzz.py");
    expect(input.content).toContain("classic interview question");
    // The captured model mixed an XML child closing tag into its YAML scalar.
    // Preserve it verbatim instead of silently guessing at model intent.
    expect(input.content).toContain("</content>");
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("");
    expect(parts.filter((part) => part.type === "raw")).toHaveLength(
      SONNET_45_TEXT_DELTAS.length
    );
  });

  it("keeps every chunk boundary consistent for all YAML block-scalar header forms", async () => {
    const headers = [
      "|",
      "|-",
      "|+",
      "|2",
      "|2-",
      "|-2",
      ">",
      ">-",
      ">+",
      ">2+ # folded with explicit indentation",
    ];

    for (const header of headers) {
      const text = `<write_file>\npath: example.py\ncontent: ${header}\n  alpha 🧪\n    indented\n  omega\n</write_file>`;
      for (let split = 1; split < text.length; split += 1) {
        const onError = vi.fn();
        const parts = await runProtocolStreamParser({
          protocol: yamlXmlProtocol(),
          tools: [writeFileTool],
          parserOptions: { onError },
          stream: createInterleavedStream(
            interleaveRawEvents([text.slice(0, split), text.slice(split)])
          ),
        });

        const input = expectOneConsistentCall(parts);
        expect(onError, `${header} split at ${split}`).not.toHaveBeenCalled();
        expect(input.path).toBe("example.py");
        expect(input.content).toContain("alpha 🧪");
        expect(input.content).toContain("omega");
      }
    }
  });

  it("keeps multiline quoted scalars consistent at every chunk boundary", async () => {
    const bodies = [
      'content: "alpha 🧪\n  beta\\nvalue\n  omega"',
      "content: 'alpha 🧪\n  beta''s value\n  omega'",
      "content: alpha 🧪\n  beta value\n  omega",
    ];

    for (const body of bodies) {
      const text = `<write_file>\npath: example.py\n${body}\n</write_file>`;
      for (let split = 1; split < text.length; split += 1) {
        const onError = vi.fn();
        const parts = await runProtocolStreamParser({
          protocol: yamlXmlProtocol(),
          tools: [writeFileTool],
          parserOptions: { onError },
          stream: createInterleavedStream(
            interleaveRawEvents([text.slice(0, split), text.slice(split)])
          ),
        });

        const input = expectOneConsistentCall(parts);
        expect(onError, `split at ${split}: ${body}`).not.toHaveBeenCalled();
        expect(input.content).toContain("alpha 🧪");
        expect(input.content).toContain("omega");
      }

      const onError = vi.fn();
      const characterParts = await runProtocolStreamParser({
        protocol: yamlXmlProtocol(),
        tools: [writeFileTool],
        parserOptions: { onError },
        stream: createInterleavedStream(interleaveRawEvents([...text])),
      });
      const characterInput = expectOneConsistentCall(characterParts);
      expect(onError).not.toHaveBeenCalled();
      expect(characterInput.content).toContain("alpha 🧪");
      expect(characterInput.content).toContain("omega");
    }
  });

  it("covers CRLF, blank lines, and block scalars nested in sequences", async () => {
    const fixtures = [
      {
        text: "<write_file>\r\npath: windows.py\r\ncontent: |-\r\n  alpha\r\n\r\n  omega\r\n</write_file>",
        tools: [writeFileTool],
        assertInput(input: Record<string, unknown>) {
          expect(input).toEqual({
            path: "windows.py",
            content: "alpha\n\nomega",
          });
        },
      },
      {
        text: "<save_list>\nitems:\n  - |-\n    alpha\n      indented\n  - >+\n    beta\n    gamma\n\n</save_list>",
        tools: [saveListTool],
        assertInput(input: Record<string, unknown>) {
          expect(input).toEqual({
            items: ["alpha\n  indented", "beta gamma\n\n"],
          });
        },
      },
    ];

    for (const fixture of fixtures) {
      for (let split = 1; split < fixture.text.length; split += 1) {
        const onError = vi.fn();
        const parts = await runProtocolStreamParser({
          protocol: yamlXmlProtocol(),
          tools: fixture.tools,
          parserOptions: { onError },
          stream: createInterleavedStream(
            interleaveRawEvents([
              fixture.text.slice(0, split),
              fixture.text.slice(split),
            ])
          ),
        });

        const input = expectOneConsistentCall(parts);
        expect(onError, `split at ${split}`).not.toHaveBeenCalled();
        fixture.assertInput(input);
      }
    }
  });
});
