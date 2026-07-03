import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";

// Malformed-but-recoverable shapes captured verbatim from live models
// (Mistral Small, IBM Granite 4.0) running under the YAML-XML prompt.

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

// Mistral Small: multi-line string value emitted as an unquoted plain scalar
// starting with a Python docstring — invalid YAML.
const UNQUOTED_MULTILINE_OUTPUT = `<write_file>
path: fizzbuzz.py
content: """Classic interview question.

The FizzBuzz problem: for numbers 1 to n, return:
- "Fizz" if divisible by 3
- "Buzz" if divisible by 5
"""

def fizzbuzz(n):
    """Return the FizzBuzz result."""
    if n % 15 == 0:
        return "FizzBuzz"
    return str(n)
</write_file>`;

// IBM Granite 4.0: Hermes-style JSON payload inside a <tool_call> wrapper,
// unclosed and with an unbalanced tail.
const HERMES_JSON_OUTPUT = `<tool_call>
{"name":"write_file","arguments":{"path":"fizzbuzz.py","content":"def fizzbuzz(n):\\n    return str(n)\\n"}}`;

function toChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

describe("yamlXmlProtocol live-variant salvage", () => {
  it("recovers unquoted multi-line string scalars via schema-keyed salvage", () => {
    const p = yamlXmlProtocol();
    const out = p.parseGeneratedText({
      text: UNQUOTED_MULTILINE_OUTPUT,
      tools: writeFileTools,
    });

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("write_file");
    const input = JSON.parse(call.input) as Record<string, string>;
    expect(input.path).toBe("fizzbuzz.py");
    expect(input.content).toContain('"""Classic interview question.');
    expect(input.content).toContain("def fizzbuzz(n):");
    expect(input.content).toContain('return "FizzBuzz"');
  });

  for (const chunkSize of [1, 7]) {
    it(`recovers unquoted multi-line scalars when streamed with chunk size ${chunkSize}`, async () => {
      const p = yamlXmlProtocol();
      const out = await convertReadableStreamToArray(
        pipeWithTransformer(
          createChunkedStream(toChunks(UNQUOTED_MULTILINE_OUTPUT, chunkSize)),
          p.createStreamParser({ tools: writeFileTools })
        )
      );

      const call = out.find((part) => part.type === "tool-call");
      if (call?.type !== "tool-call") {
        throw new Error("Expected streamed tool-call part");
      }
      expect(call.toolName).toBe("write_file");
      const input = JSON.parse(call.input) as Record<string, string>;
      expect(input.path).toBe("fizzbuzz.py");
      expect(input.content).toContain("def fizzbuzz(n):");
    });
  }

  it("salvages Hermes-style JSON inside <tool_call> in parseGeneratedText", () => {
    const p = yamlXmlProtocol();
    const out = p.parseGeneratedText({
      text: HERMES_JSON_OUTPUT,
      tools: writeFileTools,
    });

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("write_file");
    expect(JSON.parse(call.input)).toEqual({
      path: "fizzbuzz.py",
      content: "def fizzbuzz(n):\n    return str(n)\n",
    });
  });

  for (const chunkSize of [1, 7]) {
    it(`salvages Hermes-style JSON in <tool_call> when streamed with chunk size ${chunkSize}`, async () => {
      const p = yamlXmlProtocol();
      const out = await convertReadableStreamToArray(
        pipeWithTransformer(
          createChunkedStream(toChunks(HERMES_JSON_OUTPUT, chunkSize)),
          p.createStreamParser({ tools: writeFileTools })
        )
      );

      const call = out.find((part) => part.type === "tool-call");
      if (call?.type !== "tool-call") {
        throw new Error("Expected streamed tool-call part");
      }
      expect(call.toolName).toBe("write_file");
      expect(JSON.parse(call.input)).toEqual({
        path: "fizzbuzz.py",
        content: "def fizzbuzz(n):\n    return str(n)\n",
      });

      const leakedText = out
        .filter((part) => part.type === "text-delta")
        .map((part) => (part as { delta: string }).delta)
        .join("");
      expect(leakedText).not.toContain("<tool_call");
      expect(leakedText).not.toContain('{"name"');
    });
  }

  it("keeps ordinary prose mentioning tool_call as plain text", async () => {
    const p = yamlXmlProtocol();
    const text = "The <tool_call> wrapper is not used by this format.";
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream(toChunks(text, 3)),
        p.createStreamParser({ tools: writeFileTools })
      )
    );
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    const flushed = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");
    expect(flushed).toBe(text);
  });
});
