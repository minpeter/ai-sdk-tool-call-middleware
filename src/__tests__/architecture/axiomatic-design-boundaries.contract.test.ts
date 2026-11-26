import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RELATIVE_IMPORT_RE =
  /(?:from|import)\s+["'](\.[^"']+)["']|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["'](\.[^"']+)["']/g;
const MAX_SOURCE_FILE_LOC = 600;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
  const base = normalize(join(dirname(fromFile), specifier));
  if (base.endsWith(".ts")) {
    return relative(SRC_ROOT, base).replaceAll("\\", "/");
  }
  if (existsSync(`${base}.ts`)) {
    return relative(SRC_ROOT, `${base}.ts`).replaceAll("\\", "/");
  }
  if (existsSync(join(base, "index.ts"))) {
    return relative(SRC_ROOT, join(base, "index.ts")).replaceAll("\\", "/");
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
    for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) {
        continue;
      }
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
