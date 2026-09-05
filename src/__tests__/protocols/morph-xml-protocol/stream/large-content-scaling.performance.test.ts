import {
  isJSONObject,
  type JSONSchema7,
  type JSONValue,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  requireToolCall,
  runProtocolTextStream,
} from "../../shared/duplicate-harness";
import { chunkText } from "../heuristic-test-harness";

const fullProgressParseWork = vi.hoisted(() => ({ characters: 0 }));

vi.mock(
  "../../../../core/protocols/morph-xml-stream-progress",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../core/protocols/morph-xml-stream-progress")
      >();
    return {
      ...actual,
      parseXmlContentForStreamProgressWithMeta: (
        ...args: Parameters<
          typeof actual.parseXmlContentForStreamProgressWithMeta
        >
      ) => {
        fullProgressParseWork.characters += args[0].toolContent.length;
        return actual.parseXmlContentForStreamProgressWithMeta(...args);
      },
    };
  }
);

function writeFileSchema(): JSONSchema7 {
  const textProperty: JSONSchema7 = { type: "string" };
  return {
    type: "object",
    properties: { path: textProperty, content: textProperty },
    required: ["path", "content"],
  };
}

function writeFileTool(): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name: "write_file",
    description: "write a file",
    inputSchema: writeFileSchema(),
  };
}

const tools = [writeFileTool()];

async function streamLargeToolCall(lines: number): Promise<{
  readonly input: string;
  readonly textLength: number;
}> {
  const body = Array.from(
    { length: lines },
    (_, index) => `line ${index}: const value_${index} = compute(${index});`
  ).join("\n");
  const text = `<write_file>\n<path>src/out.ts</path>\n<content>\n${body}\n</content>\n</write_file>`;
  const parts = await runProtocolTextStream({
    protocol: morphXmlProtocol(),
    tools,
    id: "1",
    chunks: chunkText(text, 30),
  });
  return { input: requireToolCall(parts).input, textLength: text.length };
}

describe("morph-xml large streamed tool call scaling", () => {
  // Before #396, each 30-character chunk reparsed the accumulated XML
  // progress (O(n^2), roughly 2.6s on its development setup). The incremental
  // path limits full progress parsing to about 2x input length, so this linear
  // work budget preserves the original ~40x algorithmic regression signal
  // without depending on coverage instrumentation or runner speed.
  it("bounds full progress parsing work for a ~173KB streamed string argument", async () => {
    fullProgressParseWork.characters = 0;
    const { input, textLength } = await streamLargeToolCall(4000);

    const parsed: JSONValue = JSON.parse(input);
    if (
      !isJSONObject(parsed) ||
      typeof parsed.path !== "string" ||
      typeof parsed.content !== "string"
    ) {
      throw new TypeError("Expected a streamed write_file input");
    }
    expect(parsed.path).toBe("src/out.ts");
    expect(parsed.content).toContain("line 3999:");
    expect(fullProgressParseWork.characters).toBeLessThan(textLength * 3);
  }, 30_000);
});
