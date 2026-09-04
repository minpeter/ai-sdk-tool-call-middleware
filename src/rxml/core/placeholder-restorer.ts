import type { RxmlValue } from "../builders/stringify";

type RxmlObject = Exclude<
  RxmlValue,
  string | number | boolean | null | undefined | readonly RxmlValue[]
>;

function isRxmlObject(value: RxmlValue): value is RxmlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restorePlaceholderString(
  value: string,
  placeholderMap: Map<string, string>
): string {
  if (value.startsWith("__RXML_PLACEHOLDER_")) {
    const original = placeholderMap.get(value);
    return original === undefined ? value : original;
  }
  return value;
}

function restorePlaceholdersInObject(
  object: RxmlObject,
  textNodeName: string,
  restorer: (value: RxmlValue) => RxmlValue
): RxmlObject {
  const result: Record<string, RxmlValue> = {};
  for (const [key, value] of Object.entries(object)) {
    const restored = restorer(value);
    result[key] =
      key === textNodeName && typeof restored === "string"
        ? restored.trim()
        : restored;
  }
  return result;
}

export function createPlaceholderRestorer(
  placeholderMap: Map<string, string>,
  textNodeName: string
): (value: RxmlValue) => RxmlValue {
  const restore = (value: RxmlValue): RxmlValue => {
    if (value == null) {
      return value;
    }
    if (typeof value === "string") {
      return restorePlaceholderString(value, placeholderMap);
    }
    if (Array.isArray(value)) {
      return value.map(restore);
    }
    if (isRxmlObject(value)) {
      return restorePlaceholdersInObject(value, textNodeName, restore);
    }
    return value;
  };
  return restore;
}
