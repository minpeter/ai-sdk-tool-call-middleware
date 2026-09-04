import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { parseQwen3CoderGeneratedText } from "../../../../core/protocols/qwen3coder-generated-text";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "search",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
];

function parse(text: string) {
  return parseQwen3CoderGeneratedText({ text, tools });
}

describe("Qwen3Coder generated text coverage", () => {
  it("returns one empty text part for empty generated text", () => {
    // Given: an empty provider response.
    // When: generated text is parsed.
    const result = parse("");

    // Then: the empty response remains observable as text.
    expect(result).toEqual([{ type: "text", text: "" }]);
  });

  it("preserves plain text after removing stray wrapper closes", () => {
    // Given: plain text surrounded by stray closing wrappers.
    // When: generated text is parsed.
    const result = parse("</tool_call>answer</tool_call>");

    // Then: only the user-visible text remains.
    expect(result).toEqual([{ type: "text", text: "answer" }]);
  });

  it("reports and preserves a malformed wrapperless complete call", () => {
    // Given: a complete wrapperless call whose function name is missing.
    const onError = vi.fn();
    const text =
      "before <function><parameter=query>x</parameter></function> after";

    // When: generated text is parsed.
    const result = parseQwen3CoderGeneratedText({
      text,
      tools,
      options: { onError },
    });

    // Then: surrounding and malformed text are preserved and failure is reported.
    expect(result).toEqual([
      { type: "text", text: "before " },
      {
        type: "text",
        text: "<function><parameter=query>x</parameter></function>",
      },
      { type: "text", text: " after" },
    ]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[1]).toMatchObject({
      dropReason: "malformed-tool-call-body",
    });
  });

  it("reports and preserves a malformed incomplete wrapperless call", () => {
    // Given: an implicit wrapperless call that cannot produce a tool name.
    const onError = vi.fn();
    const text = "lead <function><parameter=query>x</parameter> tail";

    // When: generated text is parsed.
    const result = parseQwen3CoderGeneratedText({
      text,
      tools,
      options: { onError },
    });

    // Then: the malformed suffix is preserved and reported.
    expect(result).toEqual([
      { type: "text", text: "lead " },
      {
        type: "text",
        text: "<function><parameter=query>x</parameter> tail",
      },
    ]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("parses a complete wrapperless call followed by an incomplete call", () => {
    // Given: one regex-matched call and one implicit trailing call.
    const text =
      "<function=search><parameter=query>one</parameter></function> between <function=search><parameter=query>two</parameter>";

    // When: generated text is parsed.
    const result = parse(text);

    // Then: both calls and their separating text are emitted in order.
    expect(result.map((part) => part.type)).toEqual([
      "tool-call",
      "text",
      "tool-call",
    ]);
    expect(result[0]).toMatchObject({
      type: "tool-call",
      toolName: "search",
      input: '{"query":"one"}',
    });
    expect(result[1]).toEqual({ type: "text", text: " between " });
    expect(result[2]).toMatchObject({
      type: "tool-call",
      toolName: "search",
      input: '{"query":"two"}',
    });
  });

  it("parses a wrapperless call before a complete wrapped call", () => {
    // Given: wrapperless syntax in the prefix of a wrapped call.
    const text =
      "<function=search><parameter=query>prefix</parameter></function>" +
      "<tool_call><function=search><parameter=query>wrapped</parameter></function></tool_call>";

    // When: generated text is parsed.
    const result = parse(text);

    // Then: prefix parsing consumes the wrapperless call without duplicating text.
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "tool-call",
      input: '{"query":"prefix"}',
    });
    expect(result[1]).toMatchObject({
      type: "tool-call",
      input: '{"query":"wrapped"}',
    });
  });

  it("preserves ordinary text after a complete wrapped call", () => {
    // Given: a complete wrapper followed only by ordinary text.
    const text =
      "<tool_call><function=search><parameter=query>one</parameter></function></tool_call> answer";

    // When: generated text is parsed.
    const result = parse(text);

    // Then: the remainder takes the plain-text path.
    expect(result.at(-1)).toEqual({ type: "text", text: " answer" });
  });

  it("recovers a standalone incomplete wrapped call", () => {
    // Given: a wrapper with no closing tool-call tag.
    const text =
      "lead <tool_call><function=search><parameter=query>one</parameter></function>";

    // When: generated text is parsed.
    const result = parse(text);

    // Then: leading text and the call are both recovered.
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "lead " });
    expect(result[1]).toMatchObject({
      type: "tool-call",
      toolName: "search",
      input: '{"query":"one"}',
    });
  });

  it("recovers an incomplete wrapped call after a complete wrapped call", () => {
    // Given: a complete wrapper and a trailing wrapper without its close tag.
    const text =
      "<tool_call><function=search><parameter=query>one</parameter></function></tool_call> tail <tool_call><function=search><parameter=query>two</parameter></function>";

    // When: generated text is parsed.
    const result = parse(text);

    // Then: the synthetic wrapper close recovers the trailing call.
    expect(result.map((part) => part.type)).toEqual([
      "tool-call",
      "text",
      "tool-call",
    ]);
    expect(result[2]).toMatchObject({
      type: "tool-call",
      toolName: "search",
      input: '{"query":"two"}',
    });
  });

  it("keeps an already closed malformed trailing wrapper unchanged", () => {
    // Given: a valid wrapper followed by malformed but already closed wrapper text.
    const onError = vi.fn();
    const malformed = "<tool_call><function></function></tool_call>";
    const text =
      "<tool_call><function=search><parameter=query>one</parameter></function></tool_call>" +
      malformed;

    // When: generated text is parsed.
    const result = parseQwen3CoderGeneratedText({
      text,
      tools,
      options: { onError },
    });

    // Then: fallback text is the original trailing span rather than synthetic text.
    expect(result.at(-1)).toEqual({ type: "text", text: malformed });
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "Error object",
      failure: new RangeError("schema failed"),
    },
    {
      label: "non-Error value",
      failure: "schema failed",
    },
  ])("preserves a call when serialization throws a $label", ({ failure }) => {
    // Given: a declared tool whose schema accessor fails during serialization.
    let schemaReads = 0;
    const failingTool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "search",
      inputSchema: {},
    };
    Object.defineProperty(failingTool, "inputSchema", {
      get() {
        schemaReads += 1;
        if (schemaReads === 3) {
          throw failure;
        }
        return tools[0]?.inputSchema;
      },
    });
    const onError = vi.fn();
    const text =
      failure instanceof Error
        ? "<function=search><parameter=query>x</parameter>"
        : "<function=search><parameter=query>x</parameter></function>";

    // When: generated text is parsed.
    const result = parseQwen3CoderGeneratedText({
      text,
      tools: [failingTool],
      options: { onError },
    });

    // Then: serialization failure falls back to original text with safe metadata.
    expect(result).toEqual([{ type: "text", text }]);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({
      dropReason: "malformed-tool-call-body",
      toolName: "search",
      error: { message: "schema failed", name: expect.any(String) },
    });
  });

  it("drops a prototype-sensitive malformed call instead of echoing it", () => {
    // Given: malformed call text containing a forbidden structural key.
    const onError = vi.fn();
    const text =
      '<function><parameter=query>{"__proto__":{}}</parameter></function>';

    // When: generated text is parsed.
    const result = parseQwen3CoderGeneratedText({
      text,
      tools,
      options: { onError },
    });

    // Then: unsafe fallback text is dropped while the parse failure is reported.
    expect(result).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("drops only a bounded sensitive standalone trailing parameter", () => {
    // Given: plain trailing text containing one bounded sensitive parameter span.
    const onError = vi.fn();
    const text =
      'before <parameter=__proto__>{"polluted":true}</parameter> after';

    // When: generated text is parsed.
    const result = parseQwen3CoderGeneratedText({
      text,
      tools,
      options: { onError },
    });

    // Then: safe text survives while the bounded sensitive span is removed.
    expect(result).toEqual([
      { type: "text", text: "before " },
      { type: "text", text: " after" },
    ]);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({
      dropReason: "sensitive-tool-call-trailing-text",
    });
  });

  it("drops an unbounded sensitive trailing fragment", () => {
    // Given: trailing structural text that cannot be safely bounded.
    const onError = vi.fn();
    const text = '<parameter=__proto__>{"polluted":true}';

    // When: generated text is parsed.
    const result = parseQwen3CoderGeneratedText({
      text,
      tools,
      options: { onError },
    });

    // Then: the entire unsafe fragment is dropped and reported.
    expect(result).toEqual([]);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({
      dropReason: "sensitive-tool-call-trailing-text",
    });
  });
});
