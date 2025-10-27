const { execSync } = require("node:child_process");

try {
  const result = execSync(
    "node_modules/.bin/biome check --write --max-diagnostics 50 packages/eval/src/benchmarks/json-generation.ts packages/rxml/src/core/tokenizer.ts packages/rxml/tests/fixtures/test-data.ts",
    {
      cwd: "/data/minpeter/github.com/minpeter/ai-sdk-tool-call-middleware",
      encoding: "utf-8",
      stdio: "pipe",
    }
  );
  console.log(result);
} catch (error) {
  console.log(error.stdout);
  console.error(error.stderr);
  process.exit(error.status);
}
