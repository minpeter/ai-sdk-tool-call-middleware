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

const reviveIsoDate: Reviver<Date> = (_key, value) =>
  typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;

function expectEmptyInput(options: EmptyInputOptions): void {
  const parsed = parse("   ", options);
  const reviver: Reviver<Date> = () => new Date(0);
  const revived = parse("   ", { ...options, reviver });

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

  it("uses a Reviver<never> witness for precise JSON inference", () => {
    const reviver: Reviver<never> = (_key, value) => value;
    const revived = parse('{"value": "2026-09-04"}', reviver);

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

  it("uses an explicit recursive witness for inline mixed revivers", () => {
    const unannotated = parse('{"date":"2026-01-01"}', (_key, value) =>
      typeof value === "string" ? new Date(value) : value
    );
    const unannotatedOptions = parse('{"date":"2026-01-01"}', {
      reviver: (_key, value) =>
        typeof value === "string" ? new Date(value) : value,
    });

    const reviver: Reviver<Date> = (_key, value) =>
      typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
    const direct = parse('{"date":"2026-01-01"}', reviver);
    const inOptions = parse('{"date":"2026-01-01"}', { reviver });

    expectTypeOf(unannotated).toEqualTypeOf<
      RevivedValue<object | bigint | symbol> | undefined
    >();
    expectTypeOf(unannotatedOptions).toEqualTypeOf<
      RevivedValue<object | bigint | symbol> | undefined
    >();
    expect(unannotated).toEqual({ date: new Date("2026-01-01") });
    expect(unannotatedOptions).toEqual(unannotated);
    expectTypeOf(direct).not.toBeAny();
    expectTypeOf(direct).not.toBeUnknown();
    expectTypeOf(direct).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expectTypeOf(inOptions).toEqualTypeOf<RevivedValue<Date> | undefined>();
    expect(direct).toEqual({ date: new Date("2026-01-01T00:00:00Z") });
    expect(inOptions).toEqual(direct);
  });

  it("accepts compatible inline callback unions with a shared input domain", () => {
    const reviveDate: Reviver<Date> = (_key, value) =>
      typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
    const preserve: Reviver<Date> = (_key, value) => value;
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

  it("keeps ordered overloads conservative in direct and options forms", () => {
    function orderedOverload(_key: string, _value: null): null | bigint;
    function orderedOverload(_key: string, _value: JSONValue | undefined): null;
    function orderedOverload(
      _key: string,
      value: JSONValue | undefined
    ): null | bigint {
      return value === null ? BigInt(2) : null;
    }

    const direct = parse("null", orderedOverload);
    const inOptions = parse("null", { reviver: orderedOverload });

    // @ts-expect-error Raw ordered overloads are not JSON-only witnesses.
    const directJson: JSONValue | undefined = direct;
    // @ts-expect-error Options do not turn a raw overload into a witness.
    const optionsJson: JSONValue | undefined = inOptions;

    expectTypeOf(direct).toEqualTypeOf<
      RevivedValue<object | bigint | symbol> | undefined
    >();
    expectTypeOf(inOptions).toEqualTypeOf<
      RevivedValue<object | bigint | symbol> | undefined
    >();
    expect(directJson).toBe(BigInt(2));
    expect(optionsJson).toBe(BigInt(2));
  });

  it("rejects broad symbol metadata as a reviver witness", () => {
    function ordered(_key: string, _value: null): null | bigint;
    function ordered(_key: string, _value: JSONValue | undefined): null;
    function ordered(
      _key: string,
      value: JSONValue | undefined
    ): null | bigint {
      return value === null ? BigInt(2) : null;
    }

    const metadataKey: symbol = Symbol("metadata");
    const rawCallback = Object.assign(ordered, { [metadataKey]: undefined });
    const reflectedMetadata: Pick<Reviver<never>, keyof Reviver<never>> = {
      [metadataKey]: undefined,
    };
    const reflectedCallback = Object.assign(ordered, reflectedMetadata);

    const direct = parse("null", rawCallback);
    const inOptions = parse("null", { reviver: rawCallback });
    const reflectedDirect = parse("null", reflectedCallback);
    const reflectedInOptions = parse("null", {
      reviver: reflectedCallback,
    });

    // @ts-expect-error Broad symbol metadata is not a JSON-only witness.
    const directJson: JSONValue | undefined = direct;
    // @ts-expect-error Options preserve the broad symbol metadata.
    const optionsJson: JSONValue | undefined = inOptions;
    // @ts-expect-error Reflecting the private key cannot override a broad symbol key.
    const reflectedDirectJson: JSONValue | undefined = reflectedDirect;
    // @ts-expect-error Reflected options remain conservative too.
    const reflectedOptionsJson: JSONValue | undefined = reflectedInOptions;

    const jsonReviver: Reviver<never> = (_key, value) => value;
    const bigintReviver: Reviver<bigint> = () => BigInt(3);
    const preciseJsonDirect = parse("null", jsonReviver);
    const preciseJsonOptions = parse("null", { reviver: jsonReviver });
    const preciseBigintDirect = parse("null", bigintReviver);
    const preciseBigintOptions = parse("null", { reviver: bigintReviver });

    expectTypeOf(direct).toEqualTypeOf<
      RevivedValue<object | bigint | symbol> | undefined
    >();
    expectTypeOf(inOptions).toEqualTypeOf<typeof direct>();
    expectTypeOf(reflectedDirect).toEqualTypeOf<typeof direct>();
    expectTypeOf(reflectedInOptions).toEqualTypeOf<typeof direct>();
    expectTypeOf(preciseJsonDirect).toEqualTypeOf<JSONValue | undefined>();
    expectTypeOf(preciseJsonOptions).toEqualTypeOf<JSONValue | undefined>();
    expectTypeOf(preciseBigintDirect).toEqualTypeOf<
      RevivedValue<bigint> | undefined
    >();
    expectTypeOf(preciseBigintOptions).toEqualTypeOf<
      RevivedValue<bigint> | undefined
    >();
    expect([
      directJson,
      optionsJson,
      reflectedDirectJson,
      reflectedOptionsJson,
    ]).toEqual([BigInt(2), BigInt(2), BigInt(2), BigInt(2)]);
    expect(preciseJsonDirect).toBeNull();
    expect(preciseJsonOptions).toBeNull();
    expect(preciseBigintDirect).toBe(BigInt(3));
    expect(preciseBigintOptions).toBe(BigInt(3));
  });

  it("requires a witness for generic and hybrid callbacks", () => {
    function identity<Value>(_key: string, value: Value): Value {
      return value;
    }
    interface HybridReviver {
      (key: string, value: JSONValue | undefined): JSONValue | undefined;
      new (): object;
    }
    const hybrid = ((_key: string, value: JSONValue | undefined) =>
      value) as HybridReviver;

    const genericRaw = parse("null", identity);
    const hybridRaw = parse("null", hybrid);
    // @ts-expect-error A raw generic callback has the conservative domain.
    const genericJson: JSONValue | undefined = genericRaw;
    // @ts-expect-error A raw callable/constructable callback is conservative.
    const hybridJson: JSONValue | undefined = hybridRaw;

    const witnessed: Reviver<never> = identity;
    const precise = parse("null", witnessed);

    expectTypeOf(genericRaw).toEqualTypeOf<
      RevivedValue<object | bigint | symbol> | undefined
    >();
    expectTypeOf(hybridRaw).toEqualTypeOf<
      RevivedValue<object | bigint | symbol> | undefined
    >();
    expectTypeOf(precise).toEqualTypeOf<JSONValue | undefined>();
    expect(genericJson).toBeNull();
    expect(hybridJson).toBeNull();
    expect(precise).toBeNull();
  });

  it("widens raw overloaded callbacks until a reviver witness erases overloads", () => {
    function reversedOverload(
      _key: string,
      _value: RevivedValue<bigint> | undefined
    ): bigint;
    function reversedOverload(): null;
    function reversedOverload(
      key?: string,
      _value?: RevivedValue<bigint>
    ): bigint | null {
      return key === undefined ? null : BigInt(1);
    }

    const conservative = parse("null", reversedOverload);
    const conservativeOptions = parse("null", { reviver: reversedOverload });
    // @ts-expect-error An overloaded callback cannot produce a JSON-only result.
    const direct: JSONValue | undefined = parse("null", reversedOverload);
    // @ts-expect-error Options do not make a raw overload JSON-only.
    const optionsDirect: JSONValue | undefined = parse("null", {
      reviver: reversedOverload,
    });

    const witnessed: Reviver<bigint> = reversedOverload;
    const revived = parse("null", witnessed);

    expectTypeOf(conservative).toEqualTypeOf<
      RevivedValue<object | bigint | symbol> | undefined
    >();
    expectTypeOf(conservativeOptions).toEqualTypeOf<
      RevivedValue<object | bigint | symbol> | undefined
    >();
    expectTypeOf(revived).toEqualTypeOf<RevivedValue<bigint> | undefined>();
    expect(direct).toBe(BigInt(1));
    expect(optionsDirect).toBe(BigInt(1));
    expect(revived).toBe(BigInt(1));
  });

  it("widens extension-only overloads until a reviver witness erases overloads", () => {
    function extensionOnlyOverload(
      _key: string,
      _value: RevivedValue<bigint> | undefined
    ): bigint;
    function extensionOnlyOverload(): Date;
    function extensionOnlyOverload(
      key?: string,
      _value?: RevivedValue<bigint>
    ): bigint | Date {
      return key === undefined ? new Date(0) : BigInt(1);
    }

    const directInferred = parse("null", extensionOnlyOverload);
    const optionsInferred = parse("null", {
      reviver: extensionOnlyOverload,
    });
    const directConservative:
      | RevivedValue<object | bigint | symbol>
      | undefined = directInferred;
    const optionsConservative:
      | RevivedValue<object | bigint | symbol>
      | undefined = optionsInferred;

    // @ts-expect-error A raw overload cannot claim its final signature's Date.
    const directClaimsDate: RevivedValue<Date> | undefined = directInferred;
    // @ts-expect-error Options preserve the raw overload instead of its final signature.
    const optionsClaimDate: RevivedValue<Date> | undefined = optionsInferred;

    const witnessed: Reviver<bigint> = extensionOnlyOverload;
    const directWitnessed = parse("null", witnessed);
    const optionsWitnessed = parse("null", { reviver: witnessed });

    expectTypeOf(directWitnessed).toEqualTypeOf<
      RevivedValue<bigint> | undefined
    >();
    expectTypeOf(optionsWitnessed).toEqualTypeOf<
      RevivedValue<bigint> | undefined
    >();
    expect(directConservative).toBe(BigInt(1));
    expect(optionsConservative).toBe(BigInt(1));
    expect(directClaimsDate).toBe(BigInt(1));
    expect(optionsClaimDate).toBe(BigInt(1));
    expect(directWitnessed).toBe(BigInt(1));
    expect(optionsWitnessed).toBe(BigInt(1));
  });

  it("discriminates option candidates by callability and constructability", () => {
    const witnessed: Reviver<bigint> = () => BigInt(1);
    const callable = Object.assign(witnessed, { reviver: witnessed });
    const revived = parse("null", callable);

    // @ts-expect-error A callable with .reviver uses the callback result domain.
    const jsonOnly: JSONValue | undefined = parse("null", callable);

    class OptionsShapedClass {
      static readonly relaxed = false;
      static readonly reviver: Reviver<Date> = () => new Date(0);
      readonly marker = true;
    }

    expect(() => {
      // @ts-expect-error Constructable values are not parser options.
      parse("null", OptionsShapedClass);
    }).toThrow(TypeError);

    const optionsWithOptionalCall: {
      readonly call?: () => void;
      readonly relaxed: false;
    } = { relaxed: false };
    const parsed = parse("null", optionsWithOptionalCall);

    expectTypeOf(revived).toEqualTypeOf<RevivedValue<bigint> | undefined>();
    expectTypeOf(parsed).toEqualTypeOf<JSONValue>();
    expect(jsonOnly).toBe(BigInt(1));
    expect(parsed).toBeNull();
  });

  it("derives options results from whether a reviver is present", () => {
    const withReviver: ParseOptions<Date> & {
      readonly reviver: Reviver<Date>;
    } = {
      reviver: (_key, value) => value,
    };
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
      const reviveDate: Reviver<Date> = () => new Date(0);
      const relaxed = Object.assign(reviveDate, { relaxed: true as const });
      const warnings = Object.assign(reviveDate, { warnings: false as const });
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

    const dateReviver: Reviver<Date> = () => date;
    const functionReviver: Reviver<() => string> = () => function_;
    const symbolReviver: Reviver<symbol> = () => symbol;
    const bigintReviver: Reviver<bigint> = () => bigint;
    const revivedDate = parse("null", dateReviver);
    const revivedFunction = parse("null", functionReviver);
    const revivedSymbol = parse("null", symbolReviver);
    const revivedBigint = parse("null", bigintReviver);

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
    const recursiveReviver: Reviver<Date> = (key, value) => {
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
    const reviver: Reviver<never> = (key, value) =>
      key === "drop" ? undefined : value;
    const revived = parse('{"keep": 1, "drop": 2}', reviver);

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
