import { describe, expect, it } from "vitest";
import {
  K_EXAONE_2_HISTORY_KEY_PREFIX,
  KExaone2HistoryNumber,
} from "../../../core/prompts/k-exaone-2-lossless-json-tokens";
import {
  type KExaone2Value,
  stringifyKExaone2CompactJson,
  stringifyKExaone2NativeJson,
  stringifyKExaone2NativeSchemaJson,
} from "../../../core/prompts/k-exaone-2-native-json";
import { KExaone2SerializationError } from "../../../core/prompts/k-exaone-2-serialization-error";

function expectSerializationError(
  run: () => string,
  reason: KExaone2SerializationError["reason"]
): void {
  // Given: a serialization operation expected to exceed a safety boundary.
  // When: the operation runs.
  try {
    run();
  } catch (error) {
    // Then: serialization fails through the typed boundary error.
    expect(error).toBeInstanceOf(KExaone2SerializationError);
    if (!(error instanceof KExaone2SerializationError)) {
      throw error;
    }
    expect(error.reason).toBe(reason);
    return;
  }
  throw new Error("Expected K-EXAONE serialization to fail");
}

describe("K-EXAONE native JSON number rendering", () => {
  it("canonicalizes native history numbers when boundaries and notation differ", () => {
    // Given: native numbers spanning zero, decimal, exponent, and 64-bit boundaries.
    const values = [
      0,
      1.25,
      1e-5,
      -1e-5,
      Number.POSITIVE_INFINITY,
      -(2 ** 63),
      2 ** 64,
    ] satisfies readonly number[];

    // When: each number is rendered in history context.
    const rendered = values.map(stringifyKExaone2NativeJson);

    // Then: each uses Friendli's native spelling.
    expect(rendered).toEqual([
      "0",
      "1.25",
      "1e-05",
      "-1e-05",
      "null",
      "-9.223372036854776e+18",
      "1.8446744073709552e+19",
    ]);
  });

  it("canonicalizes schema integers around the Python notation threshold", () => {
    // Given: schema numbers on every large-number decision path.
    const schema = {
      decimal: 1e15,
      exponent: 1e16,
      unchangedInteger: 1_000_000_000_000_001,
      ordinaryInteger: 2,
      decimalValue: 1.5,
      tiny: 1e-7,
    };

    // When: the schema object is rendered.
    const rendered = stringifyKExaone2NativeSchemaJson(schema);

    // Then: only Python-canonicalized values change notation.
    expect(rendered).toBe(
      '{"decimal": 1000000000000000.0, "decimalValue": 1.5, "exponent": 1e+16, "ordinaryInteger": 2, "tiny": 1e-07, "unchangedInteger": 1000000000000001}'
    );
  });

  it("preserves lossless history lexemes across integer and float classes", () => {
    // Given: parsed history tokens spanning signed, unsigned, and float classes.
    const values = [
      "0",
      "-9223372036854775808",
      "18446744073709551615",
      "-9223372036854775809",
      "18446744073709551616",
      "-0.0",
      "0.0",
      "1.5",
      "1e-5",
      "1e16",
    ].map((raw) => new KExaone2HistoryNumber(raw));

    // When: the tokens are rendered in one history array.
    const rendered = stringifyKExaone2NativeJson(values);

    // Then: safe integers remain lossless and floats retain Python spelling.
    expect(rendered).toBe(
      "[0, -9223372036854775808, 18446744073709551615, -9.223372036854776e+18, 1.8446744073709552e+19, -0.0, 0.0, 1.5, 1e-05, 1e+16]"
    );
  });
});

describe("K-EXAONE native JSON containers", () => {
  it("sorts schema keys by code point including prefixes and astral characters", () => {
    // Given: keys whose UTF-16 and Unicode code-point orders differ, plus a prefix.
    const schema = { aa: 1, a: 2, "\uE000": 3, "😀": 4 };

    // When: the schema object is rendered.
    const rendered = stringifyKExaone2NativeSchemaJson(schema);

    // Then: ordering is by Unicode code point and shorter prefixes sort first.
    expect(rendered).toBe('{"a": 2, "aa": 1, "": 3, "😀": 4}');
  });

  it("retains history insertion order, decodes history keys, and omits undefined", () => {
    // Given: a history object with an encoded key and an absent property.
    const history: KExaone2Value = {
      z: true,
      [`${K_EXAONE_2_HISTORY_KEY_PREFIX}a`]: "value",
      absent: undefined,
    };

    // When: the history object is rendered.
    const rendered = stringifyKExaone2NativeJson(history);

    // Then: insertion order and decoded keys are observable while absence is omitted.
    expect(rendered).toBe('{"z": true, "a": "value"}');
  });

  it("renders empty, sparse, and nested arrays with native spacing", () => {
    // Given: empty and sparse arrays nested with primitives.
    const sparse: KExaone2Value[] = [];
    sparse.length = 1;
    const value: KExaone2Value = [[], sparse, [null, false, "x"]];

    // When: the value is rendered.
    const rendered = stringifyKExaone2NativeJson(value);

    // Then: holes become null and separators retain native spacing.
    expect(rendered).toBe('[[], [null], [null, false, "x"]]');
  });

  it("compacts only JSON whitespace and preserves whitespace inside strings", () => {
    // Given: a value containing structural whitespace and escaped string content.
    const value = { text: 'a b\\"c', enabled: true, missing: null, n: -1.2e3 };

    // When: compact rendering is requested.
    const rendered = stringifyKExaone2CompactJson(value);

    // Then: structural spaces disappear without changing token content.
    expect(rendered).toBe(
      String.raw`{"text":"a b\\\"c","enabled":true,"missing":null,"n":-1200}`
    );
  });
});

describe("K-EXAONE native JSON safety limits", () => {
  it("rejects oversized objects before reading property values", () => {
    // Given: an object with more keys than the work-item budget.
    const oversized: Record<string, null> = {};
    for (let index = 0; index < 100_000; index += 1) {
      oversized[`key-${index}`] = null;
    }

    // When/Then: serialization reports the size boundary.
    expectSerializationError(
      () => stringifyKExaone2NativeJson(oversized),
      "size"
    );
  });

  it("rejects oversized arrays before reading elements", () => {
    // Given: an array longer than the remaining work-item budget.
    const oversized: KExaone2Value[] = [];
    oversized.length = 100_000;

    // When/Then: serialization reports the size boundary.
    expectSerializationError(
      () => stringifyKExaone2NativeJson(oversized),
      "size"
    );
  });

  it("rejects cyclic containers", () => {
    // Given: a recursive array cycle.
    const cyclic: KExaone2Value[] = [];
    cyclic.push(cyclic);

    // When/Then: serialization reports the cycle boundary.
    expectSerializationError(
      () => stringifyKExaone2NativeJson(cyclic),
      "cycle"
    );
  });

  it("rejects nesting beyond 256 containers", () => {
    // Given: a value one container beyond the supported depth.
    let nested: KExaone2Value = null;
    for (let depth = 0; depth < 257; depth += 1) {
      nested = [nested];
    }

    // When/Then: serialization reports the depth boundary.
    expectSerializationError(
      () => stringifyKExaone2NativeJson(nested),
      "depth"
    );
  });
});
