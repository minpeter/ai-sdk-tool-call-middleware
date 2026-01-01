// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface
import { jsonMixProtocol } from "../core/protocols/json-mix-protocol";
import { morphXmlProtocol } from "../core/protocols/morph-xml-protocol";
import { createToolMiddlewareV5 } from "./tool-call-middleware";

export const gemmaToolMiddleware = createToolMiddlewareV5({
  protocol: jsonMixProtocol({
    toolCallStart: "```tool_call\n",
    toolCallEnd: "\n```",
    toolResponseStart: "```tool_response\n",
    toolResponseEnd: "\n```",
  }),
  toolSystemPromptTemplate(tools) {
    return `You have access to functions. If you decide to invoke any of the function(s),
you MUST put it in the format of markdown code fence block with the language name of tool_call , e.g.
\`\`\`tool_call
{'name': <function-name>, 'arguments': <args-dict>}
\`\`\`
You SHOULD NOT include any other text in the response if you call a function
${tools}`;
  },
});

export const hermesToolMiddleware = createToolMiddlewareV5({
  protocol: jsonMixProtocol,
  toolSystemPromptTemplate(tools) {
    return `You are a function calling AI model.
You are provided with function signatures within <tools></tools> XML tags.
You may call one or more functions to assist with the user query.
Don't make assumptions about what values to plug into functions.
Here are the available tools: <tools>${tools}</tools>
Use the following pydantic model json schema for each tool call you will make: {"title": "FunctionCall", "type": "object", "properties": {"arguments": {"title": "Arguments", "type": "object"}, "name": {"title": "Name", "type": "string"}}, "required": ["arguments", "name"]}
For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"name": "<function-name>", "arguments": <args-dict>}
</tool_call>`;
  },
});

export const morphXmlToolMiddleware = createToolMiddlewareV5({
  protocol: morphXmlProtocol,
  placement: "last",
  toolSystemPromptTemplate(tools: string) {
    return `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>${tools}</tools>

# Rules
- For each function call, use one XML element whose tag name is the function name.
- Put each parameter as a child element.
- Values must follow the schema exactly (numbers, arrays, objects, enums → copy as-is).
- Do not add or remove functions or parameters.
- Each required parameter must appear once.
- If multiple function calls are needed, output them sequentially one after another.
- After calling a tool, you will receive a response in the format: <tool_response><tool_name>NAME</tool_name><result>RESULT</result></tool_response>. Use this result to answer the user.

# Examples

## Single function call
<get_weather>
  <location>New York</location>
  <unit>celsius</unit>
</get_weather>

## Multiple function calls (when the task requires calling multiple functions)
<get_weather>
  <location>New York</location>
  <unit>celsius</unit>
</get_weather>
<get_weather>
  <location>London</location>
  <unit>celsius</unit>
</get_weather>`;
  },
});

export { createToolMiddlewareV5 as createToolMiddleware } from "./tool-call-middleware";
