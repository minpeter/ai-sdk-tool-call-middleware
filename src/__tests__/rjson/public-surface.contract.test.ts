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

function reviveIsoDate(
  _key: string,
  value: RevivedValue<Date> | undefined
): RevivedValue<Date> | undefined {
  return typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
}

function expectEmptyInput(options: EmptyInputOptions): void {
  const parsed = parse("   ", options);
  const revived = parse("   ", {
    ...options,
    reviver: () => new Date(0),
  });

  expectTypeOf(parsed).toEqualTypeOf<JSONValue | undefined>();
  expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date> | undefined>();
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
    expectTypeOf(revived).toEqualTypeOf<JSONValue | undefined>();
    expect(revived).toEqual({ value: "2026-09-04" });
  });

  it("infers a recursive domain for a mixed reviver", () => {
    const revived = parse('{"value": "2026-09-04"}', reviveIsoDate);

    expectTypeOf(revived).not.toBeAny();
    expectTypeOf(revived).not.toBeUnknown();
    expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expect(revived).toEqual({ value: new Date("2026-09-04T00:00:00Z") });
  });

  it("infers Date from an unannotated inline mixed reviver", () => {
    const direct = parse('{"date":"2026-01-01"}', (_key, value) =>
      typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value
    );
    const inOptions = parse('{"date":"2026-01-01"}', {
      reviver: (_key, value) =>
        typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value,
    });

    expectTypeOf(direct).not.toBeAny();
    expectTypeOf(direct).not.toBeUnknown();
    expectTypeOf(direct).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expectTypeOf(inOptions).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expect(direct).toEqual({ date: new Date("2026-01-01T00:00:00Z") });
    expect(inOptions).toEqual(direct);
  });

  it("accepts compatible inline callback unions with a shared input domain", () => {
    const reviveDate = (_key: string, value: JSONValue | undefined) =>
      typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
    const preserve = (_key: string, value: JSONValue | undefined) => value;
    const selectCallback = (selectFirst: boolean) =>
      selectFirst ? reviveDate : preserve;
    const callback = selectCallback(true);

    const direct = parse('{"date":"2026-01-01"}', callback);
    const inOptions = parse('{"date":"2026-01-01"}', {
      reviver: callback,
    });

    const results: ReadonlyArray<RevivedValue<Date> | undefined> = [
      direct,
      inOptions,
    ];
    expect(results).toHaveLength(2);
  });

  it("accepts a predeclared ParseOptions<Extension> witness variable", () => {
    const options: ParseOptions<Date> & { readonly reviver: Reviver<Date> } = {
      reviver: reviveIsoDate,
    };

    const revived = parse('{"value": "2026-09-04"}', options);

    expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expect(revived).toEqual({ value: new Date("2026-09-04T00:00:00Z") });
  });

  it("does not infer exact output from zero-argument call signatures", () => {
    function overloaded(
      key: string,
      value: JSONValue | undefined
    ): JSONValue | undefined;
    function overloaded(): Date & { readonly first?: never };
    function overloaded(): Date & { readonly second?: never };
    function overloaded(): Date & { readonly third?: never };
    function overloaded(): Date & { readonly fourth?: never };
    function overloaded(): Date;
    function overloaded(
      _key?: string,
      value?: JSONValue
    ): JSONValue | Date | undefined {
      return _key === undefined && value === undefined ? new Date(0) : value;
    }
    const emptyRest = (..._args: []) => new Date(0);

    // @ts-expect-error Revivers use a recursive output domain, not ReturnType.
    const overloadedResult: Date = parse("1", { reviver: overloaded });
    // @ts-expect-error Empty rest tuples cannot turn a reviver into a factory.
    const emptyRestResult: Date = parse("1", { reviver: emptyRest });

    expect(overloadedResult).toBe(1);
    expect(emptyRestResult).toEqual(new Date(0));
  });

  it("derives options results from whether a reviver is present", () => {
    const withReviver = {
      reviver: (_key: string, value: RevivedValue<Date> | undefined) => value,
    } satisfies ParseOptions<Date>;
    const broadWithReviver: ParseOptions<Date> = {
      reviver: (_key: string, _value: RevivedValue<Date> | undefined) =>
        new Date(0),
    };
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
    const broadRevived = parse("null", broadWithReviver);
    const broadParsed = parse("null", broadWithoutReviver);
    const parsed = parse("null", withoutReviver);
    const tolerant = parse("null", tolerantWithoutReviver);

    // @ts-expect-error A broad option type may contain a non-JSON reviver.
    const jsonOnly: JSONValue | undefined = parse("null", broadWithReviver);

    expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expectTypeOf(broadRevived).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expectTypeOf(broadParsed).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expectTypeOf(parsed).toEqualTypeOf<JSONValue>();
    expectTypeOf(tolerant).toEqualTypeOf<JSONValue | undefined>();
    expect(jsonOnly).toBeInstanceOf(Date);
  });

  it("never treats option-shaped callable unions as options objects", () => {
    const selectCallback = (selectFirst: boolean) => {
      const relaxed = Object.assign(() => new Date(0), {
        relaxed: true as const,
      });
      const warnings = Object.assign(() => new Date(0), {
        warnings: false as const,
      });
      return selectFirst ? relaxed : warnings;
    };

    const revived = parse("null", selectCallback(true));
    const strictJson = parse("null", { relaxed: false });
    const tolerantJson = parse("null", { tolerant: true });

    // @ts-expect-error Callable options-shaped unions return their reviver domain.
    const staticallyJson: JSONValue = parse("null", selectCallback(true));

    expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expectTypeOf(strictJson).toEqualTypeOf<JSONValue>();
    expectTypeOf(tolerantJson).toEqualTypeOf<JSONValue | undefined>();
    expect(staticallyJson).toBeInstanceOf(Date);
  });

  it("preserves unconditional callback outputs in the recursive domain", () => {
    const date = new Date(0);
    const function_ = () => "revived";
    const symbol = Symbol("revived");
    const bigint = BigInt(1);

    const revivedDate = parse("null", () => date);
    const revivedFunction = parse("null", () => function_);
    const revivedSymbol = parse("null", () => symbol);
    const revivedBigint = parse("null", () => bigint);

    expectTypeOf(revivedDate).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expectTypeOf(revivedFunction).toEqualTypeOf<
      RevivedValue<() => string> | undefined
    >();
    expectTypeOf(revivedSymbol).toEqualTypeOf<
      RevivedValue<symbol> | undefined
    >();
    expectTypeOf(revivedBigint).toEqualTypeOf<
      RevivedValue<bigint> | undefined
    >();
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
    const recursiveReviver = (
      key: string,
      value: RevivedValue<Date> | undefined
    ) => {
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
    expectTypeOf(revived).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expect(parentContainsDate).toBe(true);
    expect(revived).toEqual({ leaf: new Date("2026-09-04T00:00:00Z") });
  });

  it("visits only the final duplicate value before its parent", () => {
    const calls: Array<readonly [string, JSONValue | undefined]> = [];

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
