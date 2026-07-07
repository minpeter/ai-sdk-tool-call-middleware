import { describe, expect, it, vi } from "vitest";

import {
  parseToolChoicePayload,
  resolveToolChoiceSelection,
} from "../../../core/utils/tool-choice";

describe("tool-choice utils", () => {
  it("parses and coerces valid toolChoice payload", () => {
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":{"a":"10","b":"false"}}',
      tools: [
        {
          type: "function",
          name: "calc",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "boolean" },
            },
          },
        },
      ],
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({
      toolName: "calc",
      input: '{"a":10,"b":false}',
    });
  });

  it("returns unknown payload on invalid JSON", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: "not-json",
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "unknown", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("redacts metadata when invalid JSON contains prototype-sensitive text", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":{"constructor":{"polluted":true},"a":"10"',
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "unknown", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("polluted");
  });

  it("returns unknown payload when root payload is not an object", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: "[]",
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "unknown", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns empty arguments when arguments is not an object", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":"x"}',
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "calc", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("redacts metadata when string arguments contain prototype-sensitive input", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":"{\\"constructor\\":{\\"polluted\\":true}}"}',
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "calc", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("polluted");
  });

  it("redacts metadata when array arguments contain prototype-sensitive input", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":[{"prototype":{"polluted":true}}]}',
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "calc", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("prototype");
    expect(metadataText).not.toContain("polluted");
  });

  it("returns empty arguments when arguments contains prototype-sensitive keys", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":{"__proto__":{"polluted":true},"a":"10"}}',
      tools: [
        {
          type: "function",
          name: "calc",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
            },
          },
        },
      ],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "calc", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("redacts metadata when toolChoice arguments contain prototype-sensitive keys", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":{"constructor":{"polluted":true},"a":"10"}}',
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "calc", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("polluted");
  });

  it("returns empty arguments when toolChoice arguments contain prototype-sensitive string leaves", () => {
    const onError = vi.fn();
    const parsed = parseToolChoicePayload({
      text: '{"name":"calc","arguments":{"body":"<prototype>x</prototype>","a":"10"}}',
      tools: [],
      onError,
      errorMessage: "parse error",
    });

    expect(parsed).toEqual({ toolName: "calc", input: "{}" });
    expect(onError).toHaveBeenCalledOnce();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("<prototype>");
  });

  it("redacts resolved originText for prototype-sensitive forced toolChoice payloads", () => {
    const resolved = resolveToolChoiceSelection({
      text: '{"name":"calc","arguments":{"constructor":{"polluted":true},"a":"10"}}',
      tools: [],
      errorMessage: "parse error",
    });

    expect(resolved).toEqual({
      toolName: "calc",
      input: "{}",
      originText: "[redacted sensitive tool call]",
    });
  });
});
