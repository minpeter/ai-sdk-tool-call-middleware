import type { JSONValue } from "@ai-sdk/provider";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type ParseOptions,
  parse,
  type RevivedValue,
  type Reviver,
  stringify,
  transform,
} from "../../rjson/index";
import { transform as transformSource } from "../../rjson/lexer";
import { parse as parseSource } from "../../rjson/parse";
import { stringify as stringifySource } from "../../rjson/stringify";

type EmptyInputOptions =
  | { readonly tolerant: true }
  | { readonly warnings: true };

const EMPTY_INPUT_CASES = [
  {
    name: "types and returns no value for tolerant empty input",
    options: { tolerant: true },
  },
  {
    name: "types and returns no value when warnings imply tolerant mode",
    options: { warnings: true },
  },
] as const satisfies readonly {
  readonly name: string;
  readonly options: EmptyInputOptions;
}[];

const [tolerantInput, warningsInput] = EMPTY_INPUT_CASES;

function expectEmptyInput(options: EmptyInputOptions): void {
  const parsed = parse("   ", options);
  const revived = parse("   ", {
    ...options,
    reviver: () => new Date(0),
  });

  expectTypeOf(parsed).toEqualTypeOf<JSONValue | undefined>();
  expectTypeOf(revived).toEqualTypeOf<Date | undefined>();
  expect(parsed).toBeUndefined();
  expect(revived).toBeUndefined();
}

