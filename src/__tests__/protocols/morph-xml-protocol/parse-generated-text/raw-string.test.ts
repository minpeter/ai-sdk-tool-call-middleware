import {
  isJSONObject,
  type JSONObject,
  type LanguageModelV4Content,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

function objectTool(
  name: string,
  properties: LanguageModelV4FunctionTool["inputSchema"]
): LanguageModelV4FunctionTool {
  return { inputSchema: properties, name, type: "function" };
}

const writeFileTool = objectTool("write_file", {
  type: "object",
  properties: {
    file_path: { type: "string" },
    content: { type: "string" },
    encoding: { type: "string" },
  },
  required: ["file_path", "content"],
});

const fileWriteTool = objectTool("file_write", {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
});

const numbersTool = objectTool("nums", {
  type: "object",
  properties: { data: { type: "array", items: { type: "number" } } },
  required: ["data"],
});

function parseMorph(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  onError?: (message: string) => void
): LanguageModelV4Content[] {
  return runGeneratedJsonRepair({
    parserOptions: { onError },
    protocol: morphXmlProtocol(),
    text,
    tools,
  });
}

function requireArgs(output: LanguageModelV4Content[]): JSONObject {
  const call = output.find((part) => part.type === "tool-call");
  expect(call?.type).toBe("tool-call");
  if (call?.type !== "tool-call") {
    throw new TypeError("Expected Morph XML tool call");
  }
  const parsed = JSON.parse(call.input);
  if (!isJSONObject(parsed)) {
    throw new TypeError("Expected object arguments");
  }
  return parsed;
}

function returnedText(output: LanguageModelV4Content[]): string | undefined {
  return output.find((part) => part.type === "text")?.text;
}

interface RawStringCase {
  readonly expected: JSONObject;
  readonly forbiddenContent?: readonly string[];
  readonly name: string;
  readonly text: string;
  readonly tool: LanguageModelV4FunctionTool;
}

const rawStringCases: readonly RawStringCase[] = [
  {
    name: "treats string-typed args as raw text, not nested XML",
    tool: writeFileTool,
    text: "<write_file><file_path>/home/username/myfile.html</file_path><content><html><body><h1>Title</h1><p>Para</p></body></html></content><encoding>utf-8</encoding></write_file>",
    expected: {
      file_path: "/home/username/myfile.html",
      content: "<html><body><h1>Title</h1><p>Para</p></body></html>",
      encoding: "utf-8",
    },
  },
  {
    name: "preserves HTML with DOCTYPE inside string-typed <content> (user-reported)",
    tool: fileWriteTool,
    text: `<file_write><path>index.html</path><content><!DOCTYPE html>\n<html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-width, initial-scale=1.0"> <title>Simple HTML Page</title> </head> <body> <h1>Hello World!</h1> <p>This is a simple HTML file.</p> <button>Click Me</button> </body> </html></content></file_write>`,
    expected: {
      path: "index.html",
      content: `<!DOCTYPE html>\n<html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-width, initial-scale=1.0"> <title>Simple HTML Page</title> </head> <body> <h1>Hello World!</h1> <p>This is a simple HTML file.</p> <button>Click Me</button> </body> </html>`,
    },
  },
  {
    name: "preserves DOCTYPE HTML when model doesn't escape entities (non-escaped)",
    tool: fileWriteTool,
    text: "<file_write><path>a.html</path><content><!DOCTYPE html>\n<html><body><h1>ok</h1></body></html></content></file_write>",
    expected: {
      path: "a.html",
      content: "<!DOCTYPE html>\n<html><body><h1>ok</h1></body></html>",
    },
  },
  {
    name: "decodes entity-escaped HTML inside string-typed <content>",
    tool: fileWriteTool,
    text: `<file_write><path>index.html</path><content>&lt;!DOCTYPE html&gt;\n&lt;html lang="ko"&gt;&lt;head&gt;&lt;title&gt;테스트 페이지&lt;/title&gt;&lt;/head&gt;&lt;body&gt;&lt;h1&gt;안녕&lt;/h1&gt;&lt;/body&gt;&lt;/html&gt;</content></file_write>`,
    expected: {
      path: "index.html",
      content: `<!DOCTYPE html>\n<html lang="ko"><head><title>테스트 페이지</title></head><body><h1>안녕</h1></body></html>`,
    },
  },
  {
    name: "supports attributes on string-typed tag and preserves only inner raw content (no sibling bleed)",
    tool: writeFileTool,
    text: '<write_file><file_path>/home/u/file.html</file_path><content type="html"><div><h1>Title</h1><p>Para</p><em>italic</em></div></content><encoding>utf-8</encoding></write_file>',
    expected: {
      content: "<div><h1>Title</h1><p>Para</p><em>italic</em></div>",
      file_path: "/home/u/file.html",
      encoding: "utf-8",
    },
    forbiddenContent: ["<file_path>", "<encoding>"],
  },
  {
    name: "preserves nested markup inside string-typed tag even if it looks like sibling tags",
    tool: writeFileTool,
    text: '<write_file><file_path>/home/u/file.html</file_path><content><html lang="en" encoding="utf-8"> <head>   <title>Title</title> </head> <body>   <h1>Title</h1>   <p>Para</p>   <em>italic</em> </body></html></content><encoding>utf-8</encoding></write_file>',
    expected: {
      content:
        '<html lang="en" encoding="utf-8"> <head>   <title>Title</title> </head> <body>   <h1>Title</h1>   <p>Para</p>   <em>italic</em> </body></html>',
      file_path: "/home/u/file.html",
      encoding: "utf-8",
    },
    forbiddenContent: ["<file_path>", "<encoding>"],
  },
  {
    name: "handles nested markup inside string-typed tag that looks like sibling tags",
    tool: writeFileTool,
    text: "<write_file><file_path>/tmp/file.txt</file_path><content>Hello <encoding>not-a-sibling</encoding> World!</content><encoding>utf-8</encoding></write_file>",
    expected: {
      content: "Hello <encoding>not-a-sibling</encoding> World!",
      encoding: "utf-8",
    },
  },
  {
    name: "treats self-closing string-typed tag as empty string and parses siblings",
    tool: writeFileTool,
    text: "<write_file><file_path>/tmp/empty.txt</file_path><content/><encoding>utf-8</encoding></write_file>",
    expected: {
      file_path: "/tmp/empty.txt",
      content: "",
      encoding: "utf-8",
    },
  },
  {
    name: "handles attribute values containing '>' and quotes on string-typed tag",
    tool: writeFileTool,
    text: `<write_file><file_path>/tmp/file.txt</file_path><content data="a > b" note="it's ok">Some text</content><encoding>utf-8</encoding></write_file>`,
    expected: { content: "Some text", encoding: "utf-8" },
  },
  {
    name: "preserves CDATA blocks inside string-typed tag as raw content",
    tool: writeFileTool,
    text: "<write_file><file_path>/tmp/file.txt</file_path><content><![CDATA[<encoding>not-sibling</encoding>]]></content></write_file>",
    expected: { content: "<![CDATA[<encoding>not-sibling</encoding>]]>" },
  },
  {
    name: "coerces numeric-like strings inside <item> to numbers when schema expects numbers",
    tool: numbersTool,
    text: "<nums><data><item>1</item><item>2.5</item><item>1.23e3</item><item>-4.56E-2</item></data></nums>",
    expected: { data: [1, 2.5, 1230, -0.0456] },
  },
  {
    name: "coerces numeric-like items with attributes (#text objects) to numbers when schema expects numbers",
    tool: numbersTool,
    text: '<nums><data><item kind="n"> 10.5 </item><item kind="n">3</item><item kind="n">1e2</item></data></nums>',
    expected: { data: [10.5, 3, 100] },
  },
];

const rejectedRawCases: readonly {
  readonly name: string;
  readonly text: string;
}[] = [
  {
    name: "cancels entire tool call when duplicate string tags are emitted (non-stream)",
    text: "<write_file><file_path>/tmp/file.txt</file_path><content>part1</content><content>part2</content></write_file>",
  },
  {
    name: "selects the shallowest occurrence when same-named tag exists nested and as sibling",
    text: "<write_file><file_path>/tmp/file.txt</file_path><outer><content>nested</content></outer><content>top</content></write_file>",
  },
  {
    name: "cancels when duplicate string-typed tags include a self-closing and non-empty",
    text: "<write_file><file_path>/tmp/file.txt</file_path><content/><content>non-empty</content></write_file>",
  },
];

describe("morphXmlProtocol raw string handling by schema", () => {
  for (const scenario of rawStringCases) {
    it(scenario.name, () => {
      const args = requireArgs(parseMorph(scenario.text, [scenario.tool]));
      expect(args).toMatchObject(scenario.expected);
      for (const forbidden of scenario.forbiddenContent ?? []) {
        expect(String(args.content)).not.toContain(forbidden);
      }
    });
  }

  for (const scenario of rejectedRawCases) {
    it(scenario.name, () => {
      const output = parseMorph(scenario.text, [writeFileTool]);
      expect(returnedText(output)).toBe(scenario.text);
    });
  }

  it("emits onError and returns original text when duplicate string tags are present", () => {
    const text =
      "<write_file><file_path>/tmp/file.txt</file_path><content>A</content><content>B</content></write_file>";
    const messages: string[] = [];
    const out = parseMorph(text, [writeFileTool], (message) => {
      messages.push(message);
    });
    expect(out).toEqual([{ type: "text", text }]);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.toLowerCase()).toContain(
      "could not process xml tool call"
    );
  });
});
