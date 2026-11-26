import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_SOURCE_FILE_LOC = 600;
const JS_TO_TS_EXTENSION: ReadonlyArray<readonly [string, string]> = [
  [".js", ".ts"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
];
const IDENT_START_RE = /[A-Za-z_$]/;
const IDENT_PART_RE = /[A-Za-z0-9_$]/;
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "in",
  "of",
  "typeof",
  "void",
  "delete",
  "new",
  "yield",
  "await",
  "else",
  "do",
]);
const REGEX_PRECEDING_PUNCT = new Set([
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "=",
  "!",
  "?",
  "&",
  "|",
  "^",
  "~",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
]);

const STATEMENT_HEADER_KEYWORDS = new Set(["if", "while", "for", "with"]);
const HEX_DIGITS_RE = /^[0-9a-fA-F]+$/;

interface SourceToken {
  canPrecedeRegex?: boolean;
  kind: "ident" | "punct" | "string";
  value: string;
}

function isProductionSourceFileName(name: string): boolean {
  if (
    name.endsWith(".d.ts") ||
    name.endsWith(".d.mts") ||
    name.endsWith(".d.cts")
  ) {
    return false;
  }
  return name.endsWith(".ts") || name.endsWith(".mts") || name.endsWith(".cts");
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (isProductionSourceFileName(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function canStartRegex(prev: SourceToken | undefined): boolean {
  if (!prev) {
    return true;
  }
  if (prev.canPrecedeRegex) {
    return true;
  }
  if (prev.kind === "punct") {
    return REGEX_PRECEDING_PUNCT.has(prev.value);
  }
  if (prev.kind === "ident") {
    return REGEX_PRECEDING_KEYWORDS.has(prev.value);
  }
  return false;
}

function readJsEscape(
  source: string,
  backslashIndex: number
): { nextIndex: number; value: string } {
  const esc = source[backslashIndex + 1];
  if (esc === undefined) {
    return { nextIndex: backslashIndex + 1, value: "" };
  }
  if (esc === "\r") {
    const skip = source[backslashIndex + 2] === "\n" ? 3 : 2;
    return { nextIndex: backslashIndex + skip, value: "" };
  }
  if (esc === "\n") {
    return { nextIndex: backslashIndex + 2, value: "" };
  }
  if (esc === "x") {
    const hex = source.slice(backslashIndex + 2, backslashIndex + 4);
    if (hex.length === 2 && HEX_DIGITS_RE.test(hex)) {
      return {
        nextIndex: backslashIndex + 4,
        value: String.fromCharCode(Number.parseInt(hex, 16)),
      };
    }
  }
  if (esc === "u") {
    if (source[backslashIndex + 2] === "{") {
      const closeBrace = source.indexOf("}", backslashIndex + 3);
      if (closeBrace !== -1) {
        const hex = source.slice(backslashIndex + 3, closeBrace);
        if (hex.length > 0 && HEX_DIGITS_RE.test(hex)) {
          const codePoint = Number.parseInt(hex, 16);
          if (codePoint <= 0x10_ff_ff) {
            return {
              nextIndex: closeBrace + 1,
              value: String.fromCodePoint(codePoint),
            };
          }
        }
      }
    } else {
      const hex = source.slice(backslashIndex + 2, backslashIndex + 6);
      if (hex.length === 4 && HEX_DIGITS_RE.test(hex)) {
        return {
          nextIndex: backslashIndex + 6,
          value: String.fromCharCode(Number.parseInt(hex, 16)),
        };
      }
    }
  }
  const simpleEscapes: Record<string, string> = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "0": "\0",
  };
  return {
    nextIndex: backslashIndex + 2,
    value: simpleEscapes[esc] ?? esc,
  };
}

function readQuotedString(
  source: string,
  startIndex: number
): { nextIndex: number; value: string } {
  const quote = source[startIndex];
  let index = startIndex + 1;
  let value = "";
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      const decoded = readJsEscape(source, index);
      value += decoded.value;
      index = decoded.nextIndex;
      continue;
    }
    if (ch === quote) {
      return { nextIndex: index + 1, value };
    }
    value += ch;
    index += 1;
  }
  return { nextIndex: index, value };
}

