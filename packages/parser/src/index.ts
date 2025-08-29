import { jsonMixProtocol, morphXmlProtocol } from "./protocols";
import { createToolMiddleware } from "./tool-call-middleware";

const gemmaToolMiddleware = createToolMiddleware({
  protocol: jsonMixProtocol(
    // Customize the tool call delimiters to use markdown code fences
    {
      toolCallStart: "```tool_call\n",
      // TODO: Support specifying multiple possible tags,
      // e.g., for gemma, it would be nice to be able to set both `` and ``` at the same time.
      toolCallEnd: "\n```",
      toolResponseStart: "```tool_response\n",
      toolResponseEnd: "\n```",
    }
  ),
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

const hermesToolMiddleware = createToolMiddleware({
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

const xmlToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
  toolSystemPromptTemplate(tools: string) {
    return `You are a function calling AI model.
You are provided with function signatures within <tools></tools> XML tags.
You may call one or more functions to assist with the user query.
Don't make assumptions about what values to plug into functions.
Here are the available tools: <tools>${tools}</tools>
For a function call, return exactly one XML element whose tag name matches the tool's name, and nothing else.
When an argument is an array, write each item inside a single element on one line separated by commas (or provide a JSON-like list). When an argument is an object, provide a JSON-like value.
Examples:
<get_weather>
<location>
San Fransisco
</location>
</get_weather>`;
  },
});

export {
  createToolMiddleware,
  gemmaToolMiddleware,
  hermesToolMiddleware,
  jsonMixProtocol,
  morphXmlProtocol,
  xmlToolMiddleware,
};