describe("RJSON public surface", () => {
  it("exposes the parser implementation without a wrapper", () => {
    expect(parse).toBe(parseSource);
  });

  it("exposes the stringifier implementation without a wrapper", () => {
    expect(stringify).toBe(stringifySource);
  });

  it("exposes the lexer transform without a wrapper", () => {
    expect(transform).toBe(transformSource);
  });

  it("returns JSONValue when no reviver is provided", () => {
    const parsed = parse('{"key": "value"}', { relaxed: false });

    expectTypeOf(parsed).toEqualTypeOf<JSONValue>();
    expect(parsed).toEqual({ key: "value" });
  });

  it("infers concrete JSON for an identity reviver", () => {
    const revived = parse('{"value": "2026-09-04"}', (_key, value) => value);

    expectTypeOf(revived).not.toBeAny();
    expectTypeOf(revived).not.toBeUnknown();
    expectTypeOf(revived).toEqualTypeOf<JSONValue>();
    expect(revived).toEqual({ value: "2026-09-04" });
  });

  it("infers a recursive domain for a mixed reviver", () => {
    const revived = parse(
      '{"value": "2026-09-04"}',
      (_key, value: RevivedValue<Date>) =>
        typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value
    );

    expectTypeOf(revived).not.toBeAny();
    expectTypeOf(revived).not.toBeUnknown();
    expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date>>();
    expect(revived).toEqual({ value: new Date("2026-09-04T00:00:00Z") });
  });

  it("accepts a predeclared ParseOptions<Extension> witness variable", () => {
    const options: ParseOptions<Date> & { readonly reviver: Reviver<Date> } = {
      reviver: (_key, value: RevivedValue<Date>) =>
        typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value,
    };

    const revived = parse('{"value": "2026-09-04"}', options);

    expectTypeOf(revived).not.toBeAny();
    expectTypeOf(revived).not.toBeUnknown();
    expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expect(revived).toEqual({ value: new Date("2026-09-04T00:00:00Z") });
  });

  it("rejects parameterized callbacks from the value-factory overloads", () => {
    const mixedReviver = (_key = "", value = 0) =>
      typeof value === "number" ? new Date(0) : value;

    // @ts-expect-error A factory must declare no parameters, including optional ones.
    parse("null", mixedReviver);
    // @ts-expect-error The options-form factory has the same zero-parameter rule.
    parse("null", { reviver: mixedReviver });
  });

  it("infers factory output only for callbacks with no parameters", () => {
    const direct = parse("null", () => new Date(0));
    const options = parse("null", { reviver: () => new Date(0) });

    expectTypeOf(direct).toEqualTypeOf<Date>();
    expectTypeOf(options).toEqualTypeOf<Date>();
  });

  it("derives options results from whether a reviver is present", () => {
    const withReviver = {
      reviver: (_key: string, value: RevivedValue<Date>) => value,
    } satisfies ParseOptions<Date>;
    const broadWithoutReviver: ParseOptions<Date> = { relaxed: false };
    const withoutReviver: ParseOptions<Date> & {
      readonly relaxed: false;
      readonly reviver?: never;
      readonly tolerant?: false;
      readonly warnings?: false;
    } = { relaxed: false };
    const tolerantWithoutReviver = {
      tolerant: true,
    } satisfies ParseOptions<Date>;

    const revived = parse("null", withReviver);
    const broadParsed = parse("null", broadWithoutReviver);
    const parsed = parse("null", withoutReviver);
    const tolerant = parse("null", tolerantWithoutReviver);

    expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expectTypeOf(broadParsed).toEqualTypeOf<JSONValue | undefined>();
    expectTypeOf(parsed).toEqualTypeOf<JSONValue>();
    expectTypeOf(tolerant).toEqualTypeOf<JSONValue | undefined>();
  });

  it("preserves exact unconditional callback outputs", () => {
    const date = new Date(0);
    const function_ = () => "revived";
    const symbol = Symbol("revived");
    const bigint = BigInt(1);

    const revivedDate = parse("null", () => date);
    const revivedFunction = parse("null", () => function_);
    const revivedSymbol = parse("null", () => symbol);
    const revivedBigint = parse("null", () => bigint);

    expectTypeOf(revivedDate).toEqualTypeOf<Date>();
    expectTypeOf(revivedFunction).toEqualTypeOf<() => string>();
    expectTypeOf(revivedSymbol).toEqualTypeOf<symbol>();
    expectTypeOf(revivedBigint).toEqualTypeOf<bigint>();
    expect(revivedDate).toBe(date);
    expect(revivedFunction).toBe(function_);
    expect(revivedSymbol).toBe(symbol);
    expect(revivedBigint).toBe(bigint);
  });

  it(tolerantInput.name, () => {
    expectEmptyInput(tolerantInput.options);
  });

  it(warningsInput.name, () => {
    expectEmptyInput(warningsInput.options);
  });

  it("exposes recursively revived values to parent callbacks", () => {
    let parentContainsDate = false;
    const recursiveReviver = (key: string, value: RevivedValue<Date>) => {
      if (key === "leaf" && typeof value === "string") {
        return new Date(`${value}T00:00:00Z`);
      }
      if (key === "" && typeof value === "object" && value !== null) {
        parentContainsDate = Object.values(value).some(
          (entry) => entry instanceof Date
        );
      }
      return value;
    };
    const jsonOnlyReviver = (
      _key: string,
      value: JSONValue
    ): JSONValue | Date => value;

    const revived = parse('{"leaf":"2026-09-04"}', recursiveReviver);

    type JsonOnlyIsRecursive =
      typeof jsonOnlyReviver extends Reviver<Date> ? true : false;

    expectTypeOf<JsonOnlyIsRecursive>().toEqualTypeOf<false>();
    expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date>>();
    expect(parentContainsDate).toBe(true);
    expect(revived).toEqual({ leaf: new Date("2026-09-04T00:00:00Z") });
  });

  it("visits only the final duplicate value before its parent", () => {
    const calls: Array<readonly [string, JSONValue]> = [];

    const result = parse('{"key": 1, "key": 2}', {
      duplicate: true,
      relaxed: false,
      reviver: (key, value) => {
        calls.push([key, value]);
        return key === "key" ? undefined : value;
      },
      tolerant: false,
      warnings: false,
    });

    expect(result).toEqual({});
    expect(calls).toEqual([
      ["key", 2],
      ["", {}],
    ]);
  });

  it("preserves deletion in the reviver contract", () => {
    const revived = parse('{"keep": 1, "drop": 2}', (key, value) =>
      key === "drop" ? undefined : value
    );

    expectTypeOf(revived).not.toBeAny();
    expectTypeOf(revived).not.toBeUnknown();
    expectTypeOf(revived).toEqualTypeOf<JSONValue | undefined>();
    expect(revived).toEqual({ keep: 1 });
  });

  it("preserves a reviver error instance", () => {
    const cause = new TypeError("reviver failed");
    let received: Error | undefined;

    try {
      parse("null", () => {
        throw cause;
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      received = error;
    }

    expect(received).toBe(cause);
  });
});