function skipRegexLiteral(source: string, startIndex: number): number {
  let index = startIndex + 1;
  let inCharClass = false;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === "[") {
      inCharClass = true;
    } else if (ch === "]") {
      inCharClass = false;
    } else if (ch === "/" && !inCharClass) {
      index += 1;
      while (index < source.length && IDENT_PART_RE.test(source[index] ?? "")) {
        index += 1;
      }
      return index;
    } else if (ch === "\n" || ch === "\r") {
      return index;
    }
    index += 1;
  }
  return index;
}

function readTemplateSegment(
  source: string,
  startIndex: number
): { hasInterpolation: boolean; nextIndex: number; value: string } {
  let index = startIndex;
  let value = "";
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      const decoded = readJsEscape(source, index);
      value += decoded.value;
      index = decoded.nextIndex;
      continue;
    }
    if (ch === "`") {
      return { hasInterpolation: false, nextIndex: index + 1, value };
    }
    if (ch === "$" && source[index + 1] === "{") {
      return { hasInterpolation: true, nextIndex: index + 2, value };
    }
    value += ch;
    index += 1;
  }
  return { hasInterpolation: false, nextIndex: index, value };
}

function tokenizeTypeScript(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  const templateBraceDepths: number[] = [];
  const parenIsStatementCondition: boolean[] = [];
  let braceDepth = 0;
  let index = 0;

  while (index < source.length) {
    const ch = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      index += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (ch === "/" && canStartRegex(tokens.at(-1))) {
      index = skipRegexLiteral(source, index);
      tokens.push({ kind: "string", value: "" });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const parsed = readQuotedString(source, index);
      tokens.push({ kind: "string", value: parsed.value });
      index = parsed.nextIndex;
      continue;
    }
    if (ch === "`") {
      const segment = readTemplateSegment(source, index + 1);
      if (segment.hasInterpolation) {
        templateBraceDepths.push(braceDepth);
        braceDepth += 1;
        tokens.push({ kind: "punct", value: "{" });
      } else {
        tokens.push({ kind: "string", value: segment.value });
      }
      index = segment.nextIndex;
      continue;
    }
    if (ch === "(") {
      const prev = tokens.at(-1);
      const prevPrev = tokens.at(-2);
      const isConditionHeader =
        prev?.kind === "ident" &&
        STATEMENT_HEADER_KEYWORDS.has(prev.value) &&
        !(prevPrev?.kind === "punct" && prevPrev.value === ".");
      parenIsStatementCondition.push(isConditionHeader);
      tokens.push({ kind: "punct", value: "(" });
      index += 1;
      continue;
    }
    if (ch === ")") {
      const isConditionEnd = parenIsStatementCondition.pop() ?? false;
      tokens.push({
        kind: "punct",
        value: ")",
        ...(isConditionEnd ? { canPrecedeRegex: true } : {}),
      });
      index += 1;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      tokens.push({ kind: "punct", value: "{" });
      index += 1;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      tokens.push({ kind: "punct", value: "}" });
      index += 1;
      if (
        templateBraceDepths.length > 0 &&
        templateBraceDepths.at(-1) === braceDepth
      ) {
        const segment = readTemplateSegment(source, index);
        if (segment.hasInterpolation) {
          braceDepth += 1;
          tokens.push({ kind: "punct", value: "{" });
        } else {
          templateBraceDepths.pop();
        }
        index = segment.nextIndex;
      }
      continue;
    }
    if (IDENT_START_RE.test(ch)) {
      let end = index + 1;
      while (end < source.length && IDENT_PART_RE.test(source[end] ?? "")) {
        end += 1;
      }
      tokens.push({ kind: "ident", value: source.slice(index, end) });
      index = end;
      continue;
    }

    tokens.push({ kind: "punct", value: ch });
    index += 1;
  }

  return tokens;
}

