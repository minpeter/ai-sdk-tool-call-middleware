import { describe, it, expect, vi } from "vitest";
import { xmlProtocol } from "./xml-protocol";

vi.spyOn(console, "warn").mockImplementation(() => {});

describe("xmlProtocol parseGeneratedText coercion", () => {
  it("coerces string numbers/booleans to primitives using simple object schema", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "calc",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "integer" },
            c: { type: "boolean" },
            d: { type: "string" },
          },
        },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text: `<calc><a>10</a><b>5</b><c>true</c><d>ok</d></calc>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({ a: 10, b: 5, c: true, d: "ok" });
  });

  it("coerces using jsonSchema-wrapped schema", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "calc",
        description: "",
        inputSchema: {
          jsonSchema: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "boolean" },
            },
          },
        },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text: `<calc><x>3.14</x><y>false</y></calc>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({ x: 3.14, y: false });
  });

  it("applies heuristic coercion when schema missing but values are numeric/boolean strings", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "calc",
        description: "",
        inputSchema: { type: "object" },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text: `<calc><n>42</n><t>true</t><s>hello</s></calc>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({ n: 42, t: true, s: "hello" });
  });
});
