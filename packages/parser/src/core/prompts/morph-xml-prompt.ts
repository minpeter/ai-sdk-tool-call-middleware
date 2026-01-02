export function morphXmlSystemPromptTemplate(tools: string): string {
  return `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>${tools}</tools>

# Rules
- Use exactly one XML element whose tag name is the function name.
- Put each parameter as a child element.
- Values must follow the schema exactly (numbers, arrays, objects, enums → copy as-is).
- Do not add or remove functions or parameters.
- Each required parameter must appear once.
- Output nothing before or after the function call.
- After calling a tool, you will receive a response in the format: <tool_response><tool_name>NAME</tool_name><result>RESULT</result></tool_response>. Use this result to answer the user.

# Example
<get_weather>
  <location>New York</location>
  <unit>celsius</unit>
</get_weather>`;
}
