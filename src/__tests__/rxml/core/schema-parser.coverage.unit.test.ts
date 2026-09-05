import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "../../../rxml/core/schema-parser";
import { XMLTokenizer } from "../../../rxml/core/tokenizer";
import type { ToolInputSchema } from "../../../schema/tool-input-schema";

class NonErrorFailure {
  readonly reason = "synthetic failure";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("schema parser coverage", () => {
  it("parses with an absent schema and decodes XML entities", () => {
    // Given
    const xml = "<label>A &amp; B</label><count>2</count>";

    // When
    const result = parse(xml, undefined);

    // Then
    expect(result).toEqual({ label: "A &amp; B", count: "2" });
  });

  it("decodes tuple and homogeneous array string values by schema", () => {
    // Given
    const xml = [
      "<tuple><item>&lt;first&gt;</item><item>&amp;second</item><item>third</item></tuple>",
      "<values><item>&lt;one&gt;</item><item>&amp;two</item></values>",
    ].join("");
    const schema = {
      type: "object",
      properties: {
        tuple: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "string" }],
          items: { type: "string" },
        },
        values: { type: "array", items: { type: "string" } },
      },
    } satisfies ToolInputSchema;

    // When
    const result = parse(xml, schema);

    // Then
    expect(result).toEqual({
      tuple: ["<first>", "&second", "third"],
      values: ["<one>", "&two"],
    });
  });

  it("uses legacy tuple items when prefix items are absent", () => {
    // Given
    const schema = {
      type: "object",
      properties: {
        values: {
          type: "array",
          items: [{ type: "string" }, { type: "string" }],
        },
      },
    } satisfies ToolInputSchema;

    // When
    const result = parse(
      "<values><item>&lt;one&gt;</item><item>&amp;two</item></values>",
      schema
    );

    // Then
    expect(result).toEqual({ values: ["<one>", "&two"] });
  });

  it("preserves nullish and non-container values during deep decoding", () => {
    // Given
    const schema = {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        missing: { type: "null" },
        count: { type: "number" },
      },
    } satisfies ToolInputSchema;

    // When
    const result = parse(
      "<enabled>true</enabled><missing></missing><count>2</count>",
      schema
    );

    // Then
    expect(result).toEqual({ enabled: true, missing: "", count: 2 });
  });

  it("wraps tokenizer failures as parse errors with causes", () => {
    // Given
    const malformed = "<value></other>";

    // When
    const action = () => parse(malformed, { type: "object" });

    // Then
    expect(action).toThrow(
      expect.objectContaining({ cause: expect.any(Error) })
    );
  });

  it("wraps root schema coercion failures as coercion errors", () => {
    // Given
    const schema = { type: "string" } satisfies ToolInputSchema;

    // When
    const action = () => parse("<value>text</value>", schema);

    // Then
    expect(action).toThrow(
      expect.objectContaining({ cause: expect.any(Error) })
    );
  });

  it("preserves shared decoded containers from schema coercion", async () => {
    // Given
    const coercion = await import("../../../rxml/schema/coercion");
    const sharedArray = ["&lt;item&gt;"];
    const sharedObject = { label: "&amp;value" };
    const coerced = {
      first: sharedArray,
      second: sharedArray,
      left: sharedObject,
      right: sharedObject,
    };
    const schema = {
      type: "object",
      properties: {
        first: { type: "array", items: { type: "string" } },
        second: { type: "array", items: { type: "string" } },
        left: {
          type: "object",
          properties: { label: { type: "string" } },
        },
        right: {
          type: "object",
          properties: { label: { type: "string" } },
        },
      },
    } satisfies ToolInputSchema;
    vi.spyOn(coercion, "coerceDomBySchema").mockReturnValueOnce(coerced);

    // When
    const result = parse("<ignored>true</ignored>", schema);

    // Then
    expect(result).toEqual({
      first: ["<item>"],
      second: ["<item>"],
      left: { label: "&value" },
      right: { label: "&value" },
    });
    expect(result.first).toBe(result.second);
    expect(result.left).toBe(result.right);
  });

  it("normalizes non-error tokenizer failures", () => {
    // Given
    vi.spyOn(XMLTokenizer.prototype, "parseNode").mockImplementationOnce(() => {
      throw new NonErrorFailure();
    });

    // When
    const parseFailure = () => parse("<value>text</value>", { type: "object" });

    // Then
    expect(parseFailure).toThrow(
      expect.objectContaining({ cause: expect.any(Error) })
    );
  });

  it("normalizes non-error coercion failures", async () => {
    // Given
    const coercion = await import("../../../rxml/schema/coercion");
    vi.spyOn(coercion, "coerceDomBySchema").mockImplementationOnce(() => {
      throw new NonErrorFailure();
    });

    // When
    const parseFailure = () =>
      parse("<value>text</value>", { additionalProperties: true });

    // Then
    expect(parseFailure).toThrowError(
      expect.objectContaining({ cause: expect.any(Error) })
    );
  });

  it("rejects a non-object placeholder restoration", async () => {
    // Given
    const placeholderRestorer = await import(
      "../../../rxml/core/placeholder-restorer"
    );
    vi.spyOn(
      placeholderRestorer,
      "createPlaceholderRestorer"
    ).mockReturnValueOnce(() => "invalid root");

    // When
    const action = () => parse("<value>text</value>", { type: "object" });

    // Then
    expect(action).toThrow("Parsed XML did not produce an object");
  });

  it("rejects a non-object unexpected-root result", async () => {
    // Given
    const schemaDocument = await import("../../../rxml/core/schema-document");
    vi.spyOn(schemaDocument, "unwrapUnexpectedRoot").mockReturnValueOnce(
      "invalid root"
    );

    // When
    const action = () => parse("<value>text</value>", { type: "object" });

    // Then
    expect(action).toThrow("Parsed XML root did not produce an object");
  });

  it("preserves values that do not match nested container schemas", async () => {
    // Given
    const coercion = await import("../../../rxml/schema/coercion");
    vi.spyOn(coercion, "coerceDomBySchema").mockReturnValueOnce({
      arrayValue: "not an array",
      objectValue: "not an object",
    });
    const schema = {
      type: "object",
      properties: {
        arrayValue: { type: "array" },
        objectValue: { type: "object" },
      },
    } satisfies ToolInputSchema;

    // When
    const result = parse("<ignored>true</ignored>", schema);

    // Then
    expect(result).toEqual({
      arrayValue: "not an array",
      objectValue: "not an object",
    });
  });

  it("honors a custom text node name during schema coercion", () => {
    // Given
    const schema = {
      type: "object",
      properties: { value: { type: "number" } },
    } satisfies ToolInputSchema;

    // When
    const result = parse("<value>3</value>", schema, {
      textNodeName: "text",
    });

    // Then
    expect(result).toEqual({ value: 3 });
  });
});
