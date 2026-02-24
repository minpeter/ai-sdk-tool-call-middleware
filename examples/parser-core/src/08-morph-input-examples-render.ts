import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  JSONObject,
  JSONSchema7,
  LanguageModelV3FunctionTool,
} from "@ai-sdk/provider";
import { morphXmlSystemPromptTemplate } from "../../../src/core/prompts/morph-xml-prompt";

type SectionMode = "examples" | "full" | "tools";

interface FixtureDocument {
  title?: string;
  tools: LanguageModelV3FunctionTool[];
}

interface CliOptions {
  filePath?: string;
  help: boolean;
  list: boolean;
  scenario: string;
  section: SectionMode;
}

const INPUT_EXAMPLES_HEADER = "# Input Examples";
const DEFAULT_SCENARIO = "weather-basic";
const SECTION_MODES: SectionMode[] = ["full", "examples", "tools"];

const BUILTIN_FIXTURES: Record<string, FixtureDocument> = {
  "weather-basic": {
    title: "Single tool with two examples",
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city and optional unit",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
            unit: {
              type: "string",
              enum: ["celsius", "fahrenheit"],
              default: "celsius",
            },
          },
          required: ["city"],
        } satisfies JSONSchema7,
        inputExamples: [
          { input: { city: "Seoul", unit: "celsius" } },
          { input: { city: "Busan" } },
        ],
      },
    ],
  },
  "multi-tools": {
    title: "Two tools with separate examples",
    tools: [
      {
        type: "function",
        name: "search_docs",
        description: "Search internal docs by query and optional limit",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", default: 5 },
          },
          required: ["query"],
        } satisfies JSONSchema7,
        inputExamples: [
          { input: { query: "tool input examples", limit: 3 } },
          { input: { query: "morph xml prompt" } },
        ],
      },
      {
        type: "function",
        name: "write_file",
        description: "Write text content to a file path",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            content: { type: "string" },
          },
          required: ["file_path", "content"],
        } satisfies JSONSchema7,
        inputExamples: [
          {
            input: {
              file_path: "/tmp/demo.txt",
              content: "line 1\nline 2\nline 3",
            },
          },
        ],
      },
    ],
  },
  "nested-arguments": {
    title: "Nested objects and arrays in one tool",
    tools: [
      {
        type: "function",
        name: "create_plan",
        description: "Create a plan with tasks and metadata",
        inputSchema: {
          type: "object",
          properties: {
            goal: { type: "string" },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  owner: { type: "string" },
                },
                required: ["title"],
              },
            },
            tags: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["goal", "tasks"],
        } satisfies JSONSchema7,
        inputExamples: [
          {
            input: {
              goal: "Ship parser improvements",
              tasks: [
                { title: "Add tests", owner: "alice" },
                { title: "Run benchmarks", owner: "bob" },
              ],
              tags: ["parser", "release"],
            },
          },
        ],
      },
    ],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSectionMode(value: string): SectionMode {
  const sectionMode = SECTION_MODES.find((mode) => mode === value);
  if (sectionMode !== undefined) {
    return sectionMode;
  }

  throw new Error(
    `Invalid --section value: ${value}. Use one of: ${SECTION_MODES.join(", ")}.`
  );
}

function readOptionValue(
  argv: string[],
  index: number,
  optionName: string
): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    list: false,
    scenario: DEFAULT_SCENARIO,
    section: "full",
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h": {
        options.help = true;
        index += 1;
        break;
      }

      case "--list": {
        options.list = true;
        index += 1;
        break;
      }

      case "--scenario": {
        options.scenario = readOptionValue(argv, index, "--scenario");
        index += 2;
        break;
      }

      case "--file": {
        options.filePath = readOptionValue(argv, index, "--file");
        index += 2;
        break;
      }

      case "--section": {
        const mode = readOptionValue(argv, index, "--section");
        options.section = parseSectionMode(mode);
        index += 2;
        break;
      }

      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function toValidatedInputExamples(
  value: unknown,
  toolIndex: number
): Array<{ input: JSONObject }> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`tools[${toolIndex}].inputExamples must be an array.`);
  }

  return value.map((example, exampleIndex) => {
    if (!(isRecord(example) && "input" in example)) {
      throw new Error(
        `tools[${toolIndex}].inputExamples[${exampleIndex}] must have an input field.`
      );
    }

    if (!isRecord(example.input)) {
      throw new Error(
        `tools[${toolIndex}].inputExamples[${exampleIndex}].input must be an object.`
      );
    }

    return {
      input: example.input as JSONObject,
    };
  });
}