function collectRelativeSpecifiersFromSource(sourceText: string): string[] {
  const tokens = tokenizeTypeScript(sourceText);
  const specifiers: string[] = [];

  const recordIfRelative = (token: SourceToken | undefined) => {
    if (token?.kind === "string" && token.value.startsWith(".")) {
      specifiers.push(token.value);
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token?.kind !== "ident") {
      continue;
    }
    const prev = tokens[i - 1];
    if (prev?.kind === "punct" && prev.value === ".") {
      continue;
    }
    const next = tokens[i + 1];
    if (token.value === "from" && next?.kind === "string") {
      recordIfRelative(next);
    } else if (token.value === "import" && next?.kind === "string") {
      recordIfRelative(next);
    } else if (
      (token.value === "import" || token.value === "require") &&
      next?.kind === "punct" &&
      next.value === "("
    ) {
      recordIfRelative(tokens[i + 2]);
    }
  }

  return specifiers;
}

function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  fileExists: (path: string) => boolean = existsSync
): string {
  const base = normalize(join(dirname(fromFile), specifier));
  if (base.endsWith(".ts") || base.endsWith(".mts") || base.endsWith(".cts")) {
    return relative(SRC_ROOT, base).replaceAll("\\", "/");
  }
  for (const [jsExt, tsExt] of JS_TO_TS_EXTENSION) {
    if (base.endsWith(jsExt)) {
      const mapped = `${base.slice(0, -jsExt.length)}${tsExt}`;
      if (fileExists(mapped)) {
        return relative(SRC_ROOT, mapped).replaceAll("\\", "/");
      }
    }
  }
  for (const tsExt of [".ts", ".mts", ".cts"]) {
    if (fileExists(`${base}${tsExt}`)) {
      return relative(SRC_ROOT, `${base}${tsExt}`).replaceAll("\\", "/");
    }
    if (fileExists(join(base, `index${tsExt}`))) {
      return relative(SRC_ROOT, join(base, `index${tsExt}`)).replaceAll(
        "\\",
        "/"
      );
    }
  }
  return relative(SRC_ROOT, base).replaceAll("\\", "/");
}

function collectEdges(
  sourceFiles: string[]
): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const fullPath of sourceFiles) {
    const from = relative(SRC_ROOT, fullPath).replaceAll("\\", "/");
    const source = readFileSync(fullPath, "utf8");
    for (const specifier of collectRelativeSpecifiersFromSource(source)) {
      edges.push({ from, to: resolveRelativeImport(fullPath, specifier) });
    }
  }
  return edges;
}

function findStronglyConnectedCycles(
  nodes: string[],
  edges: Array<{ from: string; to: string }>
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node, []);
  }
  for (const { from, to } of edges) {
    adjacency.get(from)?.push(to);
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const strongConnect = (node: string): void => {
    indices.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!indices.has(neighbor)) {
        strongConnect(neighbor);
        lowlink.set(
          node,
          Math.min(lowlink.get(node) ?? 0, lowlink.get(neighbor) ?? 0)
        );
      } else if (onStack.has(neighbor)) {
        lowlink.set(
          node,
          Math.min(lowlink.get(node) ?? 0, indices.get(neighbor) ?? 0)
        );
      }
    }

    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member !== undefined) {
          onStack.delete(member);
          component.push(member);
        }
      } while (member !== undefined && member !== node);

      const hasSelfLoop =
        component.length === 1 && (adjacency.get(node) ?? []).includes(node);
      if (component.length > 1 || hasSelfLoop) {
        cycles.push(component.sort());
      }
    }
  };

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return cycles;
}

