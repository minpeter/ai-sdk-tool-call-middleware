export type DebugLevel = "off" | "stream" | "parse";

function normalizeBooleanString(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return;
}

export function getDebugLevel(): DebugLevel {
  const envVal =
    (typeof process !== "undefined" &&
      process.env &&
      process.env.DEBUG_PARSER_MW) ||
    "off";
  const envLower = String(envVal).toLowerCase();
  if (envLower === "stream" || envLower === "parse" || envLower === "off") {
    return envLower as DebugLevel;
  }
  const boolEnv = normalizeBooleanString(envLower);
  if (boolEnv === true) return "stream";
  if (envLower === "2") return "parse";
  return "off";
}

function color(code: number) {
  return (text: string) => `\u001b[${code}m${text}\u001b[0m`;
}

const cGray = color(90);
const cYellow = color(33);
const cCyan = color(36);
const cBgBlue = color(44);
const cBgGreen = color(42);
const cInverse = color(7);
const cUnderline = color(4);
const cBold = color(1);

function safeStringify(value: unknown): string {
  try {
    return `\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
  } catch {
    return String(value);
  }
}

export function logRawChunk(part: unknown) {
  // Raw provider stream/generate output
  console.log(cGray("[debug:mw:raw]"), cYellow(safeStringify(part)));
}

export function logParsedChunk(part: unknown) {
  // Normalized middleware output
  console.log(cGray("[debug:mw:out]"), cCyan(safeStringify(part)));
}

export function logParsedSummary({
  toolCalls,
  originalText,
}: {
  toolCalls: unknown[];
  originalText: string;
}) {
  if (originalText) {
    const style = (() => {
      const envVal =
        (typeof process !== "undefined" &&
          process.env &&
          process.env.DEBUG_PARSER_MW_STYLE) ||
        "bg";

      const normalized = String(envVal).trim().toLowerCase();
      if (normalized === "inverse" || normalized === "invert")
        return "inverse" as const;
      if (normalized === "underline" || normalized === "ul")
        return "underline" as const;
      if (normalized === "bold") return "bold" as const;
      if (normalized === "bg" || normalized === "background")
        return "bg" as const;
      const asBool = normalizeBooleanString(normalized);
      if (asBool === true) return "bg" as const;
      return "bg" as const; // default: background highlight
    })();

    const highlight =
      style === "inverse"
        ? cInverse
        : style === "underline"
          ? cUnderline
          : style === "bold"
            ? cBold
            : style === "bg"
              ? cBgGreen
              : cYellow;

    const rendered =
      style === "bg" ||
      style === "inverse" ||
      style === "underline" ||
      style === "bold"
        ? originalText
            .split(/\r?\n/)
            .map((line) => (line.length ? highlight(line) : line))
            .join("\n")
        : highlight(originalText);

    console.log(cGray("[debug:mw:origin]"), `\n${rendered}`);
  }

  if (toolCalls.length > 0) {
    const styledSummary = safeStringify(toolCalls)
      .split(/\r?\n/)
      .map((line) => (line.length ? cBgBlue(line) : line))
      .join("\n");
    console.log(cGray("[debug:mw:summary]"), styledSummary);
  }
}
