import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "send_message",
    description: "Send a user-visible message",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        card: {
          type: "object",
          properties: {
            title: { type: "string" },
            message: { type: "string" },
            image_url: { type: "string" },
          },
          required: ["title", "message"],
        },
      },
    },
  },
];

const parseSendMessage = (
  text: string,
  activeTools: LanguageModelV4FunctionTool[] = tools,
  protocolOptions?: Parameters<typeof morphXmlProtocol>[0]
) => {
  const out = morphXmlProtocol(protocolOptions).parseGeneratedText({
    text,
    tools: activeTools,
    options: {},
  });
  const tool = out.find((part) => part.type === "tool-call");
  expect(tool).toBeTruthy();
  return {
    input: JSON.parse((tool as { input: string }).input),
    text: out
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join(""),
  };
};

describe("morphXmlProtocol malformed send_message recovery", () => {
  it("recovers a send_message tool call whose body is plain visible copy", () => {
    const { input, text } =
      parseSendMessage(`I'll summarize the experiment result.
<send_message>The synthetic trial shows that the setup guide and billing checklist are the two most requested follow-up items.</send_message>`);

    expect(input).toEqual({
      message:
        "The synthetic trial shows that the setup guide and billing checklist are the two most requested follow-up items.",
    });
    expect(text).toBe("I'll summarize the experiment result.\n");
  });

  it("recovers flattened card-like content as a safe message fallback", () => {
    const { input, text } = parseSendMessage(`<send_message>
https://example.com/research/synthetic-trends
Read the synthetic report
<image_url>https://example.com/assets/synthetic-trend-card.png</image_url>
The synthetic trend card highlights onboarding automation, budget-friendly team lunches, and weekly planning rituals.
Forecast: practical productivity experiments
</send_message>`);

    expect(input.message).toContain(
      "https://example.com/research/synthetic-trends"
    );
    expect(input.message).toContain("Read the synthetic report");
    expect(input.message).toContain(
      "https://example.com/assets/synthetic-trend-card.png"
    );
    expect(input.message).not.toContain("<send_message>");
    expect(input.message).not.toContain("<image_url>");
    expect(text).toBe("");
  });

  it("strips compact self-closing and mixed-case XML tags from recovered fallback text", () => {
    const { input } = parseSendMessage(`<send_message>
Here is the result.<debug/>More details are available.<LINE-BREAK />Thanks for checking.
</send_message>`);

    expect(input).toEqual({
      message:
        "Here is the result.More details are available.Thanks for checking.",
    });
  });

  it("does not use message fallback when other required fields are present", () => {
    const recipientTools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "send_message",
        description: "Send a user-visible message",
        inputSchema: {
          type: "object",
          properties: {
            recipient: { type: "string" },
            message: { type: "string" },
          },
          required: ["recipient", "message"],
        },
      },
    ];

    const { input } = parseSendMessage(
      "<send_message>Send this synthetic update to the project owner.</send_message>",
      recipientTools
    );

    expect(input).not.toEqual({
      message: "Send this synthetic update to the project owner.",
    });
  });

  it("does not recover plain text for non-message string fields", () => {
    const commandTools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "run_command",
        description: "Run a shell command",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
      },
    ];

    const { input } = parseSendMessage(
      "<run_command>I will inspect the synthetic workspace.</run_command>",
      commandTools
    );

    expect(input).not.toEqual({
      command: "I will inspect the synthetic workspace.",
    });
  });

  it("does not recover an empty message after stripping XML tags", () => {
    const { input } = parseSendMessage(`<send_message>
<debug/><LINE-BREAK />
</send_message>`);

    expect(input).not.toEqual({ message: "" });
  });

  it("decodes XML entities in recovered fallback text", () => {
    const { input } = parseSendMessage(
      "<send_message>Synthetic R&amp;D says 3 &lt; 5 and the plan is ready.</send_message>"
    );

    expect(input).toEqual({
      message: "Synthetic R&D says 3 < 5 and the plan is ready.",
    });
  });

  it("strips XML comments and processing instructions from fallback text", () => {
    const { input } = parseSendMessage(`
<send_message><?draft hidden?><!-- hidden note -->Visible synthetic copy<![CDATA[ with cdata text]]></send_message>`);

    expect(input).toEqual({
      message: "Visible synthetic copy with cdata text",
    });
  });

  it("preserves literal markup inside CDATA fallback text", () => {
    const { input } = parseSendMessage(
      "<send_message><![CDATA[Use <admin> tags in the synthetic snippet.]]></send_message>"
    );

    expect(input).toEqual({
      message: "Use <admin> tags in the synthetic snippet.",
    });
  });

  it("does not replace literal text that resembles a CDATA placeholder", () => {
    const { input } = parseSendMessage(
      "<send_message>Keep \u0000MORPH_XML_CDATA_0\u0000 literal. <![CDATA[Preserve <tag>.]]></send_message>"
    );

    expect(input).toEqual({
      message: "Keep \u0000MORPH_XML_CDATA_0\u0000 literal. Preserve <tag>.",
    });
  });

  it("recovers message fallback from jsonSchema-wrapped schemas", () => {
    const wrappedTools = [
      {
        type: "function",
        name: "send_message",
        description: "Send a user-visible message",
        inputSchema: {
          jsonSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
        },
      },
    ] as unknown as LanguageModelV4FunctionTool[];

    const { input } = parseSendMessage(
      "<send_message>Wrapped synthetic message body.</send_message>",
      wrappedTools
    );

    expect(input).toEqual({
      message: "Wrapped synthetic message body.",
    });
  });

  it("recovers message fallback when the message property schema is wrapped", () => {
    const wrappedMessageTools = [
      {
        type: "function",
        name: "send_message",
        description: "Send a user-visible message",
        inputSchema: {
          type: "object",
          properties: {
            message: { jsonSchema: { type: "string" } },
          },
          required: ["message"],
        },
      },
    ] as unknown as LanguageModelV4FunctionTool[];

    const { input } = parseSendMessage(
      "<send_message>Wrapped property synthetic message.</send_message>",
      wrappedMessageTools
    );

    expect(input).toEqual({
      message: "Wrapped property synthetic message.",
    });
  });

  it("uses optional schema tags as text when only message is required", () => {
    const flattenedTools = [
      {
        type: "function",
        name: "send_message",
        description: "Send a user-visible message",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" },
            image_url: { type: "string" },
          },
          required: ["message"],
        },
      },
    ] as LanguageModelV4FunctionTool[];

    const { input } = parseSendMessage(
      "<send_message>Title <image_url>https://example.com/synthetic.png</image_url> body copy.</send_message>",
      flattenedTools
    );

    expect(input).toEqual({
      message: "Title https://example.com/synthetic.png body copy.",
    });
  });

  it("honors repair false by skipping plain-text fallback recovery", () => {
    const { input } = parseSendMessage(
      "<send_message>Synthetic update without child tags.</send_message>",
      tools,
      { parseOptions: { repair: false } }
    );

    expect(input).not.toEqual({
      message: "Synthetic update without child tags.",
    });
  });
});
