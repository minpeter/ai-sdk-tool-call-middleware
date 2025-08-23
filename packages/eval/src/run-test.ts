import {
  simpleFunctionChecker,
  parallelFunctionCheckerNoOrder,
  ToolCall, // Import the local interface
} from './benchmarks/bfcl/ast-checker.js';

// --- Mock Data Interfaces ---
interface FunctionDescription {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: {
      [key:string]: {
        type: string;
        description?: string;
        items?: { type: string };
      };
    };
    required: string[];
  };
}

function runSimpleCheckTest() {
  console.log('--- Running simpleFunctionChecker Test ---');

  const funcDescription: FunctionDescription = {
    name: 'calculate_triangle_area',
    description: 'Calculate the area of a triangle.',
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'integer' },
        height: { type: 'integer' },
        unit: { type: 'string' },
      },
      required: ['base', 'height'],
    },
  };

  const modelToolCall: ToolCall = {
    toolCallId: '1',
    toolName: 'calculate_triangle_area',
    args: { base: 10, height: 5, unit: 'cm' },
  };

  const possibleAnswer = {
    calculate_triangle_area: {
      base: [10],
      height: [5],
      unit: ['cm', 'inches'],
    },
  };

  const result = simpleFunctionChecker(funcDescription, modelToolCall, possibleAnswer);
  console.log('Test Result:', result);
  if (!result.valid) {
      console.error("Simple check test FAILED!");
      process.exit(1);
  }
  console.log('Simple check test PASSED!');
}

function runParallelCheckTest() {
    console.log('\n--- Running parallelFunctionCheckerNoOrder Test ---');

    const funcDescriptions: FunctionDescription[] = [
        { name: 'func_A', description: '', parameters: { type: 'object', properties: { p1: { type: 'string' } }, required: ['p1'] } },
        { name: 'func_B', description: '', parameters: { type: 'object', properties: { p2: { type: 'number' } }, required: ['p2'] } },
    ];

    const modelToolCalls: ToolCall[] = [
        { toolCallId: '2', toolName: 'func_B', args: {p2: 123} },
        { toolCallId: '1', toolName: 'func_A', args: {p1: "hello"} },
    ];

    const possibleAnswers = [
        { func_A: { p1: ['hello'] } },
        { func_B: { p2: [123] } },
    ];

    const result = parallelFunctionCheckerNoOrder(funcDescriptions, modelToolCalls, possibleAnswers);
    console.log('Test Result:', result);
    if (!result.valid) {
        console.error("Parallel check test FAILED!");
        process.exit(1);
    }
    console.log('Parallel check test PASSED!');
}

function main() {
  runSimpleCheckTest();
  runParallelCheckTest();
}

main();