type LayerName =
  | "shared"
  | "rjson"
  | "schema-coerce"
  | "rxml"
  | "core/utils"
  | "core/protocols/contract"
  | "core/protocols/impl"
  | "core/prompts"
  | "handlers"
  | "entry"
  | "community";

const LAYER_RANK: Record<LayerName, number> = {
  shared: 0,
  rjson: 0,
  "schema-coerce": 1,
  rxml: 2,
  "core/utils": 3,
  "core/protocols/contract": 4,
  "core/protocols/impl": 5,
  "core/prompts": 5,
  handlers: 6,
  entry: 7,
  community: 8,
};

const KNOWN_ENTRY_FILES = new Set([
  "index.ts",
  "preconfigured-middleware.ts",
  "tool-call-middleware.ts",
]);

function classifyLayer(relPath: string): LayerName {
  if (relPath.startsWith("shared/")) {
    return "shared";
  }
  if (relPath.startsWith("rjson/")) {
    return "rjson";
  }
  if (relPath.startsWith("schema-coerce/")) {
    return "schema-coerce";
  }
  if (relPath.startsWith("rxml/")) {
    return "rxml";
  }
  if (relPath.startsWith("core/utils/")) {
    return "core/utils";
  }
  if (relPath === "core/protocols/protocol-interface.ts") {
    return "core/protocols/contract";
  }
  if (relPath.startsWith("core/protocols/")) {
    return "core/protocols/impl";
  }
  if (relPath.startsWith("core/prompts/")) {
    return "core/prompts";
  }
  if (
    relPath === "generate-handler.ts" ||
    relPath === "stream-handler.ts" ||
    relPath === "transform-handler.ts"
  ) {
    return "handlers";
  }
  if (relPath.startsWith("community/")) {
    return "community";
  }
  if (KNOWN_ENTRY_FILES.has(relPath)) {
    return "entry";
  }
  throw new Error(
    `Unclassified source file for architecture contract: ${relPath}`
  );
}

