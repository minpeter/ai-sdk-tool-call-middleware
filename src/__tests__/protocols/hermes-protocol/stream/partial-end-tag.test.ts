import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  collectTextDeltas,
  runProtocolTextStream,
} from "../../shared/duplicate-harness";

describe("hermesProtocol partial end-tag handling", () => {
  it("breaks loop when only partial end tag present at end of buffer", async () => {
    const out = await runProtocolTextStream({
      protocol: hermesProtocol(),
      tools: [],
      chunks: ['<tool_call>{"name":"t","arguments":{}', "</tool_"],
      id: "1",
      parserOptions: { emitRawToolCallTextOnError: true },
    });
    const text = collectTextDeltas(out);
    expect(text).toContain('<tool_call>{"name":"t","arguments":{}');
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });
});
