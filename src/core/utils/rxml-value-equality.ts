import type { RxmlValue } from "../../rxml/builders/stringify";

type RxmlRecord = Readonly<Record<string, RxmlValue>>;

interface ValuePair {
  readonly left: RxmlValue;
  readonly right: RxmlValue;
}

function isRxmlRecord(value: RxmlValue): value is RxmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuePairChildren(
  left: readonly RxmlValue[] | RxmlRecord,
  right: readonly RxmlValue[] | RxmlRecord
): ValuePair[] | null {
  if (!isRxmlRecord(left)) {
    if (isRxmlRecord(right) || left.length !== right.length) {
      return null;
    }
    return left.map((leftItem, index) => ({
      left: leftItem,
      right: right[index],
    }));
  }
  if (!isRxmlRecord(right)) {
    return null;
  }
  const leftKeys = Object.keys(left);
  if (
    leftKeys.length !== Object.keys(right).length ||
    leftKeys.some((key) => !Object.hasOwn(right, key))
  ) {
    return null;
  }
  return leftKeys.map((key) => ({ left: left[key], right: right[key] }));
}

export function rxmlValuesEqual(left: RxmlValue, right: RxmlValue): boolean {
  const compared = new WeakMap<object, WeakSet<object>>();
  const pairs: ValuePair[] = [{ left, right }];
  while (pairs.length > 0) {
    const pair = pairs.pop();
    if (pair === undefined || Object.is(pair.left, pair.right)) {
      continue;
    }
    if (
      pair.left === null ||
      pair.right === null ||
      typeof pair.left !== "object" ||
      typeof pair.right !== "object"
    ) {
      return false;
    }
    const previousRights = compared.get(pair.left);
    if (previousRights?.has(pair.right)) {
      continue;
    }
    const children = valuePairChildren(pair.left, pair.right);
    if (children === null) {
      return false;
    }
    const rights = previousRights ?? new WeakSet<object>();
    rights.add(pair.right);
    compared.set(pair.left, rights);
    pairs.push(...children);
  }
  return true;
}
