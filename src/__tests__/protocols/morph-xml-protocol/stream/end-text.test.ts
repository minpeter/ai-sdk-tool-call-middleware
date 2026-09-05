import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { runProtocolTextStream } from "../../shared/duplicate-harness";

describe("morphXmlProtocol streaming trailing text-end on flush", () => {
  it("emits text-end when there is open text at flush with no tags", async () => {
    const out = await runProtocolTextStream({
      chunks: ["hello"],
      id: "1",
      protocol: morphXmlProtocol(),
      tools: [],
    });
    const types = out.map((part) => part.type);

    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");
    expect(types.indexOf("text-end")).toBeGreaterThan(
      types.indexOf("text-delta")
    );
    expect(types.indexOf("finish")).toBeGreaterThan(types.indexOf("text-end"));
  });
});
