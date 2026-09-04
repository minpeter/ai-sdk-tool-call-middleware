import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { chunkText } from "../../morph-xml-protocol/heuristic-test-harness";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";
import {
  collectGeneratedText,
  parseGeneratedToolInput,
  parseYamlGenerated,
  requireGeneratedToolCall,
  selectGeneratedToolCalls,
} from "./shared";

// Malformed-but-recoverable shapes captured verbatim from live models
// (Mistral Small, IBM Granite 4.0) running under the YAML-XML prompt.
const writeFileTools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
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
{"name":"write_file","arguments":{"path":"fizzbuzz.py","content":"def fizzbuzz(n):\\n    return str(n)\\n","mood":"sunny"}}`;
const PROTOTYPE_SENSITIVE_HERMES_JSON_OUTPUT = `<tool_call>
{"name":"write_file","arguments":{"path":"fizzbuzz.py","content":"body","constructor":{"polluted":true}}}
</tool_call>`;

function streamYaml(text: string, chunkSize: number) {
  return runProtocolTextStream({
    chunks: chunkText(text, chunkSize),
    id: "1",
    protocol: yamlXmlProtocol(),
    tools: writeFileTools,
  });
}

describe("yamlXmlProtocol live-variant salvage", () => {
  it("recovers unquoted multi-line string scalars via schema-keyed salvage", () => {
    const out = parseYamlGenerated(UNQUOTED_MULTILINE_OUTPUT, writeFileTools);
    const call = requireGeneratedToolCall(out);
    const input = parseGeneratedToolInput(call);

    expect(call.toolName).toBe("write_file");
    expect(input.path).toBe("fizzbuzz.py");
    expect(input.content).toContain('"""Classic interview question.');
    expect(input.content).toContain("def fizzbuzz(n):");
    expect(input.content).toContain('return "FizzBuzz"');
  });

  it("preserves leading and trailing whitespace in schema-keyed raw strings", () => {
    const contentWithTrailingSpaces = `   leading spaces
  indented line
${"trailing spaces   "}`;
    const call = requireGeneratedToolCall(
      parseYamlGenerated(
        `<write_file>
path: out.txt
content:${contentWithTrailingSpaces}
</write_file>`,
        writeFileTools
      )
    );

    expect(parseGeneratedToolInput(call).content).toBe(
      "  leading spaces\n  indented line\ntrailing spaces   \n"
    );
  });

  for (const chunkSize of [1, 7]) {
    it(`recovers unquoted multi-line scalars when streamed with chunk size ${chunkSize}`, async () => {
      const out = await streamYaml(UNQUOTED_MULTILINE_OUTPUT, chunkSize);
      const call = requireToolCall(out);
      const input = parseToolCallObject(call);

      expect(call.toolName).toBe("write_file");
      expect(input.path).toBe("fizzbuzz.py");
      expect(input.content).toContain("def fizzbuzz(n):");
    });
  }

  it("salvages Hermes-style JSON inside <tool_call> in parseGeneratedText", () => {
    const call = requireGeneratedToolCall(
      parseYamlGenerated(HERMES_JSON_OUTPUT, writeFileTools)
    );

    expect(call.toolName).toBe("write_file");
    expect(parseGeneratedToolInput(call)).toEqual({
      path: "fizzbuzz.py",
      content: "def fizzbuzz(n):\n    return str(n)\n",
    });
  });

  it("does not treat prefixed wrapper tags as foreign tool_call blocks", () => {
    const text =
      '<tool_callback>\n{"name":"write_file","arguments":{"path":"x.txt","content":"body"}}\n</tool_call>';
    const out = parseYamlGenerated(text, writeFileTools);

    expect(selectGeneratedToolCalls(out)).toHaveLength(0);
    expect(collectGeneratedText(out)).toBe(text);
  });

  it("salvages foreign JSON even when a JSON string mentions a real tool tag", () => {
    const call = requireGeneratedToolCall(
      parseYamlGenerated(
        `<tool_call>
{"name":"write_file","arguments":{"path":"notes.txt","content":"literal <write_file> text"}}
</tool_call>`,
        writeFileTools
      )
    );

    expect(call.toolName).toBe("write_file");
    expect(parseGeneratedToolInput(call)).toEqual({
      path: "notes.txt",
      content: "literal <write_file> text",
    });
  });

  it("does not leak prototype-sensitive foreign JSON in parseGeneratedText", () => {
    const out = parseYamlGenerated(
      PROTOTYPE_SENSITIVE_HERMES_JSON_OUTPUT,
      writeFileTools
    );
    const textOut = collectGeneratedText(out);

    expect(selectGeneratedToolCalls(out)).toHaveLength(0);
    expect(textOut).not.toContain("constructor");
    expect(textOut).not.toContain("<tool_call>");
  });

  for (const chunkSize of [1, 7]) {
    it(`salvages Hermes-style JSON in <tool_call> when streamed with chunk size ${chunkSize}`, async () => {
      const out = await streamYaml(HERMES_JSON_OUTPUT, chunkSize);
      const call = requireToolCall(out);

      expect(call.toolName).toBe("write_file");
      expect(parseToolCallObject(call)).toEqual({
        path: "fizzbuzz.py",
        content: "def fizzbuzz(n):\n    return str(n)\n",
      });
      const leakedText = collectTextDeltas(out);
      expect(leakedText).not.toContain("<tool_call");
      expect(leakedText).not.toContain('{"name"');
      expect(
        selectToolInputTimeline(out)
          .deltas.map((part) => part.delta)
          .join("")
      ).not.toContain("mood");
    });
  }

  for (const chunkSize of [1, 7]) {
    it(`does not leak prototype-sensitive foreign JSON when streamed with chunk size ${chunkSize}`, async () => {
      const out = await streamYaml(
        PROTOTYPE_SENSITIVE_HERMES_JSON_OUTPUT,
        chunkSize
      );
      const textOut = collectTextDeltas(out);

      expect(selectToolCalls(out)).toHaveLength(0);
      expect(textOut).not.toContain("constructor");
      expect(textOut).not.toContain("<tool_call>");
    });
  }

  it("keeps ordinary prose mentioning tool_call as plain text", async () => {
    const text = "The <tool_call> wrapper is not used by this format.";
    const out = await streamYaml(text, 3);

    expect(selectToolCalls(out)).toHaveLength(0);
    expect(collectTextDeltas(out)).toBe(text);
  });
});
