import type { TCMToolDefinition } from "../types";

export function yamlSystemPromptTemplate(
  tools: TCMToolDefinition[],
  includeMultilineExample = true
): string {
  const toolsJson = JSON.stringify(tools);
  const multilineExample = includeMultilineExample
    ? `

For multiline values, use YAML's literal block syntax:
<write_file>
file_path: /tmp/example.txt
contents: |
  First line
  Second line
  Third line
</write_file>`
    : "";

  return `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>${toolsJson}</tools>

# Format

Use exactly one XML element whose tag name is the function name.
Inside the XML element, specify parameters using YAML syntax (key: value pairs).

# Example
<get_weather>
location: New York
unit: celsius
</get_weather>${multilineExample}

# Rules
- Parameter names and values must follow the schema exactly.
- Use proper YAML syntax for values (strings, numbers, booleans, arrays, objects).
- Each required parameter must appear once.
- Do not add functions or parameters not in the schema.
- After calling a tool, you will receive a response. Use this result to answer the user.
- Do NOT ask clarifying questions. Use reasonable defaults for optional parameters.
- If a task requires multiple function calls, make ALL of them at once.`;
}