function toMorphToolFixture(
  value: unknown,
  toolIndex: number
): LanguageModelV3FunctionTool {
  if (!isRecord(value)) {
    throw new Error(`tools[${toolIndex}] must be an object.`);
  }

  if (value.type !== "function") {
    throw new Error(`tools[${toolIndex}].type must be "function".`);
  }

  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`tools[${toolIndex}].name must be a non-empty string.`);
  }

  if (!("inputSchema" in value)) {
    throw new Error(`tools[${toolIndex}].inputSchema is required.`);
  }

  const description =
    typeof value.description === "string" ? value.description : undefined;
  const inputExamples = toValidatedInputExamples(
    value.inputExamples,
    toolIndex
  );

  return {
    type: "function",
    name: value.name,
    description,
    inputSchema: value.inputSchema as JSONSchema7,
    inputExamples,
  };
}

function parseFixtureDocument(value: unknown): FixtureDocument {
  if (!isRecord(value)) {
    throw new Error("Fixture file must be a JSON object.");
  }

  if (!Array.isArray(value.tools)) {
    throw new Error("Fixture file must include tools: [...].");
  }

  return {
    title: typeof value.title === "string" ? value.title : undefined,
    tools: value.tools.map(toMorphToolFixture),
  };
}

async function loadFixture(options: CliOptions): Promise<FixtureDocument> {
  if (options.filePath) {
    const resolvedPath = path.resolve(process.cwd(), options.filePath);
    const raw = await readFile(resolvedPath, "utf8");
    return parseFixtureDocument(JSON.parse(raw) as unknown);
  }

  const fixture = BUILTIN_FIXTURES[options.scenario];
  if (!fixture) {
    const available = Object.keys(BUILTIN_FIXTURES).join(", ");
    throw new Error(
      `Unknown scenario: ${options.scenario}. Available scenarios: ${available}`
    );
  }

  return fixture;
}

function listScenarios(): void {
  console.log("Available scenarios:");
  for (const [name, fixture] of Object.entries(BUILTIN_FIXTURES)) {
    const suffix = fixture.title ? ` - ${fixture.title}` : "";
    console.log(`- ${name}${suffix}`);
  }
}

function printHelp(): void {
  console.log(
    [
      "Render MorphXML system prompt with tool inputExamples.",
      "",
      "Usage:",
      "  pnpm dlx tsx examples/parser-core/src/08-morph-input-examples-render.ts [options]",
      "",
      "Options:",
      "  --scenario <name>   Use a built-in scenario (default: weather-basic)",
      "  --file <path>       Load fixture JSON file (overrides --scenario)",
      "  --section <mode>    full | examples | tools (default: full)",
      "  --list              List built-in scenarios",
      "  --help, -h          Show this help",
      "",
      "Examples:",
      "  pnpm dlx tsx examples/parser-core/src/08-morph-input-examples-render.ts --list",
      "  pnpm dlx tsx examples/parser-core/src/08-morph-input-examples-render.ts --scenario multi-tools --section examples",
      "  pnpm dlx tsx examples/parser-core/src/08-morph-input-examples-render.ts --file examples/parser-core/src/08-morph-input-examples-render.sample.json --section full",
    ].join("\n")
  );
}

function extractExamplesSection(renderedPrompt: string): string {
  const markerIndex = renderedPrompt.indexOf(INPUT_EXAMPLES_HEADER);
  if (markerIndex === -1) {
    return "(no input example section rendered)";
  }

  return renderedPrompt.slice(markerIndex).trim();
}

function printRenderedOutput(options: {
  fixture: FixtureDocument;
  section: SectionMode;
}): void {
  const { fixture, section } = options;
  const renderedPrompt = morphXmlSystemPromptTemplate(fixture.tools);

  if (section === "tools") {
    console.log(JSON.stringify(fixture.tools, null, 2));
    return;
  }

  if (section === "examples") {
    console.log(extractExamplesSection(renderedPrompt));
    return;
  }

  console.log(renderedPrompt);
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (options.list) {
    listScenarios();
    return;
  }

  const fixture = await loadFixture(options);
  printRenderedOutput({
    fixture,
    section: options.section,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[render-error] ${message}`);
  process.exit(1);
});
