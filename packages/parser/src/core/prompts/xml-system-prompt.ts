import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import dedent from "dedent";

export function xmlSystemPromptTemplate(
  tools: LanguageModelV3FunctionTool[]
): string {
  const toolsJson = JSON.stringify(tools);

  const header = dedent`
    # Tools
    You may call one or more functions to assist with the user query.

    You have access to the following functions:
    <tools>${toolsJson}</tools>
  `;

  const rules = dedent`
    <rules>
    - Use exactly one XML element whose tag name is the function name. 1Code has comments. Press enter to view.
    - Put each parameter as a child element.
    - Values must follow the schema exactly (numbers, arrays, objects, enums → copy as-is).
    - Do not add or remove functions or parameters.
    - Each required parameter must appear once.
    - Output nothing before or after the function call.
    - It is also possible to call multiple types of functions in one turn or to call a single function multiple times.
    </rules>
  `;

  const examples = dedent`
    For each function call, output the function name and parameter in the following format:
    <example_function_name>
      <example_parameter_1>value_1</example_parameter_1>
      <example_parameter_2>This is the value for the second parameter
    that can span
    multiple lines</example_parameter_2>
    </example_function_name>
  `;

  return [header, rules, examples].join("\n\n");
}
