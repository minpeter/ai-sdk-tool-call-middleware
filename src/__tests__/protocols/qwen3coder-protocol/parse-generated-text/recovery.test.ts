import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";

describe("recovery.test split 1", () => {
  const tools = emptyFunctionTools;
  const bookFlightTool = {
    type: "function" as const,
    name: "book_flight",
    inputSchema: {
      type: "object",
      properties: {
        cabin: { type: "string" },
      },
    },
  } satisfies LanguageModelV4FunctionTool;
  const prototypeSensitiveParameterNames = [
    "__proto__",
    "constructor",
    "prototype",
  ] as const;

  it("calls onError and keeps original text on malformed segments", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const bad =
      "<tool_call><function><parameter=x>1</parameter></function></tool_call>";
    const text = `before ${bad} after`;
    const out = p.parseGeneratedText({
      text,
      tools,
      options: { onError },
    });

    expect(onError).toHaveBeenCalled();
    const rejoined = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(rejoined).toContain(bad);
  });

  it("calls onError and drops raw text on prototype-sensitive args", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      '<tool_call><function=book_flight><parameter=constructor>{"polluted":true}</parameter></function></tool_call>';

    const out = p.parseGeneratedText({
      text,
      tools: [
        {
          type: "function" as const,
          name: "book_flight",
          inputSchema: {
            type: "object",
            properties: {
              cabin: { type: "string" },
            },
          },
        },
      ],
      options: { onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "[redacted sensitive tool call]" })
    );
  });

  it("calls onError and drops raw text on self-closing prototype-sensitive args", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call><function=book_flight><parameter=constructor/></function></tool_call>";

    const out = p.parseGeneratedText({
      text,
      tools: [
        {
          type: "function" as const,
          name: "book_flight",
          inputSchema: {
            type: "object",
            properties: {
              cabin: { type: "string" },
            },
          },
        },
      ],
      options: { onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
  });

  it.each(prototypeSensitiveParameterNames)(
    "drops wrapperless partial prototype-sensitive arg trailing text for %s",
    (parameterName) => {
      const onError = vi.fn();
      const p = qwen3CoderProtocol();
      const text = `<function=book_flight><parameter=${parameterName}`;

      const out = p.parseGeneratedText({
        text,
        tools: [bookFlightTool],
        options: { emitRawToolCallTextOnError: true, onError },
      });

      const toolCall = out.find((part) => part.type === "tool-call");
      expect(toolCall).toMatchObject({
        type: "tool-call",
        toolName: "book_flight",
        input: "{}",
      });
      expect(
        out
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      ).toBe("");
      expect(onError).toHaveBeenCalled();
      const metadataText = JSON.stringify(onError.mock.calls);
      expect(metadataText).toContain("[redacted sensitive tool call]");
      expect(metadataText).not.toContain(parameterName);
      expect(metadataText).not.toContain("<parameter=");
    }
  );

  it.each(prototypeSensitiveParameterNames)(
    "drops standalone prototype-sensitive parameter trailing text after wrapperless call for %s",
    (parameterName) => {
      const onError = vi.fn();
      const p = qwen3CoderProtocol();
      const text =
        "<function=book_flight><parameter=cabin>economy</parameter></function>" +
        `<parameter=${parameterName}>{"polluted":true}</parameter>`;

      const out = p.parseGeneratedText({
        text,
        tools: [bookFlightTool],
        options: { emitRawToolCallTextOnError: true, onError },
      });

      expect(out.find((part) => part.type === "tool-call")).toMatchObject({
        type: "tool-call",
        toolName: "book_flight",
        input: '{"cabin":"economy"}',
      });
      expect(
        out
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      ).toBe("");
      expect(onError).toHaveBeenCalled();
      const metadataText = JSON.stringify(onError.mock.calls);
      expect(metadataText).toContain("[redacted sensitive tool call]");
      expect(metadataText).not.toContain(parameterName);
      expect(metadataText).not.toContain("<parameter=");
    }
  );

  it.each(prototypeSensitiveParameterNames)(
    "preserves safe text after dropped standalone prototype-sensitive parameter trailing text for %s",
    (parameterName) => {
      const onError = vi.fn();
      const p = qwen3CoderProtocol();
      const text =
        "<function=book_flight><parameter=cabin>economy</parameter></function>" +
        `<parameter=${parameterName}>{"polluted":true}</parameter> after`;

      const out = p.parseGeneratedText({
        text,
        tools: [bookFlightTool],
        options: { emitRawToolCallTextOnError: true, onError },
      });

      expect(out.find((part) => part.type === "tool-call")).toMatchObject({
        type: "tool-call",
        toolName: "book_flight",
        input: '{"cabin":"economy"}',
      });
      expect(
        out
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      ).toBe(" after");
      expect(onError).toHaveBeenCalled();
      const metadataText = JSON.stringify(onError.mock.calls);
      expect(metadataText).toContain("[redacted sensitive tool call]");
      expect(metadataText).not.toContain(parameterName);
      expect(metadataText).not.toContain("<parameter=");
    }
  );

  it("preserves safe text after dropped entity-encoded standalone prototype-sensitive parameter trailing text", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      "<function=book_flight><parameter=cabin>economy</parameter></function>" +
      '<parameter name="&#99;onstructor">{"polluted":true}</parameter> after';

    const out = p.parseGeneratedText({
      text,
      tools: [bookFlightTool],
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(out.find((part) => part.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "book_flight",
      input: '{"cabin":"economy"}',
    });
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe(" after");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("polluted");
    expect(metadataText).not.toContain("&#99;onstructor");
  });

  it("preserves safe text after dropped unquoted-name standalone prototype-sensitive parameter trailing text", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      "<function=book_flight><parameter=cabin>economy</parameter></function>" +
      '<parameter name=constructor>{"polluted":true}</parameter> after';

    const out = p.parseGeneratedText({
      text,
      tools: [bookFlightTool],
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(out.find((part) => part.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "book_flight",
      input: '{"cabin":"economy"}',
    });
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe(" after");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("polluted");
    expect(metadataText).not.toContain("name=constructor");
  });

  it("drops bare standalone prototype-sensitive parameter text without a wrapperless call", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text = "safe<parameter=__proto__>leakmarker</parameter> tail";

    const out = p.parseGeneratedText({
      text,
      tools: [bookFlightTool],
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("safe tail");
    expect(JSON.stringify(out)).not.toContain("leakmarker");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("leakmarker");
    expect(metadataText).not.toContain("<parameter=");
  });

  it("calls onError and drops raw text on __proto__ parameter args", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      '<tool_call><function=book_flight><parameter=__proto__>{"polluted":true}</parameter></function></tool_call>';

    const out = p.parseGeneratedText({
      text,
      tools: [
        {
          type: "function" as const,
          name: "book_flight",
          inputSchema: {
            type: "object",
            properties: {
              cabin: { type: "string" },
            },
          },
        },
      ],
      options: { onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
  });
});
