import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const XML_CURRENT_VIEW_OBJECT_DELTA_RE =
  /=== XML protocol ===[\s\S]*Current view: parsed-object streaming tool input[\s\S]*tool-input-delta\(id=[^,]+, delta="\{"location":"Seoul","unit":"celsius"/;

const YAML_CURRENT_VIEW_OBJECT_DELTA_RE =
  /=== YAML protocol ===[\s\S]*Current view: parsed-object streaming tool input[\s\S]*tool-input-delta\(id=[^,]+, delta="\{"location":"Seoul","unit":"celsius"/;

describe("tool-input delta compare example output", () => {
  it("shows raw snapshot and parsed-object streaming deltas side-by-side", () => {
    const output = execFileSync(
      "pnpm",
      [
        "dlx",
        "tsx",
        "examples/parser-core/src/03-stream-tool-input-delta-compare.ts",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      }
    );

    expect(output).toContain(
      "[Raw delta snapshot (before XML/YAML object-delta change)]"
    );
    expect(output).toContain("=== XML protocol ===");
    expect(output).toContain("=== YAML protocol ===");
    expect(output).toContain(
      'tool-input-delta(id=example, delta="<location>Seoul</location>\\n<unit>ce")'
    );
    expect(output).toContain(
      'tool-input-delta(id=example, delta="location: Seoul\\nu")'
    );
    expect(output).toMatch(XML_CURRENT_VIEW_OBJECT_DELTA_RE);
    expect(output).toMatch(YAML_CURRENT_VIEW_OBJECT_DELTA_RE);
  });
});
