import type { JSONSchema7 } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  buildEmptyTrailingStringTagProgressContent,
  findTrailingUnclosedStringTag,
  plainTextBodyFallback,
} from "../../../core/protocols/morph-xml-progress-analysis";

describe("morph XML plain-text progress fallback", () => {
  it("recovers required message text while stripping XML markup", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { message: { type: "string" }, other: { type: "number" } },
      required: ["message"],
    };
    const content =
      "<!--gone--><?pi?><!DOCTYPE x><wrapper><![CDATA[<literal>]]>&amp; text</wrapper>";

    const result = plainTextBodyFallback(content, schema);

    expect(result).toEqual({ message: "<literal>& text" });
  });

  it("recovers an optional message only when no property tag is present", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: { message: { type: "string" }, other: { type: "string" } },
    };

    const results = [
      plainTextBodyFallback("hello", schema),
      plainTextBodyFallback("<other>value</other>", schema),
      plainTextBodyFallback("<message>value</message>", schema),
    ];

    expect(results).toEqual([{ message: "hello" }, null, null]);
  });

  it("rejects schemas and bodies that cannot yield message text", () => {
    const results = [
      plainTextBodyFallback("text", false),
      plainTextBodyFallback("text", {
        properties: { message: { type: "number" } },
        required: ["message"],
      }),
      plainTextBodyFallback("text", {
        properties: { message: { type: "number" } },
      }),
      plainTextBodyFallback("text", {
        properties: { message: { type: "string" } },
        required: ["other"],
      }),
      plainTextBodyFallback("   ", {
        properties: { message: { type: "string" } },
      }),
      plainTextBodyFallback("<!-- only markup -->", {
        properties: { message: { type: "string" } },
      }),
    ];

    expect(results).toEqual([null, null, null, null, null, null]);
  });

  it("rejects parsed top-level schema tags that evade the fast pattern scan", () => {
    const schema: JSONSchema7 = {
      properties: { message: { type: "string" }, other: { type: "string" } },
    };

    const result = plainTextBodyFallback("< other>value</ other>", schema);

    expect(result).toBeNull();
  });

  it("rejects a required message element instead of treating it as plain text", () => {
    const schema: JSONSchema7 = {
      properties: { message: { type: "string" } },
      required: ["message"],
    };

    const result = plainTextBodyFallback("<message>value</message>", schema);

    expect(result).toBeNull();
  });

  it("uses collision-free CDATA markers", () => {
    const schema: JSONSchema7 = {
      properties: { message: { type: "string" } },
      required: ["message"],
    };
    const content = "\u0000MORPH_XML_CDATA_0\u0000<![CDATA[value]]>";

    const result = plainTextBodyFallback(content, schema);

    expect(result).toEqual({
      message: "\u0000MORPH_XML_CDATA_0\u0000value",
    });
  });
});

describe("morph XML trailing string-tag repair", () => {
  it("selects the latest unclosed schema property with regex metacharacters", () => {
    const result = findTrailingUnclosedStringTag({
      toolContent: "<first>x</first><a.b>old<a.b>latest",
      stringPropertyNames: new Set(["first", "missing", "a.b"]),
    });

    expect(result).toBe("a.b");
  });

  it("returns null when every opened property is closed", () => {
    const result = findTrailingUnclosedStringTag({
      toolContent: "<first>x</first>",
      stringPropertyNames: new Set(["first", "missing"]),
    });

    expect(result).toBeNull();
  });

  it("ignores synthetic pattern matches without indexes", () => {
    let matchAllCallCount = 0;
    const contentWithoutCloseMatchIndexes = {
      matchAll() {
        matchAllCallCount += 1;
        return matchAllCallCount === 2
          ? [Object.assign(["<value>"], { index: 0 })]
          : [["</value>"]];
      },
    };

    const result = Reflect.apply(findTrailingUnclosedStringTag, undefined, [
      {
        toolContent: contentWithoutCloseMatchIndexes,
        stringPropertyNames: new Set(["missing", "value"]),
      },
    ]);

    expect(result).toBe("value");
  });

  it("builds a repair after the final matching open tag", () => {
    const result = buildEmptyTrailingStringTagProgressContent({
      tagName: "value",
      toolContent: "<value>old</value><value class='x'>",
    });

    expect(result).toEqual({
      content: "<value>old</value><value class='x'></value>",
      bodyStart: 35,
    });
  });

  it("returns null when the requested tag was never opened", () => {
    const result = buildEmptyTrailingStringTagProgressContent({
      tagName: "missing",
      toolContent: "<value>x",
    });

    expect(result).toBeNull();
  });

  it("ignores synthetic repair matches without indexes", () => {
    const contentWithoutMatchIndexes = {
      matchAll() {
        return [["<value>"]];
      },
    };

    const result = Reflect.apply(
      buildEmptyTrailingStringTagProgressContent,
      undefined,
      [{ tagName: "value", toolContent: contentWithoutMatchIndexes }]
    );

    expect(result).toBeNull();
  });
});
