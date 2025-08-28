import { createToolMiddleware } from "./tool-call-middleware";
import { jsonMixProtocol, xmlProtocol } from "./protocols";

const gemmaToolMiddleware = createToolMiddleware({
  protocol: jsonMixProtocol(
    // Customize the tool call delimiters to use markdown code fences
    {
      toolCallStart: "```tool_call\n",
      toolCallEnd: "\n``", // two backticks are more common in gemma output @
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
  protocol: xmlProtocol,
  toolSystemPromptTemplate(tools: string) {
    return `You are KorinAI, a function-calling AI model.
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

const morphExpToolMiddleware = createToolMiddleware({
  protocol: xmlProtocol,
  toolSystemPromptTemplate(tools: string) {
    return `You are a function-calling AI model. Your primary task is to respond to user requests by calling the available tools.
When a function call is required, you must respond with ONLY the XML for the function call(s) and nothing else. Adhere strictly to the format specified below.

<tools>
${tools}
</tools>

### XML Formatting Rules

1.  **Single Function Call:**
    The root element's tag name must be the name of the function to be called. Its child elements represent the arguments.
    <function_name>
        <argument_name_1>value_1</argument_name_1>
        <argument_name_2>value_2</argument_name_2>
    </function_name>

2.  **Multiple Function Calls:**
    If you need to call multiple functions in a single turn, simply output each function's XML structure sequentially. **Do NOT use any wrapper element.**
    
    <function_name_1>
        <argument_1>value_1</argument_1>
    </function_name_1>
    <function_name_2>
        <argument_2>value_2</argument_2>
    </function_name_2>

3.  **Complex Data Types:**
    Do NOT use comma-separated strings for arrays or JSON strings for objects. Use standard XML structures instead.

    * **Arrays:** Use repeated tags for each item in the list.
      <get_weather_for_cities>
          <locations>
              <location>Seoul</location>
              <location>Busan</location>
          </locations>
      </get_weather_for_cities>

    * **Objects:** Use nested tags to represent the object's key-value pairs.
      <create_user>
          <user_details>
              <name>John Doe</name>
              <email>john.doe@example.com</email>
          </user_details>
      </create_user>

### Example

User Query: "Find out the weather in SF and also create a reminder for me to check it again tomorrow."

Your Response:
<get_weather>
    <location>San Francisco, CA</location>
    <unit>celsius</unit>
</get_weather>
<create_reminder>
    <task>Check weather again</task>
    <due_date>tomorrow</due_date>
</create_reminder>`;
  },
});

export {
  gemmaToolMiddleware,
  hermesToolMiddleware,
  xmlToolMiddleware,
  morphExpToolMiddleware,
  createToolMiddleware,
  jsonMixProtocol,
  xmlProtocol,
};
