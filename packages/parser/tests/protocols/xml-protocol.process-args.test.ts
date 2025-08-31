import { describe, expect, it, vi } from "vitest";

import { processParsedArgs } from "@/protocols/morph-xml-protocol";

describe("processParsedArgs unit tests", () => {
  it("preserves raw inner content for string-typed scalar (including whitespace and nested tags)", () => {
    const toolSchema = {
      type: "object",
      properties: { content: { type: "string" } },
    } as const;
    const inner = `\n  <b>Bold</b> and  <i>italic</i>  \n`;
    const toolContent = `<write_text><content>${inner}</content></write_text>`;
    const parsedArgs = { content: { "#text": "IGNORED" } } as Record<
      string,
      unknown
    >;

    const { args, cancelToolCall } = processParsedArgs(
      parsedArgs,
      toolSchema,
      toolContent,
      "write_text"
    );
    expect(cancelToolCall).toBe(false);
    expect(args.content).toBe(inner);
  });

  it("cancels and calls onError when duplicate string-typed scalar tags are present", () => {
    const toolSchema = {
      type: "object",
      properties: { content: { type: "string" } },
    } as const;
    const toolContent =
      `<write_text>` +
      `<content>A</content>` +
      `<content>B</content>` +
      `</write_text>`;
    const parsedArgs = { content: ["A", "B"] } as Record<string, unknown>;
    const onError = vi.fn();

    const { cancelToolCall } = processParsedArgs(
      parsedArgs,
      toolSchema,
      toolContent,
      "write_text",
      { onError }
    );
    expect(cancelToolCall).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it("trims string items in arrays when schema expects array of strings (multiple same-named tags)", () => {
    const toolSchema = {
      type: "object",
      properties: { values: { type: "array", items: { type: "string" } } },
    } as const;
    const toolContent = `<format_list><values></values></format_list>`;
    const parsedArgs = { values: ["  a  ", "b  c"] } as Record<string, unknown>;

    const { args, cancelToolCall } = processParsedArgs(
      parsedArgs,
      toolSchema,
      toolContent,
      "format_list"
    );
    expect(cancelToolCall).toBe(false);
    expect(args.values).toEqual(["a", "b  c"]);
  });

  it("coerces numeric-like strings inside item arrays to numbers (including scientific notation)", () => {
    const toolSchema = {
      type: "object",
      properties: { data: { type: "array", items: { type: "number" } } },
    } as const;
    const toolContent = `<nums><data></data></nums>`;
    const parsedArgs = {
      data: { item: ["1", "2.5", "1.23e3", "-4.56E-2"] },
    } as Record<string, unknown>;

    const { args, cancelToolCall } = processParsedArgs(
      parsedArgs,
      toolSchema,
      toolContent,
      "nums"
    );
    expect(cancelToolCall).toBe(false);
    expect(args.data).toEqual([1, 2.5, 1230, -0.0456]);
  });

  it("coerces numeric-like #text objects inside item arrays to numbers", () => {
    const toolSchema = {
      type: "object",
      properties: { data: { type: "array", items: { type: "number" } } },
    } as const;
    const toolContent = `<nums><data></data></nums>`;
    const parsedArgs = {
      data: {
        item: [{ "#text": " 10.5 " }, { "#text": "3" }, { "#text": "1e2" }],
      },
    } as Record<string, unknown>;

    const { args, cancelToolCall } = processParsedArgs(
      parsedArgs,
      toolSchema,
      toolContent,
      "nums"
    );
    expect(cancelToolCall).toBe(false);
    expect(args.data).toEqual([10.5, 3, 100]);
  });

  it("converts consecutive numeric-keyed objects to arrays (tuple heuristic) without number coercion", () => {
    const toolSchema = {
      type: "object",
      properties: { coords: { type: "array", items: { type: "number" } } },
    } as const;
    const toolContent = `<tuple><coords></coords></tuple>`;
    const parsedArgs = {
      coords: { "0": "10", "1": "20", "2": "30" },
    } as Record<string, unknown>;

    const { args, cancelToolCall } = processParsedArgs(
      parsedArgs,
      toolSchema,
      toolContent,
      "tuple"
    );
    expect(cancelToolCall).toBe(false);
    // tuple path trims but does not coerce to numbers
    expect(args.coords).toEqual(["10", "20", "30"]);
  });

  it("does not convert non-consecutive numeric-keyed objects (keeps object)", () => {
    const toolSchema = {
      type: "object",
      properties: { values: { type: "object" } },
    } as const;
    const toolContent = `<nonconsecutive></nonconsecutive>`;
    const parsedArgs = { values: { "0": "x", "2": "y" } } as Record<
      string,
      unknown
    >;

    const { args, cancelToolCall } = processParsedArgs(
      parsedArgs,
      toolSchema,
      toolContent,
      "nonconsecutive"
    );
    expect(cancelToolCall).toBe(false);
    expect(args.values).toEqual({ "0": "x", "2": "y" });
  });

  it("keeps nested object structure when no #text and no array/tuple heuristics apply", () => {
    const toolSchema = {
      type: "object",
      properties: { settings: { type: "object" } },
    } as const;
    const toolContent = `<config></config>`;
    const parsedArgs = {
      settings: { theme: { dark: "true" } },
    } as Record<string, unknown>;

    const { args, cancelToolCall } = processParsedArgs(
      parsedArgs,
      toolSchema,
      toolContent,
      "config"
    );
    expect(cancelToolCall).toBe(false);
    expect(typeof args.settings).toBe("object");
    expect((args.settings as any).theme.dark).toBe("true");
  });

  it("maps arrays of objects with #text to trimmed values when prop is not string-typed", () => {
    const toolSchema = {
      type: "object",
      properties: { labels: { type: "array", items: { type: "string" } } },
    } as const;
    const toolContent = `<tags></tags>`;
    const parsedArgs = {
      labels: [{ "#text": "  a  " }, { "#text": "b" }],
    } as Record<string, unknown>;

    const { args, cancelToolCall } = processParsedArgs(
      parsedArgs,
      toolSchema,
      toolContent,
      "tags"
    );
    expect(cancelToolCall).toBe(false);
    expect(args.labels).toEqual(["a", "b"]);
  });
});
