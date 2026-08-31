import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import {
  decodeOriginalToolsForMiddleware,
  encodeOriginalTools,
} from "../../../core/utils/provider-options";

function tool(
  name: string,
  inputSchema: unknown = { type: "object" }
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: inputSchema as LanguageModelV4FunctionTool["inputSchema"],
  };
}

function decode(encoded: ReturnType<typeof encodeOriginalTools>) {
  return decodeOriginalToolsForMiddleware({
    toolCallMiddleware: { originalTools: encoded },
  });
}

describe("shared original-tools exact-entry LRU", () => {
  it("reuses the decoded snapshot for a repeated equivalent catalog", () => {
    const firstEncoded = encodeOriginalTools([
      tool("lru-repeat", {
        type: "object",
        properties: { value: { type: "string" } },
      }),
    ]);
    const firstDecoded = decode(firstEncoded);
    const secondEncoded = encodeOriginalTools([
      tool("lru-repeat", {
        type: "object",
        properties: { value: { type: "string" } },
      }),
    ]);
    const secondDecoded = decode(secondEncoded);

    expect(secondEncoded).not.toBe(firstEncoded);
    expect(secondDecoded).toBe(firstDecoded);
    expect(secondDecoded).toEqual([
      tool("lru-repeat", {
        type: "object",
        properties: { value: { type: "string" } },
      }),
    ]);
  });

  it("evicts the least-recently-used catalog at the seventeenth entry", () => {
    const target = [tool("lru-eviction-target")];
    const firstDecoded = decode(encodeOriginalTools(target));

    for (let index = 0; index < 16; index += 1) {
      decode(encodeOriginalTools([tool(`lru-eviction-fill-${index}`)]));
    }

    const afterEviction = decode(encodeOriginalTools(target));
    const immediateRepeat = decode(encodeOriginalTools(target));
    expect(afterEviction).not.toBe(firstDecoded);
    expect(afterEviction).toEqual(firstDecoded);
    expect(immediateRepeat).toBe(afterEviction);
  });

  it("promotes a hit so the next insertion evicts the older neighbor", () => {
    const promotedCatalog = [tool("lru-promoted")];
    const evictedCatalog = [tool("lru-evicted-neighbor")];
    const promoted = decode(encodeOriginalTools(promotedCatalog));
    const evicted = decode(encodeOriginalTools(evictedCatalog));
    for (let index = 0; index < 14; index += 1) {
      decode(encodeOriginalTools([tool(`lru-promotion-fill-${index}`)]));
    }

    expect(decode(encodeOriginalTools(promotedCatalog))).toBe(promoted);
    decode(encodeOriginalTools([tool("lru-promotion-overflow")]));

    expect(decode(encodeOriginalTools(promotedCatalog))).toBe(promoted);
    expect(decode(encodeOriginalTools(evictedCatalog))).not.toBe(evicted);
  });

  it("does not alias near-matching names, schemas, lengths, or entry counts", () => {
    const cases = [
      [tool("lru-near-a", { type: "object", title: "bc" })],
      [tool("lru-near-ab", { type: "object", title: "c" })],
      [tool("lru-near-a", { type: "object", title: "bd" })],
      [
        tool("lru-near-a", { type: "object", title: "bc" }),
        tool("lru-near-extra"),
      ],
    ];
    const decoded = cases.map((catalog) =>
      decode(encodeOriginalTools(catalog))
    );

    for (let left = 0; left < decoded.length; left += 1) {
      for (let right = left + 1; right < decoded.length; right += 1) {
        expect(decoded[left]).not.toBe(decoded[right]);
      }
    }
    expect(
      decode(
        encodeOriginalTools([
          tool("lru-near-a", { type: "object", title: "bc" }),
        ])
      )
    ).toBe(decoded[0]);
  });

  it("keeps undefined schemas uncached and reports every decode", () => {
    const onError = vi.fn();
    for (let repetition = 0; repetition < 2; repetition += 1) {
      const encoded = encodeOriginalTools([
        {
          type: "function",
          name: "lru-invalid-undefined",
          inputSchema: undefined as never,
        },
      ]);
      expect(encoded).toEqual([
        { name: "lru-invalid-undefined", inputSchema: undefined },
      ]);
      expect(
        decodeOriginalToolsForMiddleware(
          { toolCallMiddleware: { originalTools: encoded } },
          { onError }
        )
      ).toEqual([]);
    }
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("preserves null-schema output and exact reuse", () => {
    const first = decode(encodeOriginalTools([tool("lru-null-schema", null)]));
    const second = decode(encodeOriginalTools([tool("lru-null-schema", null)]));

    expect(second).toBe(first);
    expect(second[0]?.inputSchema).toBeNull();
  });

  it.each([
    {
      label: "cyclic",
      schema: (() => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      })(),
    },
    { label: "BigInt", schema: { value: BigInt(1) } },
  ])(
    "preserves the JSON serialization exception for $label input",
    ({ schema }) => {
      expect(() =>
        encodeOriginalTools([tool("lru-serialization-error", schema)])
      ).toThrow(TypeError);
    }
  );

  it("isolates cached decoded state from encoded-output mutation", () => {
    const catalog = [
      tool("lru-mutation-isolation", {
        type: "object",
        properties: { original: { type: "string" } },
      }),
    ];
    const firstEncoded = encodeOriginalTools(catalog);
    const firstDecoded = decode(firstEncoded);
    firstEncoded[0].name = "mutated-name";
    firstEncoded[0].inputSchema =
      '{"type":"object","properties":{"mutated":{"type":"number"}}}';

    const repeatedDecoded = decode(encodeOriginalTools(catalog));
    expect(repeatedDecoded).toBe(firstDecoded);
    expect(repeatedDecoded).toEqual(catalog);
    expect(decode(firstEncoded)).toEqual([
      tool("mutated-name", {
        type: "object",
        properties: { mutated: { type: "number" } },
      }),
    ]);
  });

  it("preserves native map getter and Proxy observations", () => {
    const events: string[] = [];
    const schema = new Proxy(
      { type: "object" },
      {
        get(target, key, receiver) {
          events.push(`schema:get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          events.push(`schema:gopd:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        ownKeys(target) {
          events.push("schema:ownKeys");
          return Reflect.ownKeys(target);
        },
      }
    );
    const observedTool = new Proxy(tool("lru-proxy", schema), {
      get(target, key, receiver) {
        events.push(`tool:get:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    const observedCatalog = new Proxy([observedTool], {
      get(target, key, receiver) {
        events.push(`tools:get:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        events.push(`tools:has:${String(key)}`);
        return Reflect.has(target, key);
      },
    });

    expect(encodeOriginalTools(observedCatalog)).toEqual([
      { name: "lru-proxy", inputSchema: '{"type":"object"}' },
    ]);
    expect(events).toEqual([
      "tools:get:map",
      "tools:get:length",
      "tools:get:constructor",
      "tools:has:0",
      "tools:get:0",
      "tool:get:name",
      "tool:get:inputSchema",
      "schema:get:toJSON",
      "schema:ownKeys",
      "schema:gopd:type",
      "schema:get:type",
    ]);
  });

  it("keeps overridden-map Proxy output on the legacy shared-cache path", () => {
    const events: string[] = [];
    const makeCatalog = () => {
      const encoded = new Proxy(
        [
          {
            name: "lru-custom-map",
            inputSchema: '{"type":"object"}',
          },
        ],
        {
          get(target, key, receiver) {
            events.push(`encoded:get:${String(key)}`);
            return Reflect.get(target, key, receiver);
          },
        }
      );
      return {
        map() {
          events.push("tools:map");
          return encoded;
        },
      } as unknown as LanguageModelV4FunctionTool[];
    };

    const first = decode(encodeOriginalTools(makeCatalog()));
    const second = decode(encodeOriginalTools(makeCatalog()));

    expect(second).toBe(first);
    expect(second).toEqual([tool("lru-custom-map")]);
    expect(
      events.filter((event) => event === "encoded:get:Symbol(Symbol.iterator)")
    ).toHaveLength(2);
  });

  it("preserves a custom Symbol.species iterator failure before an LRU hit", () => {
    const events: string[] = [];
    const name = "lru-species-iterator-failure";
    decode(encodeOriginalTools([tool(name)]));

    function ProxyArraySpecies(length: number) {
      return new Proxy(new Array(length), {
        get(target, key, receiver) {
          events.push(`encoded:get:${String(key)}`);
          if (key === Symbol.iterator) {
            throw new TypeError("synthetic encoded iterator failure");
          }
          return Reflect.get(target, key, receiver);
        },
      });
    }
    class SpeciesCatalog extends Array<LanguageModelV4FunctionTool> {
      static override get [Symbol.species](): ArrayConstructor {
        return ProxyArraySpecies as unknown as ArrayConstructor;
      }
    }
    const catalog = new SpeciesCatalog();
    catalog.push(tool(name));

    expect(() => encodeOriginalTools(catalog)).toThrow(
      new TypeError("synthetic encoded iterator failure")
    );
    expect(events).toEqual([
      "encoded:get:length",
      "encoded:get:Symbol(Symbol.iterator)",
    ]);
  });

  it("preserves an Array-subclass iterator failure before an LRU hit", () => {
    const events: string[] = [];
    const name = "lru-subclass-iterator-failure";
    decode(encodeOriginalTools([tool(name)]));

    class Catalog extends Array<LanguageModelV4FunctionTool> {
      override [Symbol.iterator](): ArrayIterator<LanguageModelV4FunctionTool> {
        events.push("catalog:iterator:throw");
        throw new TypeError("synthetic subclass iterator failure");
      }
    }
    const catalog = new Catalog();
    catalog.push(tool(name));

    expect(() => encodeOriginalTools(catalog)).toThrow(
      new TypeError("synthetic subclass iterator failure")
    );
    expect(events).toEqual(["catalog:iterator:throw"]);
  });

  it("preserves the non-callable map TypeError", () => {
    const catalog = [] as unknown as { map: number };
    catalog.map = 42;
    expect(() =>
      encodeOriginalTools(catalog as unknown as LanguageModelV4FunctionTool[])
    ).toThrow(new TypeError("tools?.map is not a function"));
  });
});
