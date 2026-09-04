import type { JSONObject, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import type { ResolvedGlm5ProtocolOptions } from "../../../core/protocols/glm5-call-types";
import {
  appendJsonFallbackGlm5Args,
  parseJsonGlm5CallBody,
} from "../../../core/protocols/glm5-json-call-recovery";

const protocolOptions: ResolvedGlm5ProtocolOptions = {
  recoverIncompleteToolCalls: true,
  recoverNames: true,
  recoverOpaqueObjectReferences: true,
  stringBoundaryNormalization: "layout",
};

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "search",
    description: "Search",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer" },
        query: { type: "string" },
        settings: {
          type: "object",
          properties: { mode: { type: "string" } },
        },
      },
    },
  },
];

function parse(body: string) {
  return parseJsonGlm5CallBody({ body, protocolOptions, tools });
}

describe("GLM-5 JSON call recovery", () => {
  it.each([
    ["plain text", "a body without an opening object boundary"],
    ["{truncated", "a body without a closing object boundary"],
    ["{invalid}", "malformed strict JSON"],
    ["null", "a non-object JSON value"],
    ['{"__proto__":{"polluted":true}}', "a prototype-sensitive object"],
    ["{}", "an object without a name"],
    ['{"name":7}', "a non-string name"],
    ['{"name":"missing"}', "an undeclared name"],
    ['{"name":"search","arguments":7}', "non-object arguments"],
    ['{"toolName":"search","input":7}', "non-object fallback input"],
    [
      '{"name":"search","arguments":{"settings":"{\\"constructor\\":{}}"}}',
      "a schema-sensitive prototype document string",
    ],
  ])("rejects %s (%s)", (body) => {
    // Given a complete candidate JSON call body
    // When the fallback parser evaluates the candidate
    const result = parse(body);

    // Then unsafe or structurally invalid candidates are rejected atomically
    expect(result).toBeNull();
  });

  it("recovers an exact tool name and explicit arguments", () => {
    // Given a strict JSON call using the primary name and arguments fields
    const body = '{"name":"search","arguments":{"query":"weather"}}';

    // When the complete body is parsed
    const result = parse(body);

    // Then the exact call is recovered without a name-recovery marker
    expect(result).toEqual({
      args: { query: "weather" },
      hasPartialValue: false,
      rawToolName: "search",
      recoveries: ["recovered-json-call-body"],
      toolName: "search",
    });
  });

  it("recovers fallback fields and a uniquely normalized tool name", () => {
    // Given alternate JSON field names and a recoverable tool-name variant
    const body = '{"toolName":"SEARCH","input":{"query":"weather"}}';

    // When the complete body is parsed
    const result = parse(body);

    // Then field and name recovery preserve the declared tool identity
    expect(result).toEqual({
      args: { query: "weather" },
      hasPartialValue: false,
      rawToolName: "SEARCH",
      recoveries: ["recovered-json-call-body", "recovered-tool-name"],
      toolName: "search",
    });
  });

  it("defaults omitted arguments to an empty object", () => {
    // Given a JSON call with a declared name and no argument field
    // When the complete body is parsed
    const result = parse('{"name":"search"}');

    // Then the call has an empty argument object
    expect(result?.args).toEqual({});
  });

  it("returns none when an argument suffix is not a strict JSON object", () => {
    // Given an argument suffix without an object boundary
    const recoveries: string[] = [];

    // When fallback append is attempted
    const result = appendJsonFallbackGlm5Args({
      args: {},
      body: "prefix: not-json",
      from: 8,
      recoveries,
      schema: tools[0]?.inputSchema,
    });

    // Then no arguments or recovery markers are appended
    expect({ recoveries, result }).toEqual({ recoveries: [], result: "none" });
  });

  it("appends every safe JSON argument using its property schema", () => {
    // Given an empty accumulator and a strict JSON argument suffix
    const args: JSONObject = {};
    const recoveries: string[] = [];

    // When fallback arguments are appended
    const result = appendJsonFallbackGlm5Args({
      args,
      body: 'prefix: {"query":"weather","count":2}',
      from: 8,
      recoveries,
      schema: tools[0]?.inputSchema,
    });

    // Then all values and the successful recovery marker are retained
    expect({ args, recoveries, result }).toEqual({
      args: { count: 2, query: "weather" },
      recoveries: ["recovered-json-arguments-body"],
      result: "appended",
    });
  });

  it("marks an empty JSON argument object as appended", () => {
    // Given an empty accumulator and empty strict JSON object
    const recoveries: string[] = [];

    // When fallback arguments are appended
    const result = appendJsonFallbackGlm5Args({
      args: {},
      body: "{}",
      from: 0,
      recoveries,
      schema: tools[0]?.inputSchema,
    });

    // Then successful empty recovery is distinguishable from no JSON suffix
    expect({ recoveries, result }).toEqual({
      recoveries: ["recovered-json-arguments-body"],
      result: "appended",
    });
  });

  it("rejects a schema-sensitive prototype value while appending", () => {
    // Given a nested object value forbidden by its selected property schema
    const recoveries: string[] = [];

    // When fallback arguments are appended
    const result = appendJsonFallbackGlm5Args({
      args: {},
      body: '{"settings":"{\\"constructor\\":{}}"}',
      from: 0,
      recoveries,
      schema: tools[0]?.inputSchema,
    });

    // Then the unsafe suffix is rejected without a success marker
    expect({ recoveries, result }).toEqual({
      recoveries: [],
      result: "rejected",
    });
  });

  it("rejects an argument that is already present", () => {
    // Given an accumulator whose query key is already assigned
    const args = { query: "first" };
    const recoveries: string[] = [];

    // When fallback append encounters the duplicate key
    const result = appendJsonFallbackGlm5Args({
      args,
      body: '{"query":"second"}',
      from: 0,
      recoveries,
      schema: tools[0]?.inputSchema,
    });

    // Then assignment is rejected and the original value remains authoritative
    expect({ args, recoveries, result }).toEqual({
      args: { query: "first" },
      recoveries: ["rejected-duplicate-key"],
      result: "rejected",
    });
  });
});
