import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_SOURCE_FILE_LOC = 600;
const JS_TO_TS_EXTENSION: ReadonlyArray<readonly [string, string]> = [
  [".js", ".ts"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
];

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

function readStaticStringExpression(node: unknown): string | undefined {
  if (!node || typeof node !== "object") {
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (record.type === "Literal" && typeof record.value === "string") {
    return record.value;
  }
  if (
    record.type === "TemplateLiteral" &&
    Array.isArray(record.expressions) &&
    record.expressions.length === 0 &&
    Array.isArray(record.quasis)
  ) {
    const firstQuasi = record.quasis[0] as
      | { value?: { cooked?: unknown } }
      | undefined;
    if (typeof firstQuasi?.value?.cooked === "string") {
      return firstQuasi.value.cooked;
    }
  }
  return undefined;
}

function collectRelativeSpecifiersFromSource(
  sourceText: string,
  fileName = "module.ts"
): string[] {
  const parsed = parseSync(fileName, sourceText, { lang: "ts" });
  if (parsed.errors.length > 0) {
    throw new Error(
      `Failed to parse TypeScript source ${fileName}: ${parsed.errors[0]?.message}`
    );
  }

  const specifiers: string[] = [];
  const recordIfRelative = (specifier: string | undefined) => {
    if (specifier?.startsWith(".")) {
      specifiers.push(specifier);
    }
  };

  const extractNodeSpecifier = (
    record: Record<string, unknown>
  ): string | undefined => {
    switch (record.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
      case "ImportExpression":
        return readStaticStringExpression(record.source);
      case "TSImportType": {
        const directSource = readStaticStringExpression(record.source);
        if (directSource !== undefined) {
          return directSource;
        }
        const arg = record.argument as
          | { literal?: unknown; type?: unknown }
          | undefined;
        return arg?.type === "TSLiteralType"
          ? readStaticStringExpression(arg.literal)
          : undefined;
      }
      case "TSExternalModuleReference":
        return readStaticStringExpression(record.expression);
      case "CallExpression": {
        const callee = record.callee as
          | { name?: unknown; type?: unknown }
          | undefined;
        return callee?.type === "Identifier" &&
          callee.name === "require" &&
          Array.isArray(record.arguments)
          ? readStaticStringExpression(record.arguments[0])
          : undefined;
      }
      default:
        return undefined;
    }
  };

  const visitNode = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visitNode(item);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    recordIfRelative(extractNodeSpecifier(record));

    for (const [key, value] of Object.entries(record)) {
      if (key === "type" || key === "start" || key === "end") {
        continue;
      }
      visitNode(value);
    }
  };

  visitNode(parsed.program);
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
    for (const specifier of collectRelativeSpecifiersFromSource(
      source,
      fullPath
    )) {
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

  it("detects dynamic imports, import types, regex after if/for-await/block statements, unicode and LS/PS continuations, and .js/.mts/.cts specifiers while ignoring comments", () => {
    const syntheticSource = `
      // from "./ignored-comment-import"
      const doc = 'import { x } from "./ignored-string-import"';
      export type T = import("../core/protocols/protocol-interface.js").TCMProtocol;
      export async function load(
        condition: boolean,
        value: string,
        items: AsyncIterable<string>
      ) {
        if (condition) /"/.test(value);
        if (condition) {
          void value;
        }
        /"/.test(value);
        for await (const item of items) /"/.test(item);
        const a = await import("../generate-handler.js");
        const b = await import("\\u002e\\u002e/stream-handler");
        const c = await import("\\x2e\\x2e/transform-handler");
        const d = await import("\\u{2e}\\u{2e}/tool-call-middleware");
        const e = await import("..\\${"\u2028"}/generate-handler");
        const f = await import("..\\${"\u2029"}/stream-handler");
        return [a, b, c, d, e, f];
      }
    `;
    const fromFile = join(SRC_ROOT, "shared/synthetic-fixture.mts");
    const specifiers = collectRelativeSpecifiersFromSource(
      syntheticSource,
      fromFile
    );
    expect(specifiers).toEqual([
      "../core/protocols/protocol-interface.js",
      "../generate-handler.js",
      "../stream-handler",
      "../transform-handler",
      "../tool-call-middleware",
      "../generate-handler",
      "../stream-handler",
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
      "generate-handler.ts",
      "stream-handler.ts",
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
