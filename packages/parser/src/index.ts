import { createToolMiddleware } from "./tool-call-middleware";

const gemmaToolMiddleware = createToolMiddleware({
  toolSystemPromptTemplate(tools) {
    return `You have access to functions. If you decide to invoke any of the function(s),
you MUST put it in the format of markdown code fence block with the language name of tool_call , e.g.
\`\`\`tool_call
{'name': <function-name>, 'arguments': <args-dict>}
\`\`\`
You SHOULD NOT include any other text in the response if you call a function
${tools}`;
  },
  toolCallTag: "```tool_call\n",
  toolCallEndTag: "\n``",  // two backticks are more common in gemma output
  toolResponseTag: "```tool_response\n",
  toolResponseEndTag: "\n```",
});

const hermesToolMiddleware = createToolMiddleware({
  toolSystemPromptTemplate(tools) {
    return `You are a function calling AI model.
You are provided with function signatures within <tools></tools> XML tags.
You may call one or more functions to assist with the user query.
Don't make assumptions about what values to plug into functions.
Here are the available tools: <tools>${tools}</tools>
Use the following pydantic model json schema for each tool call you will make: {'title': 'FunctionCall', 'type': 'object', 'properties': {'arguments': {'title': 'Arguments', 'type': 'object'}, 'name': {'title': 'Name', 'type': 'string'}}, 'required': ['arguments', 'name']}
For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{'arguments': <args-dict>, 'name': <function-name>}
</tool_call>`;
  },
  toolCallTag: "<tool_call>",
  toolCallEndTag: "</tool_call>",
  toolResponseTag: "<tool_response>",
  toolResponseEndTag: "</tool_response>",
});

export { gemmaToolMiddleware, hermesToolMiddleware, createToolMiddleware };
