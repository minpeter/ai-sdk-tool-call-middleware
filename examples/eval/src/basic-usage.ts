import { evaluate, getAllBenchmarks } from "@ai-sdk-tool/eval";
import { openai } from "@ai-sdk/openai"; // replace with your library's LanguageModel

async function main() {
  // Create a model instance (replace with your own credentials/config)
  const model = openai("gpt-4.1");

  // Pick benchmarks to run (use registry helpers)
  const benches = getAllBenchmarks().filter(b => b.name === "summarization");

  await evaluate({
    matrix: { models: [model] },
    benchmarks: benches,
    reporterType: "console",
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
