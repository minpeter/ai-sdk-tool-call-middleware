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

describe("morphXmlProtocol PostHog send_message regressions", () => {
  it("recovers a send_message tool call whose body is plain visible copy", () => {
    const { input, text } =
      parseSendMessage(`今のトレンドですね、何が流行っているか調べてみます。
<send_message>生成AIの日常への溶け込みや、セルフ式ラーメンなどが話題だよ。</send_message>`);

    expect(input).toEqual({
      message: "生成AIの日常への溶け込みや、セルフ式ラーメンなどが話題だよ。",
    });
    expect(text).toBe("今のトレンドですね、何が流行っているか調べてみます。\n");
  });

  it("recovers flattened card-like content as a safe message fallback", () => {
    const { input, text } = parseSendMessage(`<send_message>
https://xtrend.nikkei.com/atcl/contents/18/01269/00001/
記事を読む
<image_url>https://xtrend.nikkei.com/atcl/contents/18/01269/00001/nxr_m.jpg</image_url>
生成AIの日常への溶け込みや、「セルフ式ラーメン」などの家計と満足度を両立させるグルメが話題だよ。
ヒット予測 “苦労キャンセル”
</send_message>`);

    expect(input.message).toContain(
      "https://xtrend.nikkei.com/atcl/contents/18/01269/00001/"
    );
    expect(input.message).toContain("記事を読む");
    expect(input.message).toContain(
      "https://xtrend.nikkei.com/atcl/contents/18/01269/00001/nxr_m.jpg"
    );
    expect(input.message).not.toContain("<send_message>");
    expect(input.message).not.toContain("<image_url>");
    expect(text).toBe("");
  });

  it("strips compact self-closing XML tags from recovered fallback text", () => {
    const { input } = parseSendMessage(`<send_message>
検索結果です。<debug/>詳細はこちらです。<line-break />ありがとうございました。
</send_message>`);

    expect(input).toEqual({
      message: "検索結果です。詳細はこちらです。ありがとうございました。",
    });
  });
});
