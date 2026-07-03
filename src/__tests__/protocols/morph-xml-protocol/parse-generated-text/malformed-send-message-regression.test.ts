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

const parseSendMessage = (text: string) => {
  const out = morphXmlProtocol().parseGeneratedText({
    text,
    tools,
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
});
