import type {
  JSONSchema7Definition,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  collectTextDeltas,
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

function morphTool(
  name: string,
  description: string,
  properties: Record<string, JSONSchema7Definition>
): LanguageModelV4FunctionTool {
  return {
    description,
    inputSchema: { properties, type: "object" },
    name,
    type: "function",
  };
}

function runSuccess(
  chunks: readonly string[],
  tools: LanguageModelV4FunctionTool[]
) {
  return runProtocolTextStream({
    chunks,
    id: "morph-success-core",
    protocol: morphXmlProtocol(),
    tools,
  });
}

function expectHidden(text: string, tags: readonly string[]): void {
  for (const tag of tags) {
    expect(text).not.toContain(tag);
  }
}

const weatherTool = morphTool("get_weather", "Get weather for a city", {
  city: { type: "string" },
});

describe("morphXmlProtocol streaming success core path", () => {
  it("parses <tool>...</tool> into tool-call and flushes pending text", async () => {
    const out = await runSuccess(
      ["pre ", "<calc><a>1</a><b> 2 </b></calc>", " post"],
      [
        {
          type: "function",
          name: "calc",
          description: "",
          inputSchema: { type: "object" },
        },
      ]
    );
    const tool = requireToolCall(out);
    const text = collectTextDeltas(out);
    expect(tool.toolName).toBe("calc");
    expect(parseToolCallObject(tool)).toEqual({ a: 1, b: 2 });
    expect(text).toContain("pre ");
    expect(text).toContain(" post");
    expect(out.some((part) => part.type === "text-end")).toBe(true);
  });

  it("does not expose nested XML tags in text output", async () => {
    const out = await runSuccess(
      [
        "Let me check the weather.\n\n",
        "<get_weather>\n  <city>New York</city>\n</get_weather>",
        "\n\nThe weather looks good!",
      ],
      [weatherTool]
    );
    const tool = requireToolCall(out);
    const fullText = collectTextDeltas(out);
    expect(tool.toolName).toBe("get_weather");
    expect(parseToolCallObject(tool)).toEqual({ city: "New York" });
    expectHidden(fullText, [
      "<city>",
      "</city>",
      "<get_weather>",
      "</get_weather>",
    ]);
    expect(fullText).toContain("Let me check the weather.");
    expect(fullText).toContain("The weather looks good!");
  });

  it("handles multiple consecutive tool calls without exposing XML tags", async () => {
    const locationTool = morphTool("get_location", "Get user location", {});
    const out = await runSuccess(
      [
        "First, ",
        "<get_location></get_location>",
        " then ",
        "<get_weather>\n  <city>Tokyo</city>\n</get_weather>",
        " done!",
      ],
      [locationTool, weatherTool]
    );
    const toolCalls = selectToolCalls(out);
    const fullText = collectTextDeltas(out);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.toolName).toBe("get_location");
    expect(toolCalls[1]?.toolName).toBe("get_weather");
    expectHidden(fullText, [
      "<get_location>",
      "</get_location>",
      "<get_weather>",
      "</get_weather>",
      "<city>",
      "</city>",
    ]);
    expect(fullText).toContain("First,");
    expect(fullText).toContain(" then ");
    expect(fullText).toContain(" done!");
  });

  it("handles deeply nested XML parameters without exposing internal tags", async () => {
    const emailTool = morphTool("send_email", "Send an email", {
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
    });
    const out = await runSuccess(
      [
        "Sending email:\n",
        "<send_email>\n  <to>user@example.com</to>\n  <subject>Hello World</subject>\n  <body>This is a test message.</body>\n</send_email>",
        "\nEmail sent!",
      ],
      [emailTool]
    );
    const tool = requireToolCall(out);
    const fullText = collectTextDeltas(out);
    expect(tool.toolName).toBe("send_email");
    expect(parseToolCallObject(tool)).toEqual({
      to: "user@example.com",
      subject: "Hello World",
      body: "This is a test message.",
    });
    expectHidden(fullText, [
      "<send_email>",
      "</send_email>",
      "<to>",
      "<subject>",
      "<body>",
    ]);
    expect(fullText).toContain("Sending email:");
    expect(fullText).toContain("Email sent!");
  });

  it("handles tool call split across multiple chunks without exposing tags", async () => {
    const calculateTool = morphTool("calculate", "Perform calculation", {
      operation: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
    });
    const out = await runSuccess(
      [
        "Computing: ",
        "<calculate>\n",
        "  <operation>",
        "add",
        "</operation>\n",
        "  <x>10</x>\n",
        "  <y>20</y>\n",
        "</calculate>",
        "\nResult ready!",
      ],
      [calculateTool]
    );
    const tool = requireToolCall(out);
    const fullText = collectTextDeltas(out);
    expect(tool.toolName).toBe("calculate");
    expect(parseToolCallObject(tool)).toEqual({
      operation: "add",
      x: 10,
      y: 20,
    });
    expectHidden(fullText, [
      "<calculate>",
      "</calculate>",
      "<operation>",
      "<x>",
      "<y>",
    ]);
    expect(fullText).toContain("Computing:");
    expect(fullText).toContain("Result ready!");
  });

  it("handles array parameters with repeated tags without exposing internal XML", async () => {
    const messagesTool = morphTool(
      "send_messages",
      "Send messages to multiple recipients",
      {
        recipient: { type: "array", items: { type: "string" } },
        message: { type: "string" },
      }
    );
    const out = await runSuccess(
      [
        "Sending to all:\n",
        "<send_messages>\n  <recipient>alice@example.com</recipient>\n  <recipient>bob@example.com</recipient>\n  <message>Hello!</message>\n</send_messages>",
        "\nMessages sent!",
      ],
      [messagesTool]
    );
    const args = parseToolCallObject(requireToolCall(out));
    const fullText = collectTextDeltas(out);
    expect(args.recipient).toEqual(["alice@example.com", "bob@example.com"]);
    expect(args.message).toBe("Hello!");
    expectHidden(fullText, [
      "<send_messages>",
      "</send_messages>",
      "<recipient>",
      "</recipient>",
      "<message>",
      "</message>",
    ]);
    expect(fullText).toContain("Sending to all:");
    expect(fullText).toContain("Messages sent!");
  });
});