describe("MIT Axiomatic Design architectural boundaries", () => {
  const sourceFiles = collectSourceFiles(SRC_ROOT);
  const relSourceFiles = sourceFiles.map((fullPath) =>
    relative(SRC_ROOT, fullPath).replaceAll("\\", "/")
  );
  const edges = collectEdges(sourceFiles);

  it("maps every source file explicitly to a known architectural layer", () => {
    for (const relPath of relSourceFiles) {
      expect(() => classifyLayer(relPath)).not.toThrow();
    }
  });

  it("keeps core/utils and core/protocols completely organized without loose implementation files", () => {
    const looseUtils = readdirSync(join(SRC_ROOT, "core/utils"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const looseProtocols = readdirSync(join(SRC_ROOT, "core/protocols"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    expect(looseUtils).toEqual([]);
    expect(looseProtocols).toEqual(["protocol-interface.ts"]);
  });

  it("keeps leaf packages (shared, rjson) completely uncoupled from other internal modules", () => {
    const violations = edges.filter(({ from, to }) => {
      const fromLayer = classifyLayer(from);
      const toLayer = classifyLayer(to);
      return (
        (fromLayer === "shared" || fromLayer === "rjson") &&
        fromLayer !== toLayer
      );
    });
    expect(violations).toEqual([]);
  });

  it("breaks the schema-coerce <-> rxml cycle and prevents rxml from importing core internals", () => {
    const schemaCoerceViolations = edges.filter(
      ({ from, to }) =>
        classifyLayer(from) === "schema-coerce" &&
        !["schema-coerce", "shared", "rjson"].includes(classifyLayer(to))
    );
    const rxmlViolations = edges.filter(
      ({ from, to }) =>
        classifyLayer(from) === "rxml" &&
        !["rxml", "schema-coerce", "shared", "rjson"].includes(
          classifyLayer(to)
        )
    );
    expect(schemaCoerceViolations).toEqual([]);
    expect(rxmlViolations).toEqual([]);
  });

  it("prevents core/utils from depending on core/protocols, core/prompts, or rxml", () => {
    const violations = edges.filter(
      ({ from, to }) =>
        classifyLayer(from) === "core/utils" &&
        [
          "core/protocols/contract",
          "core/protocols/impl",
          "core/prompts",
          "rxml",
        ].includes(classifyLayer(to))
    );
    expect(violations).toEqual([]);
  });

  it("prevents concrete protocol implementations from depending on core/prompts", () => {
    const violations = edges.filter(
      ({ from, to }) =>
        classifyLayer(from) === "core/protocols/impl" &&
        classifyLayer(to) === "core/prompts"
    );
    expect(violations).toEqual([]);
  });

  it("keeps core/prompts decoupled from core/protocols (pure prompt templates)", () => {
    const violations = edges.filter(
      ({ from, to }) =>
        classifyLayer(from) === "core/prompts" &&
        (classifyLayer(to) === "core/protocols/contract" ||
          classifyLayer(to) === "core/protocols/impl")
    );
    expect(violations).toEqual([]);
  });

  it("keeps handlers decoupled from concrete protocol implementations and core/prompts", () => {
    const violations = edges.filter(
      ({ from, to }) =>
        classifyLayer(from) === "handlers" &&
        (classifyLayer(to) === "core/protocols/impl" ||
          classifyLayer(to) === "core/prompts")
    );
    expect(violations).toEqual([]);
  });

  it("enforces a strict lower-triangular layer DAG with zero upward cross-layer dependencies", () => {
    const upwardViolations = edges.filter(({ from, to }) => {
      const fromLayer = classifyLayer(from);
      const toLayer = classifyLayer(to);
      return (
        fromLayer !== toLayer && LAYER_RANK[toLayer] > LAYER_RANK[fromLayer]
      );
    });
    expect(upwardViolations).toEqual([]);
  });

  it("enforces file-level acyclicity (zero strongly connected dependency cycles)", () => {
    const cycles = findStronglyConnectedCycles(relSourceFiles, edges);
    expect(cycles).toEqual([]);
  });

  it("enforces core/utils internal subdomain boundaries across all 11 subdomains", () => {
    const subdomainOf = (relPath: string): string | null => {
      if (!relPath.startsWith("core/utils/")) {
        return null;
      }
      return relPath.split("/")[2] ?? null;
    };

    const allowedDeps: Record<string, Set<string>> = {
      codecs: new Set(["codecs"]),
      history: new Set(["history"]),
      security: new Set(["security"]),
      xml: new Set(["xml", "primitives"]),
      primitives: new Set(["primitives", "security"]),
      coercion: new Set(["coercion", "security"]),
      response: new Set(["response", "primitives"]),
      diagnostics: new Set(["diagnostics", "primitives"]),
      transport: new Set([
        "transport",
        "diagnostics",
        "primitives",
        "security",
        "coercion",
      ]),
      streaming: new Set(["streaming", "security", "coercion"]),
      recovery: new Set([
        "recovery",
        "primitives",
        "security",
        "coercion",
        "streaming",
        "response",
      ]),
    };

    const violations = edges.filter(({ from, to }) => {
      const fromSub = subdomainOf(from);
      const toSub = subdomainOf(to);
      if (!(fromSub && toSub)) {
        return false;
      }
      const allowed = allowedDeps[fromSub];
      if (!allowed) {
        return true;
      }
      return !allowed.has(toSub);
    });
    expect(violations).toEqual([]);
  });

  it("restricts cross-protocol dependencies exclusively to black-box protocol.ts entrypoints", () => {
    const protocolFamily = (relPath: string): string | null => {
      if (!relPath.startsWith("core/protocols/")) {
        return null;
      }
      const parts = relPath.split("/");
      return parts.length >= 4 ? (parts[2] ?? null) : null;
    };

    const allowedCrossFamilyEdges = new Set([
      "k-exaone->core/protocols/qwen3coder/protocol.ts",
      "k-exaone->core/protocols/hermes/protocol.ts",
    ]);

    const violations = edges.filter(({ from, to }) => {
      const fromFamily = protocolFamily(from);
      const toFamily = protocolFamily(to);
      if (!(fromFamily && toFamily) || fromFamily === toFamily) {
        return false;
      }
      return !allowedCrossFamilyEdges.has(`${fromFamily}->${to}`);
    });
    expect(violations).toEqual([]);
  });

  it("resolves every relative import edge to a known production source file", () => {
    const knownFiles = new Set(relSourceFiles);
    const unresolved = edges.filter(({ to }) => !knownFiles.has(to));
    expect(unresolved).toEqual([]);
  });

  it("detects dynamic imports, import types, regex after if-conditions, unicode escapes, and .js/.mts/.cts specifiers while ignoring comments", () => {
    const syntheticSource = `
      // from "./ignored-comment-import"
      const doc = 'import { x } from "./ignored-string-import"';
      export type T = import("../core/protocols/protocol-interface.js").TCMProtocol;
      export async function load(condition: boolean, value: string) {
        if (condition) /"/.test(value);
        const a = await import("../generate-handler.js");
        const b = await import("\\u002e\\u002e/stream-handler");
        const c = await import("\\x2e\\x2e/transform-handler");
        const d = await import("\\u{2e}\\u{2e}/tool-call-middleware");
        return [a, b, c, d];
      }
    `;
    const fromFile = join(SRC_ROOT, "shared/synthetic-fixture.mts");
    const specifiers = collectRelativeSpecifiersFromSource(syntheticSource);
    expect(specifiers).toEqual([
      "../core/protocols/protocol-interface.js",
      "../generate-handler.js",
      "../stream-handler",
      "../transform-handler",
      "../tool-call-middleware",
    ]);

    const resolvedTargets = specifiers.map((specifier) =>
      resolveRelativeImport(fromFile, specifier)
    );
    expect(resolvedTargets).toEqual([
      "core/protocols/protocol-interface.ts",
      "generate-handler.ts",
      "stream-handler.ts",
      "transform-handler.ts",
      "tool-call-middleware.ts",
    ]);

    const upwardViolations = resolvedTargets.filter(
      (to) =>
        LAYER_RANK[classifyLayer(to)] >
        LAYER_RANK[classifyLayer("shared/synthetic-fixture.mts")]
    );
    expect(upwardViolations).toEqual(resolvedTargets);

    expect(isProductionSourceFileName("module.ts")).toBe(true);
    expect(isProductionSourceFileName("module.mts")).toBe(true);
    expect(isProductionSourceFileName("module.cts")).toBe(true);
    expect(isProductionSourceFileName("module.d.ts")).toBe(false);
    expect(isProductionSourceFileName("module.d.mts")).toBe(false);
    expect(isProductionSourceFileName("module.d.cts")).toBe(false);
    expect(
      resolveRelativeImport(
        fromFile,
        "./helper.mjs",
        (path) => path === join(SRC_ROOT, "shared/helper.mts")
      )
    ).toBe("shared/helper.mts");
    expect(
      resolveRelativeImport(
        fromFile,
        "./legacy.cjs",
        (path) => path === join(SRC_ROOT, "shared/legacy.cts")
      )
    ).toBe("shared/legacy.cts");
  });

  it("bounds module information content by keeping every production source file at or below 600 LOC", () => {
    const oversized = sourceFiles
      .map((fullPath) => ({
        file: relative(SRC_ROOT, fullPath).replaceAll("\\", "/"),
        loc: readFileSync(fullPath, "utf8").split("\n").length,
      }))
      .filter(({ loc }) => loc > MAX_SOURCE_FILE_LOC);
    expect(oversized).toEqual([]);
  });
});
