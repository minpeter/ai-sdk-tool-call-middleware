import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

function fileTool(
  name: string,
  properties: LanguageModelV4FunctionTool["inputSchema"]
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    description: "Write a file",
    inputSchema: properties,
  };
}

const writeFile = fileTool("write_file", {
  type: "object",
  properties: {
    file_path: { type: "string" },
    content: { type: "string" },
    encoding: { type: "string" },
  },
  required: ["file_path", "content"],
});

const fileWrite = fileTool("file_write", {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
});

function chunkParts(parts: readonly string[], size: number): string[] {
  const chunks: string[] = [];
  for (const part of parts) {
    for (let index = 0; index < part.length; index += size) {
      chunks.push(part.slice(index, index + size));
    }
  }
  return chunks;
}

function streamMorph(
  chunks: readonly string[],
  tools: LanguageModelV4FunctionTool[],
  parserOptions?: ParserOptions
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    chunks,
    id: "morph-raw-string",
    parserOptions,
    protocol: morphXmlProtocol(),
    tools,
  });
}

const duplicateParts = [
  "<write_file>",
  "<file_path>/tmp/file.txt</file_path>",
  "<content>part1</content>",
  "<content>part2</content>",
  "</write_file>",
];

describe("morphXmlProtocol raw string handling in streaming", () => {
  it("captures raw inner XML for string-typed arg during streaming", async () => {
    const html = "<html><body><h1>Hi</h1><p>World</p></body></html>";
    const chunks = chunkParts(
      [
        "<write_file>",
        "<file_path>/home/username/myfile.html</file_path>",
        "<content>",
        html,
        "</content>",
        "<encoding>utf-8</encoding>",
        "</write_file>",
      ],
      7
    );
    const args = parseToolCallObject(
      requireToolCall(await streamMorph(chunks, [writeFile]))
    );
    expect(args.file_path).toBe("/home/username/myfile.html");
    expect(args.content).toBe(html);
    expect(args.encoding).toBe("utf-8");
  });

  it("error policy cancels the tool call without leaking raw text by default", async () => {
    const out = await streamMorph(chunkParts(duplicateParts, 5), [writeFile]);
    const combined = collectTextDeltas(out);
    expect(combined).not.toContain("<write_file>");
    expect(combined).not.toContain("</write_file>");
    expect(selectToolCalls(out)).toHaveLength(0);
  });

  it("passes structured drop metadata when unclosed XML tool call is not parseable at finish", async () => {
    const onError = vi.fn();
    await streamMorph(
      [
        "<write_file><file_path>/tmp/file.txt</file_path><content>one</content><content>two</content>",
      ],
      [writeFile],
      { onError }
    );
    expect(onError).toHaveBeenCalled();
    const finishErrorCall = onError.mock.calls.find(([message]) =>
      message.includes("Could not complete streaming XML tool call")
    );
    expect(finishErrorCall).toBeDefined();
    const metadata = finishErrorCall?.[1];
    expect(metadata).toMatchObject({
      toolName: "write_file",
      dropReason: "unfinished-tool-call",
    });
    expect(typeof metadata?.toolCallId).toBe("string");
    expect(metadata?.toolCall).toContain("<write_file>");
  });

  it("can emit raw text fallback when explicitly enabled", async () => {
    const out = await streamMorph(chunkParts(duplicateParts, 5), [writeFile], {
      emitRawToolCallTextOnError: true,
    });
    const combined = collectTextDeltas(out);
    expect(combined).toContain("<write_file>");
    expect(combined).toContain("</write_file>");
    expect(selectToolCalls(out)).toHaveLength(0);
  });

  it("captures DOCTYPE HTML inside string-typed <content> during streaming (user-reported)", async () => {
    const html = `<!DOCTYPE html>\n<html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-width, initial-scale=1.0"> <title>Simple HTML Page</title> </head> <body> <h1>Hello World!</h1> <p>This is a simple HTML file.</p> <button>Click Me</button> </body> </html>`;
    const chunks = chunkParts(
      [
        "<file_write>",
        "<path>index.html</path>",
        "<content>",
        html,
        "</content>",
        "</file_write>",
      ],
      11
    );
    const args = parseToolCallObject(
      requireToolCall(await streamMorph(chunks, [fileWrite]))
    );
    expect(args.path).toBe("index.html");
    expect(args.content).toBe(html);
  });

  it("decodes entity-escaped HTML inside string-typed <content> during streaming", async () => {
    const htmlRaw = "<!DOCTYPE html>\n<html><body><h1>안녕</h1></body></html>";
    const htmlEscaped =
      "&lt;!DOCTYPE html&gt;\n&lt;html&gt;&lt;body&gt;&lt;h1&gt;안녕&lt;/h1&gt;&lt;/body&gt;&lt;/html&gt;";
    const chunks = chunkParts(
      [
        "<file_write>",
        "<path>index.html</path>",
        "<content>",
        htmlEscaped,
        "</content>",
        "</file_write>",
      ],
      13
    );
    const args = parseToolCallObject(
      requireToolCall(await streamMorph(chunks, [fileWrite]))
    );
    expect(args.path).toBe("index.html");
    expect(args.content).toBe(htmlRaw);
  });
});
