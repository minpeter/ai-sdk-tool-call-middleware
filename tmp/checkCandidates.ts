import path from "path";
import fs from "fs";
import { loadLocalDataset } from "../packages/eval/src/data/bfcl/loader";

const candidates = [
  undefined,
  path.join(
    process.cwd(),
    "examples",
    "eval",
    "data",
    "bfcl",
    "BFCL_v3_simple.json"
  ),
  path.join(process.cwd(), "data", "bfcl", "BFCL_v3_simple.json"),
  path.join(
    process.cwd(),
    "..",
    "examples",
    "eval",
    "data",
    "bfcl",
    "BFCL_v3_simple.json"
  ),
  path.join(process.cwd(), "examples", "eval", "data", "bfcl", "sample.json"),
  path.join(
    __dirname,
    "..",
    "packages",
    "eval",
    "data",
    "bfcl",
    "BFCL_v3_simple.jsonl"
  ),
  path.join(
    __dirname,
    "..",
    "packages",
    "eval",
    "data",
    "bfcl",
    "BFCL_v3_simple.json"
  ),
].filter(Boolean) as string[];

for (const p of candidates) {
  try {
    console.log("checking", p, "exists=", fs.existsSync(p));
    const ds = loadLocalDataset(p);
    console.log(
      "loaded",
      p,
      "->",
      Array.isArray(ds) ? `array len=${(ds as any).length}` : typeof ds
    );
  } catch (e) {
    console.log("failed", p, "error=", (e as Error).message);
  }
}
