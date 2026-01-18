import { describe, expect, it } from "vitest";

import { xmlProtocol } from "../../core/protocols/xml-protocol";

describe("xmlProtocol.extractToolCallSegments ordering", () => {
  const tools = [
    {
      type: "function",
      name: "alpha",
      description: "",
      inputSchema: { type: "object" },
    },
    {
      type: "function",
      name: "beta",
      description: "",
      inputSchema: { type: "object" },
    },
  ];

  it("returns segments ordered by their appearance in the text", () => {
    const p = xmlProtocol();
    const text = [
      "prefix ",
      "<beta><x>1</x></beta>",
      " mid ",
      "<alpha><y>2</y></alpha>",
      " suffix ",
      "<beta><z>3</z></beta>",
    ].join("");

    if (!p.extractToolCallSegments) {
      throw new Error("extractToolCallSegments is not defined");
    }
    const segments = p.extractToolCallSegments({ text, tools: tools as any });

    expect(segments).toEqual([
      "<beta><x>1</x></beta>",
      "<alpha><y>2</y></alpha>",
      "<beta><z>3</z></beta>",
    ]);
  });
});
