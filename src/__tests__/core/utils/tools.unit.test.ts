import { describe, expect, it, vi } from "vitest";

import {
  decodeOriginalTools,
  decodeOriginalToolsForMiddleware,
  decodeOriginalToolsFromProviderOptions,
  encodeOriginalTools,
  isToolChoiceActive,
} from "../../../core/utils/provider-options";

describe("tools utils", () => {
  it("isToolChoiceActive detects required and tool types", () => {
    expect(
      isToolChoiceActive({
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "required" } },
        },
      })
    ).toBe(true);
    expect(
      isToolChoiceActive({
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "tool" } },
        },
      })
    ).toBe(true);
    expect(
      isToolChoiceActive({
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "none" } },
        },
      })
    ).toBe(false);
    expect(isToolChoiceActive({} as any)).toBe(false);
  });

  it("decodeOriginalTools falls back to permissive schema when inputSchema is malformed", () => {
    const onError = vi.fn();
    const decoded = decodeOriginalTools([{ name: "calc", inputSchema: "{" }], {
      onError,
    });

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({
      type: "function",
      name: "calc",
      inputSchema: { type: "object" },
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("decodeOriginalTools skips invalid entries and keeps valid ones", () => {
    const onError = vi.fn();
    const decoded = decodeOriginalTools(
      [
        { name: "ok", inputSchema: '{"type":"object"}' },
        { name: "", inputSchema: 1 as unknown as string },
        null as unknown as { name: string; inputSchema: string },
      ],
      { onError }
    );

    expect(decoded).toHaveLength(1);
    expect(decoded[0].name).toBe("ok");
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("invalidates the encoded catalog cache after entry mutation", () => {
    const originalTools = encodeOriginalTools([
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: { left: { type: "number" } },
        },
      },
    ]);
    const providerOptions = { toolCallMiddleware: { originalTools } };

    expect(
      decodeOriginalToolsForMiddleware(providerOptions)[0]?.inputSchema
    ).toMatchObject({ properties: { left: { type: "number" } } });

    originalTools[0].inputSchema =
      '{"type":"object","properties":{"right":{"type":"string"}}}';

    expect(
      decodeOriginalToolsForMiddleware(providerOptions)[0]?.inputSchema
    ).toMatchObject({ properties: { right: { type: "string" } } });
  });

  it("prevents cached catalog mutation from poisoning a later request", () => {
    const makeOptions = () => ({
      toolCallMiddleware: {
        originalTools: encodeOriginalTools([
          {
            type: "function" as const,
            name: "calc",
            inputSchema: { type: "object" as const },
          },
        ]),
      },
    });
    const first = decodeOriginalToolsForMiddleware(makeOptions());

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.inputSchema)).toBe(true);
    expect(() => {
      if (first[0]) {
        first[0].name = "poisoned";
      }
    }).toThrow(TypeError);

    expect(decodeOriginalToolsForMiddleware(makeOptions())).toEqual([
      {
        type: "function",
        name: "calc",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("does not cache an invalid encoded catalog before error reporting", () => {
    const onError = vi.fn();
    const originalTools = encodeOriginalTools([
      {
        type: "function",
        name: "bad",
        inputSchema: undefined as never,
      },
    ]);

    expect(
      decodeOriginalToolsForMiddleware(
        { toolCallMiddleware: { originalTools } },
        { onError }
      )
    ).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps public provider-option decoding mutation-isolated", () => {
    const originalTools = encodeOriginalTools([
      {
        type: "function",
        name: "calc",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ]);
    const providerOptions = { toolCallMiddleware: { originalTools } };
    const first = decodeOriginalToolsFromProviderOptions(providerOptions);
    (first[0]?.inputSchema as { properties?: unknown }).properties = {};

    expect(
      decodeOriginalToolsFromProviderOptions(providerOptions)[0]?.inputSchema
    ).toMatchObject({ properties: { value: { type: "string" } } });
  });
});
