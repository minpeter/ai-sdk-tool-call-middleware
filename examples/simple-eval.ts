import 'dotenv/config';
import { evaluate, bfclSimpleBenchmark } from '@ai-sdk-tool/eval';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

async function main() {
  console.log('--- Running Evaluation Example ---');

  // 1. Instantiate the model provider.
  // Make sure you have OPENROUTER_API_KEY in your .env file.
  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  // 2. Define the models to evaluate from the provider.
  const gemma9b = openrouter('google/gemma-3-9b-it');
  const gemma27b = openrouter('google/gemma-3-27b-it');

  // 3. Run the evaluation with the desired models and benchmarks.
  const results = await evaluate({
    models: [gemma9b, gemma27b],
    benchmarks: [
      bfclSimpleBenchmark,
    ],
    reporter: 'console',
  });

  console.log('\n--- Evaluation Example Complete ---');
}

main().catch(error => {
  console.error('An error occurred during evaluation:', error);
  process.exit(1);
});
