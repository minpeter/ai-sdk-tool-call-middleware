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
  object: Record<string, unknown>,
  textNodeName: string,
  restorer: (value: unknown) => unknown
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
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
): (value: unknown) => unknown {
  const restore = (value: unknown): unknown => {
    if (value == null) {
      return value;
    }
    if (typeof value === "string") {
      return restorePlaceholderString(value, placeholderMap);
    }
    if (Array.isArray(value)) {
      return value.map(restore);
    }
    if (typeof value === "object") {
      return restorePlaceholdersInObject(
        value as Record<string, unknown>,
        textNodeName,
        restore
      );
    }
    return value;
  };
  return restore;
}
