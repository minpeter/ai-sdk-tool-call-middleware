import { evaluate } from "@ai-sdk-tool/eval";
import path from "path";
import { openai } from "@ai-sdk/openai"; // replace with your library's LanguageModel

import { loadLocalDataset } from "@ai-sdk-tool/eval/data/bfcl/loader";

async function main() {
  const model = openai("gpt-4.1");
  const datasetPath = path.resolve(__dirname, "./data/bfcl/sample.json");
  const dataset = await loadLocalDataset(datasetPath);

  await evaluate({
    matrix: { model },
    benchmarks: [
      /* bfcl benchmark reference, e.g. get from registry */
    ],
    reporterType: "console",
    dataset,
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
