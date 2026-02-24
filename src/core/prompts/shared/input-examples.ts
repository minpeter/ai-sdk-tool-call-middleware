import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";

export interface ToolInputExample {
  input: unknown;
}

export function getToolInputExamples(
  tool: LanguageModelV3FunctionTool
): ToolInputExample[] {
  const inputExamples = (
    tool as LanguageModelV3FunctionTool & {
      inputExamples?: Array<{ input: unknown }>;
    }
  ).inputExamples;

  if (!Array.isArray(inputExamples)) {
    return [];
  }

  return inputExamples.filter(
    (example) =>
      typeof example === "object" &&
      example !== null &&
      "input" in example &&
      example.input !== undefined
  );
}

export function safeStringifyInputExample(
  input: unknown,
  sourceError?: unknown
): string {
  try {
    const serialized = JSON.stringify(input);
    return serialized ?? "null";
  } catch (stringifyError) {
    let reason = "";

    if (sourceError instanceof Error) {
      reason = sourceError.message;
    } else if (stringifyError instanceof Error) {
      reason = stringifyError.message;
    }

    return reason.length > 0
      ? `[unserializable input: ${reason}]`
      : "[unserializable input]";
  }
}

export function stringifyInputExampleAsJsonLiteral(input: unknown): string {
  try {
    const serialized = JSON.stringify(input);
    return serialized ?? "null";
  } catch (error) {
    const fallbackText = safeStringifyInputExample(input, error);
    return JSON.stringify(fallbackText);
  }
}

interface RenderInputExamplesSectionOptions {
  renderExample: (toolName: string, input: unknown) => string;
  tools: LanguageModelV3FunctionTool[];
}

const INPUT_EXAMPLES_SECTION_HEADER = [
  "# Input Examples",
  "Treat these as canonical tool-call patterns.",
  "Reuse the closest structure and nesting, change only values, and do not invent parameters.",
  "Do not copy example values unless they match the user's request.",
];

export function renderInputExamplesSection(
  options: RenderInputExamplesSectionOptions
): string {
  const renderedTools = options.tools
    .map((tool) => {
      const inputExamples = getToolInputExamples(tool);
      if (inputExamples.length === 0) {
        return "";
      }

      const renderedExamples = inputExamples
        .map((example, index) => {
          const rendered = options.renderExample(tool.name, example.input);
          return `Example ${index + 1}:\n${rendered}`;
        })
        .join("\n\n");

      return `Tool: ${tool.name}\n${renderedExamples}`;
    })
    .filter((text) => text.length > 0)
    .join("\n\n");

  if (renderedTools.length === 0) {
    return "";
  }

  return [...INPUT_EXAMPLES_SECTION_HEADER, renderedTools].join("\n\n");
}
