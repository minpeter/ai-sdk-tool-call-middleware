import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  ProtocolMetadata,
  ProtocolMetadataValue,
} from "../../../core/protocols/protocol-interface";
import {
  extractOnErrorOption,
  type OnErrorFn,
} from "../../../core/utils/on-error";

type InvalidMetadataFunctionIsRejected =
  (() => void) extends ProtocolMetadataValue ? false : true;

describe("extractOnErrorOption", () => {
  it("extracts onError when present", () => {
    const fn: OnErrorFn = vi.fn();
    const metadata: ProtocolMetadata = {
      cause: new Error("provider failure", { cause: "connection reset" }),
      context: { attempts: [1, 2], recovered: false },
    };
    const opts = { toolCallMiddleware: { onError: fn } };

    expect(extractOnErrorOption(opts)).toEqual({ onError: fn });
    expectTypeOf(metadata).toEqualTypeOf<ProtocolMetadata>();
    expectTypeOf<InvalidMetadataFunctionIsRejected>().toEqualTypeOf<true>();
  });

  it("returns undefined when not present or invalid types", () => {
    expect(extractOnErrorOption(undefined)).toBeUndefined();
    expect(extractOnErrorOption(null)).toBeUndefined();
    expect(extractOnErrorOption({})).toBeUndefined();
    expect(
      extractOnErrorOption({
        toolCallMiddleware: { onError: "not callable" },
      })
    ).toBeUndefined();
  });
});
