import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RELATIVE_IMPORT_RE =
  /(?:from|import)\s+["'](\.[^"']+)["']|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["'](\.[^"']+)["']/g;

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

function collectEdges(): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const fullPath of collectSourceFiles(SRC_ROOT)) {
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
  if (
    relPath === "core/protocols/protocol-interface.ts" ||
    relPath === "core/protocols/protocol-fast-paths.ts"
  ) {
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
    relPath === "transform-handler.ts" ||
    relPath === "k-exaone-236b-transform.ts"
  ) {
    return "handlers";
  }
  if (relPath.startsWith("community/")) {
    return "community";
  }
  return "entry";
}

describe("MIT Axiomatic Design architectural boundaries", () => {
  const edges = collectEdges();

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
        !["rxml", "schema-coerce", "shared"].includes(classifyLayer(to))
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

  it("keeps generate-handler and stream-handler decoupled from concrete protocol implementations", () => {
    const violations = edges.filter(
      ({ from, to }) =>
        (from === "generate-handler.ts" || from === "stream-handler.ts") &&
        classifyLayer(to) === "core/protocols/impl"
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
});
