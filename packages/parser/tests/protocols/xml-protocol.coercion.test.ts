import { describe, it, expect, vi } from "vitest";
import { xmlProtocol } from "@/protocols/xml-protocol";

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

  it("coerces array from JSON string and CSV/newline to number[]", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "calc",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            coords: { type: "array", items: { type: "number" } },
            a1: { type: "array", items: { type: "number" } },
            a2: { type: "array", items: { type: "number" } },
          },
        },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text:
        `<calc>` +
        `<coords>[3,4,5]</coords>` +
        `<a1>1, 2, 3</a1>` +
        `<a2>10\n20\n30</a2>` +
        `</calc>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({
      coords: [3, 4, 5],
      a1: [1, 2, 3],
      a2: [10, 20, 30],
    });
  });

  it("coerces array from XML item shape to typed array", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "player",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            stats_fields: { type: "array", items: { type: "string" } },
            nums: { type: "array", items: { type: "number" } },
          },
        },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text:
        `<player>` +
        `<stats_fields>['points', 'assists']</stats_fields>` +
        `<nums>[1, 2, 3]</nums>` +
        `</player>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({
      stats_fields: ["points", "assists"],
      nums: [1, 2, 3],
    });
  });

  it("coerces object from JSON-like string (single quotes) and nested objects", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "realestate",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            budget: {
              type: "object",
              properties: { min: { type: "number" }, max: { type: "number" } },
            },
            gradeDict: {
              type: "object",
              properties: {
                math: { type: "number" },
                science: { type: "number" },
              },
            },
          },
        },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text:
        `<realestate>` +
        `<budget>{'min':300000,'max':400000}</budget>` +
        `<gradeDict>{'math':90,'science':75}</gradeDict>` +
        `</realestate>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({
      budget: { min: 300000, max: 400000 },
      gradeDict: { math: 90, science: 75 },
    });
  });

  it("recursively coerces nested arrays of objects", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "nested",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "boolean" } },
              },
            },
          },
        },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text:
        `<nested>` +
        `<items>[{'a':1,'b':true},{'a':2,'b':false}]</items>` +
        `</nested>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({
      items: [
        { a: 1, b: true },
        { a: 2, b: false },
      ],
    });
  });

  it("handles booleans (case-insensitive) and numbers with scientific notation", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "calc",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            t: { type: "boolean" },
            f: { type: "boolean" },
            n: { type: "number" },
          },
        },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text: `<calc><t>TRUE</t><f>false</f><n>1.23e3</n></calc>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({ t: true, f: false, n: 1230 });
  });

  it("preserves strings when schema says string even if numeric-like", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "s",
        description: "",
        inputSchema: { type: "object", properties: { s: { type: "string" } } },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text: `<s><s>10</s></s>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({ s: "10" });
  });

  it("handles empty array/object inputs", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "empty",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            arr: { type: "array", items: { type: "number" } },
            obj: { type: "object", properties: { a: { type: "number" } } },
          },
        },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text: `<empty><arr>   </arr><obj>{}</obj></empty>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({ arr: [], obj: {} });
  });

  it("coerces array items when item-wrapped contains object strings", () => {
    const p = xmlProtocol();
    const tools = [
      {
        type: "function",
        name: "wrap",
        description: "",
        inputSchema: {
          type: "object",
          properties: {
            arr: {
              type: "array",
              items: {
                type: "object",
                properties: { min: { type: "number" } },
              },
            },
          },
        },
      },
    ] as any;

    const out = p.parseGeneratedText({
      text:
        `<wrap>` +
        `<arr>` +
        `<item>{'min':1}</item>` +
        `<item>{'min':2}</item>` +
        `</arr>` +
        `</wrap>`,
      tools,
      options: {},
    });

    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc).toBeTruthy();
    expect(JSON.parse(tc.input)).toEqual({ arr: [{ min: 1 }, { min: 2 }] });
  });
});
