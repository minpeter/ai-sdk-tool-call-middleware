import { describe, expect, it, vi } from "vitest";

import {
  emitMiddlewareEvent,
  extractOnEventOption,
} from "../../../core/utils/on-event";

describe("on-event utils", () => {
  it("extracts onEvent when present", () => {
    const fn = vi.fn();
    const opts = { toolCallMiddleware: { onEvent: fn } };
    expect(extractOnEventOption(opts)).toEqual({ onEvent: fn });
  });

  it("returns undefined when onEvent is absent", () => {
    expect(extractOnEventOption(undefined)).toBeUndefined();
    expect(extractOnEventOption(null as unknown as object)).toBeUndefined();
    expect(extractOnEventOption({})).toBeUndefined();
  });

  it("does not throw if observer callback throws", () => {
    const onEvent = vi.fn(() => {
      throw new Error("observer-error");
    });

    expect(() =>
      emitMiddlewareEvent(onEvent, {
        type: "generate.start",
        metadata: { toolsCount: 1 },
      })
    ).not.toThrow();
    expect(onEvent).toHaveBeenCalledOnce();
  });
});
