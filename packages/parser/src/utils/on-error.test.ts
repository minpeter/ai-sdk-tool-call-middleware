import { describe, it, expect, vi } from "vitest";
import { extractOnErrorOption } from "./on-error";

describe("extractOnErrorOption", () => {
  it("extracts onError when present", () => {
    const fn = vi.fn();
    const opts = { toolCallMiddleware: { onError: fn } };
    expect(extractOnErrorOption(opts)).toEqual({ onError: fn });
  });

  it("returns undefined when not present or invalid types", () => {
    expect(extractOnErrorOption(undefined)).toBeUndefined();
    expect(extractOnErrorOption(null as unknown as object)).toBeUndefined();
    expect(extractOnErrorOption({})).toBeUndefined();
  });
});
