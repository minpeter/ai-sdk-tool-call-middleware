import { describe, expect, it, vi } from "vitest";

import {
  decodeOriginalTools,
  isToolChoiceActive,
} from "../../core/utils/provider-options";

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
});
