# Migrate to the Responses API

The [Responses API](/docs/api-reference/responses) is our new API primitive, an evolution of [Chat Completions](/docs/api-reference/chat) which brings added simplicity and powerful agentic primitives to your integrations.

**While Chat Completions remains supported, Responses is recommended for all new projects.**

## About the Responses API

The Responses API is a unified interface for building powerful, agent-like applications. It contains:

- Built-in tools like [web search](/docs/guides/tools-web-search), [file search](/docs/guides/tools-file-search) , [computer use](/docs/guides/tools-computer-use), [code interpreter](/docs/guides/tools-code-interpreter), and [remote MCPs](/docs/guides/tools-remote-mcp).
- Seamless multi-turn interactions that allow you to pass previous responses for higher accuracy reasoning results.
- Native multimodal support for text and images.

## Responses benefits

The Responses API contains several benefits over Chat Completions:

- **Better performance**: Using reasoning models, like GPT-5, with Responses will result in better model intelligence when compared to Chat Completions. Our internal evals reveal a 3% improvement in SWE-bench with same prompt and setup.
- **Agentic by default**: The Responses API is an agentic loop, allowing the model to call multiple tools, like `web_search`, `image_generation`, `file_search`, `code_interpreter`, remote MCP servers, as well as your own custom functions, within the span of one API request.
- **Lower costs**: Results in lower costs due to improved cache utilization (40% to 80% improvement when compared to Chat Completions in internal tests).
- **Stateful context**: Use `store: true` to maintain state from turn to turn, preserving reasoning and tool context from turn-to-turn.
- **Flexible inputs**: Pass a string with input or a list of messages; use instructions for system-level guidance.
- **Encrypted reasoning**: Opt-out of statefulness while still benefiting from advanced reasoning.
- **Future-proof**: Future-proofed for upcoming models.

| Capabilities        | Chat Completions API | Responses API |
| ------------------- | -------------------- | ------------- |
| Text generation     |                      |               |
| Audio               |                      | Coming soon   |
| Vision              |                      |               |
| Structured Outputs  |                      |               |
| Function calling    |                      |               |
| Web search          |                      |               |
| File search         |                      |               |
| Computer use        |                      |               |
| Code interpreter    |                      |               |
| MCP                 |                      |               |
| Image generation    |                      |               |
| Reasoning summaries |                      |               |

### Examples

See how the Responses API compares to the Chat Completions API in specific scenarios.

#### Messages vs. Items

Both APIs make it easy to generate output from our models. The input to, and result of, a call to Chat completions is an array of _Messages_, while the Responses API uses _Items_. An Item is a union of many types, representing the range of possibilities of model actions. A `message` is a type of Item, as is a `function_call` or `function_call_output`. Unlike a Chat Completions Message, where many concerns are glued together into one object, Items are distinct from one another and better represent the basic unit of model context.

Additionally, Chat Completions can return multiple parallel generations as `choices`, using the `n` param. In Responses, we've removed this param, leaving only one generation.

Chat Completions API

```python
from openai import OpenAI
client = OpenAI()

completion = client.chat.completions.create(
  model="gpt-5",
  messages=[
      {
          "role": "user",
          "content": "Write a one-sentence bedtime story about a unicorn."
      }
  ]
)

print(completion.choices[0].message.content)
```

Responses API

```python
from openai import OpenAI
client = OpenAI()

response = client.responses.create(
  model="gpt-5",
  input="Write a one-sentence bedtime story about a unicorn."
)

print(response.output_text)
```

When you get a response back from the Responses API, the fields differ slightly. Instead of a `message`, you receive a typed `response` object with its own `id`. Responses are stored by default. Chat completions are stored by default for new accounts. To disable storage when using either API, set `store: false`.

The objects you recieve back from these APIs will differ slightly. In Chat Completions, you receive an array of `choices`, each containing a `message`. In Responses, you receive an array of Items labled `output`.

Chat Completions API

```json
{
  "id": "chatcmpl-C9EDpkjH60VPPIB86j2zIhiR8kWiC",
  "object": "chat.completion",
  "created": 1756315657,
  "model": "gpt-5-2025-08-07",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Under a blanket of starlight, a sleepy unicorn tiptoed through moonlit meadows, gathering dreams like dew to tuck beneath its silver mane until morning.",
        "refusal": null,
        "annotations": []
      },
      "finish_reason": "stop"
    }
  ],
  ...
}
```

Responses API

```json
{
  "id": "resp_68af4030592c81938ec0a5fbab4a3e9f05438e46b5f69a3b",
  "object": "response",
  "created_at": 1756315696,
  "model": "gpt-5-2025-08-07",
  "output": [
    {
      "id": "rs_68af4030baa48193b0b43b4c2a176a1a05438e46b5f69a3b",
      "type": "reasoning",
      "content": [],
      "summary": []
    },
    {
      "id": "msg_68af40337e58819392e935fb404414d005438e46b5f69a3b",
      "type": "message",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "annotations": [],
          "logprobs": [],
          "text": "Under a quilt of moonlight, a drowsy unicorn wandered through quiet meadows, brushing blossoms with her glowing horn so they sighed soft lullabies that carried every dreamer gently to sleep."
        }
      ],
      "role": "assistant"
    }
  ],
  ...
}
```

### Additional differences

- Responses are stored by default. Chat completions are stored by default for new accounts. To disable storage in either API, set `store: false`.
- [Reasoning](/docs/guides/reasoning) models have a richer experience in the Responses API with [improved tool usage](/docs/guides/reasoning#keeping-reasoning-items-in-context).
- Structured Outputs API shape is different. Instead of `response_format`, use `text.format` in Responses. Learn more in the [Structured Outputs](/docs/guides/structured-outputs) guide.
- The function-calling API shape is different, both for the function config on the request, and function calls sent back in the response. See the full difference in the [function calling guide](/docs/guides/function-calling).
- The Responses SDK has an `output_text` helper, which the Chat Completions SDK does not have.
- In Chat Completions, conversation state must be managed manually. The Responses API has compatibility with the Conversations API for persistent conversations, or the ability to pass a `previous_response_id` to easily chain Responses together.

## Migrating from Chat Completions

### 1\. Update generation endpoints

Start by updating your generation endpoints from `post /v1/chat/completions` to `post /v1/responses`.

If you are not using functions or multimodal inputs, then you're done! Simple message inputs are compatible from one API to the other:

Web search tool

```bash
INPUT='[
  { "role": "system", "content": "You are a helpful assistant." },
  { "role": "user", "content": "Hello!" }
]'

curl -s https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d "{
    \"model\": \"gpt-5\",
    \"messages\": $INPUT
  }"

curl -s https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d "{
    \"model\": \"gpt-5\",
    \"input\": $INPUT
  }"
```

```javascript
const context = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Hello!" },
];

const completion = await client.chat.completions.create({
  model: "gpt-5",
  messages: messages,
});

const response = await client.responses.create({
  model: "gpt-5",
  input: context,
});
```

```python
context = [
  { "role": "system", "content": "You are a helpful assistant." },
  { "role": "user", "content": "Hello!" }
]

completion = client.chat.completions.create(
  model="gpt-5",
  messages=messages
)

response = client.responses.create(
  model="gpt-5",
  input=context
)
```

Chat Completions

With Chat Completions, you need to create an array of messages that specify different roles and content for each role.

Generate text from a model

```javascript
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const completion = await client.chat.completions.create({
  model: "gpt-5",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
  ],
});
console.log(completion.choices[0].message.content);
```

```python
from openai import OpenAI
client = OpenAI()

completion = client.chat.completions.create(
    model="gpt-5",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
    ]
)
print(completion.choices[0].message.content)
```

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
      "model": "gpt-5",
      "messages": [
          {"role": "system", "content": "You are a helpful assistant."},
          {"role": "user", "content": "Hello!"}
      ]
  }'
```

Responses

With Responses, you can separate instructions and input at the top-level. The API shape is similar to Chat Completions but has cleaner semantics.

Generate text from a model

```javascript
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await client.responses.create({
  model: "gpt-5",
  instructions: "You are a helpful assistant.",
  input: "Hello!",
});

console.log(response.output_text);
```

```python
from openai import OpenAI
client = OpenAI()

response = client.responses.create(
    model="gpt-5",
    instructions="You are a helpful assistant.",
    input="Hello!"
)
print(response.output_text)
```

```bash
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
      "model": "gpt-5",
      "instructions": "You are a helpful assistant.",
      "input": "Hello!"
  }'
```

### 2\. Update item definitions

Chat Completions

With Chat Completions, you need to create an array of messages that specify different roles and content for each role.

Generate text from a model

```javascript
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const completion = await client.chat.completions.create({
  model: "gpt-5",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
  ],
});
console.log(completion.choices[0].message.content);
```

```python
from openai import OpenAI
client = OpenAI()

completion = client.chat.completions.create(
    model="gpt-5",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
    ]
)
print(completion.choices[0].message.content)
```

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
      "model": "gpt-5",
      "messages": [
          {"role": "system", "content": "You are a helpful assistant."},
          {"role": "user", "content": "Hello!"}
      ]
  }'
```

Responses

With Responses, you can separate instructions and input at the top-level. The API shape is similar to Chat Completions but has cleaner semantics.

Generate text from a model

```javascript
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await client.responses.create({
  model: "gpt-5",
  instructions: "You are a helpful assistant.",
  input: "Hello!",
});

console.log(response.output_text);
```

```python
from openai import OpenAI
client = OpenAI()

response = client.responses.create(
    model="gpt-5",
    instructions="You are a helpful assistant.",
    input="Hello!"
)
print(response.output_text)
```

```bash
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
      "model": "gpt-5",
      "instructions": "You are a helpful assistant.",
      "input": "Hello!"
  }'
```

### 3\. Update multi-turn conversations

If you have multi-turn conversations in your application, update your context logic.

Chat Completions

In Chat Completions, you have to store and manage context yourself.

Multi-turn conversation

```javascript
let messages = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "What is the capital of France?" },
];
const res1 = await client.chat.completions.create({
  model: "gpt-5",
  messages,
});

messages = messages.concat([res1.choices[0].message]);
messages.push({ role: "user", content: "And its population?" });

const res2 = await client.chat.completions.create({
  model: "gpt-5",
  messages,
});
```

```python
messages = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is the capital of France?"}
]
res1 = client.chat.completions.create(model="gpt-5", messages=messages)

messages += [res1.choices[0].message]
messages += [{"role": "user", "content": "And its population?"}]

res2 = client.chat.completions.create(model="gpt-5", messages=messages)
```

Responses

With responses, the pattern is similar, you can pass outputs from one response to the input of another.

Multi-turn conversation

```python
context = [
    { "role": "role", "content": "What is the capital of France?" }
]
res1 = client.responses.create(
    model="gpt-5",
    input=context,
)

// Append the first response’s output to context
context += res1.output

// Add the next user message
context += [
    { "role": "role", "content": "And it's population?" }
]

res2 = client.responses.create(
    model="gpt-5",
    input=context,
)
```

```javascript
let context = [{ role: "role", content: "What is the capital of France?" }];

const res1 = await client.responses.create({
  model: "gpt-5",
  input: context,
});

// Append the first response’s output to context
context = context.concat(res1.output);

// Add the next user message
context.push({ role: "role", content: "And its population?" });

const res2 = await client.responses.create({
  model: "gpt-5",
  input: context,
});
```

As a simplification, we've also built a way to simply reference inputs and outputs from a previous response by passing its id. You can use \`previous_response_id\` to form chains of responses that build upon one other or create forks in a history.

Multi-turn conversation

```javascript
const res1 = await client.responses.create({
  model: "gpt-5",
  input: "What is the capital of France?",
  store: true,
});

const res2 = await client.responses.create({
  model: "gpt-5",
  input: "And its population?",
  previous_response_id: res1.id,
  store: true,
});
```

```python
res1 = client.responses.create(
    model="gpt-5",
    input="What is the capital of France?",
    store=True
)

res2 = client.responses.create(
    model="gpt-5",
    input="And its population?",
    previous_response_id=res1.id,
    store=True
)
```

### 4\. Decide when to use statefulness

Some organizations—such as those with Zero Data Retention (ZDR) requirements—cannot use the Responses API in a stateful way due to compliance or data retention policies. To support these cases, OpenAI offers encrypted reasoning items, allowing you to keep your workflow stateless while still benefiting from reasoning items.

To disable statefulness, but still take advantage of reasoning:

- set `store: false` in the [store field](/docs/api-reference/responses/create#responses_create-store)
- add `["reasoning.encrypted_content"]` to the [include field](/docs/api-reference/responses/create#responses_create-include)

The API will then return an encrypted version of the reasoning tokens, which you can pass back in future requests just like regular reasoning items. For ZDR organizations, OpenAI enforces store=false automatically. When a request includes encrypted_content, it is decrypted in-memory (never written to disk), used for generating the next response, and then securely discarded. Any new reasoning tokens are immediately encrypted and returned to you, ensuring no intermediate state is ever persisted.

### 5\. Update function definitions

There are two minor, but notable, differences in how functions are defined between Chat Completions and Responses.

1.  In Chat Completions, functions are defined using externally tagged polymorphism, whereas in Responses, they are internally-tagged.
2.  In Chat Completions, functions are non-strict by default, whereas in the Responses API, functions _are_ strict by default.

The Responses API function example on the right is functionally equivalent to the Chat Completions example on the left.

Chat Completions API

```javascript
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Determine weather in my location",
    "strict": true,
    "parameters": {
      "type": "object",
      "properties": {
        "location": {
          "type": "string",
        },
      },
      "additionalProperties": false,
      "required": [
        "location",
        "unit"
      ]
    }
  }
}
```

Responses API

```javascript
{
  "type": "function",
  "name": "get_weather",
  "description": "Determine weather in my location",
  "parameters": {
    "type": "object",
    "properties": {
      "location": {
        "type": "string",
      },
    },
    "additionalProperties": false,
    "required": [
      "location",
      "unit"
    ]
  }
}
```

#### Follow function-calling best practices

In Responses, tool calls and their outputs are two distinct types of Items that are correlated using a `call_id`. See the [tool calling docs](/docs/guides/function-calling#function-tool-example) for more detail on how function calling works in Responses.

### 6\. Update Structured Outputs definition

In the Responses API, defining structured outputs have moved from `response_format` to `text.format`:

Chat Completions

Structured Outputs

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
  "model": "gpt-5",
  "messages": [
    {
      "role": "user",
      "content": "Jane, 54 years old",
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "person",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1
          },
          "age": {
            "type": "number",
            "minimum": 0,
            "maximum": 130
          }
        },
        "required": [
          "name",
          "age"
        ],
        "additionalProperties": false
      }
    }
  },
  "verbosity": "medium",
  "reasoning_effort": "medium"
}'
```

```python
from openai import OpenAI
client = OpenAI()

response = client.chat.completions.create(
  model="gpt-5",
  messages=[
    {
      "role": "user",
      "content": "Jane, 54 years old",
    }
  ],
  response_format={
    "type": "json_schema",
    "json_schema": {
      "name": "person",
      "strict": True,
      "schema": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1
          },
          "age": {
            "type": "number",
            "minimum": 0,
            "maximum": 130
          }
        },
        "required": [
          "name",
          "age"
        ],
        "additionalProperties": False
      }
    }
  },
  verbosity="medium",
  reasoning_effort="medium"
)
```

```javascript
const completion = await openai.chat.completions.create({
  model: "gpt-5",
  messages: [
    {
      role: "user",
      content: "Jane, 54 years old",
    },
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "person",
      strict: true,
      schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
          },
          age: {
            type: "number",
            minimum: 0,
            maximum: 130,
          },
        },
        required: [name, age],
        additionalProperties: false,
      },
    },
  },
  verbosity: "medium",
  reasoning_effort: "medium",
});
```

Responses

Structured Outputs

```bash
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
  "model": "gpt-5",
  "input": "Jane, 54 years old",
  "text": {
    "format": {
      "type": "json_schema",
      "name": "person",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1
          },
          "age": {
            "type": "number",
            "minimum": 0,
            "maximum": 130
          }
        },
        "required": [
          "name",
          "age"
        ],
        "additionalProperties": false
      }
    }
  }
}'
```

```python
response = client.responses.create(
  model="gpt-5",
  input="Jane, 54 years old",
  text={
    "format": {
      "type": "json_schema",
      "name": "person",
      "strict": True,
      "schema": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1
          },
          "age": {
            "type": "number",
            "minimum": 0,
            "maximum": 130
          }
        },
        "required": [
          "name",
          "age"
        ],
        "additionalProperties": False
      }
    }
  }
)
```

```javascript
const response = await openai.responses.create({
  model: "gpt-5",
  input: "Jane, 54 years old",
  text: {
    format: {
      type: "json_schema",
      name: "person",
      strict: true,
      schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
          },
          age: {
            type: "number",
            minimum: 0,
            maximum: 130,
          },
        },
        required: [name, age],
        additionalProperties: false,
      },
    },
  },
});
```

### 7\. Upgrade to native tools

If your application has use cases that would benefit from OpenAI's native [tools](/docs/guides/tools), you can update your tool calls to use OpenAI's tools out of the box.

Chat Completions

With Chat Completions, you cannot use OpenAI's tools natively and have to write your own.

Web search tool

```javascript
async function web_search(query) {
  const fetch = (await import("node-fetch")).default;
  const res = await fetch(`https://api.example.com/search?q=${query}`);
  const data = await res.json();
  return data.results;
}

const completion = await client.chat.completions.create({
  model: "gpt-5",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Who is the current president of France?" },
  ],
  functions: [
    {
      name: "web_search",
      description: "Search the web for information",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
});
```

```python
import requests

def web_search(query):
    r = requests.get(f"https://api.example.com/search?q={query}")
    return r.json().get("results", [])

completion = client.chat.completions.create(
    model="gpt-5",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Who is the current president of France?"}
    ],
    functions=[
        {
            "name": "web_search",
            "description": "Search the web for information",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"]
            }
        }
    ]
)
```

```bash
curl https://api.example.com/search \
  -G \
  --data-urlencode "q=your+search+term" \
  --data-urlencode "key=$SEARCH_API_KEY"
```

Responses

With Responses, you can simply specify the tools that you are interested in.

Web search tool

```javascript
const answer = await client.responses.create({
  model: "gpt-5",
  input: "Who is the current president of France?",
  tools: [{ type: "web_search" }],
});

console.log(answer.output_text);
```

```python
answer = client.responses.create(
    model="gpt-5",
    input="Who is the current president of France?",
    tools=[{"type": "web_search_preview"}]
)

print(answer.output_text)
```

```bash
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-5",
    "input": "Who is the current president of France?",
    "tools": [{"type": "web_search"}]
  }'
```

## Incremental migration

The Responses API is a superset of the Chat Completions API. The Chat Completions API will also continue to be supported. As such, you can incrementally adopt the Responses API if desired. You can migrate user flows who would benefit from improved reasoning models to the Responses API while keeping other flows on the Chat Completions API until you're ready for a full migration.

As a best practice, we encourage all users to migrate to the Responses API to take advantage of the latest features and improvements from OpenAI.

## Assistants API

Based on developer feedback from the [Assistants API](/docs/api-reference/assistants) beta, we've incorporated key improvements into the Responses API to make it more flexible, faster, and easier to use. The Responses API represents the future direction for building agents on OpenAI.

We now have Assistant-like and Thread-like objects in the Responses API. Learn more in the [migration guide](/docs/guides/assistants/migration). As of August 26th, 2025, we're deprecating the Assistants API, with a sunset date of August 26, 2026.

<div class="section"><div class="anchor-heading-wrapper"><h2 id="responses/create" class="anchor-heading" data-name="responses/create"><div class="flex flex-row items-center gap-3"><span class="flex items-center gap-3">Create a model response</span></div><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" class="anchor-heading-icon" role="presentation"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></h2></div><div class="endpoint"><div class="section-left"><div><span class="endpoint-text"><span class="endpoint-method endpoint-method-post">post</span>&nbsp;<span class="endpoint-path">https://api.openai.com/v1/responses</span></span></div><div class="docs-markdown-content endpoint-summary"><p>Creates a model response. Provide <a href="/docs/guides/text" class="kZ98Q" data-underline="">text</a> or
<a href="/docs/guides/images" class="kZ98Q" data-underline="">image</a> inputs to generate <a href="/docs/guides/text" class="kZ98Q" data-underline="">text</a>
or <a href="/docs/guides/structured-outputs" class="kZ98Q" data-underline="">JSON</a> outputs. Have the model call
your own <a href="/docs/guides/function-calling" class="kZ98Q" data-underline="">custom code</a> or use built-in
<a href="/docs/guides/tools" class="kZ98Q" data-underline="">tools</a> like <a href="/docs/guides/tools-web-search" class="kZ98Q" data-underline="">web search</a>
or <a href="/docs/guides/tools-file-search" class="kZ98Q" data-underline="">file search</a> to use your own data
as input for the model's response.</p></div><div class="param-section"><h4>Request body</h4><div class="param-table" id="responses_create__table"><div class="param-row" id="responses_create-background" data-normalized-id="responses-create-background"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-background" data-anchor="responses_create-background" id="responses_create-background-anchor" data-normalized-id="responses-create-background-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">background</div><div class="param-type"><div class="docs-markdown-content"><p>boolean</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to false</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Whether to run the model response in the background.
<a href="/docs/guides/background" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div></div><div class="param-row" id="responses_create-conversation" data-normalized-id="responses-create-conversation"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-conversation" data-anchor="responses_create-conversation" id="responses_create-conversation-anchor" data-normalized-id="responses-create-conversation-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">conversation</div><div class="param-type"><div class="docs-markdown-content"><p>string or object</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to null</div></div><div class="param-desc"><div class="docs-markdown-content"><p>The conversation that this response belongs to. Items from this conversation are prepended to <code>input_items</code> for this response request.
Input items and output items from this response are automatically added to this conversation after this response completes.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses_create-conversation_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show possible types</span></button></div><div class="param-row" id="responses_create-include" data-normalized-id="responses-create-include"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-include" data-anchor="responses_create-include" id="responses_create-include-anchor" data-normalized-id="responses-create-include-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">include</div><div class="param-type"><div class="docs-markdown-content"><p>array</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Specify additional output data to include in the model response. Currently supported values are:</p>
<ul>
<li><code>web_search_call.action.sources</code>: Include the sources of the web search tool call.</li>
<li><code>code_interpreter_call.outputs</code>: Includes the outputs of python code execution in code interpreter tool call items.</li>
<li><code>computer_call_output.output.image_url</code>: Include image urls from the computer call output.</li>
<li><code>file_search_call.results</code>: Include the search results of the file search tool call.</li>
<li><code>message.input_image.image_url</code>: Include image urls from the input message.</li>
<li><code>message.output_text.logprobs</code>: Include logprobs with assistant messages.</li>
<li><code>reasoning.encrypted_content</code>: Includes an encrypted version of reasoning tokens in reasoning item outputs. This enables reasoning items to be used in multi-turn conversations when using the Responses API statelessly (like when the <code>store</code> parameter is set to <code>false</code>, or when an organization is enrolled in the zero data retention program).</li>
</ul></div></div></div><div class="param-row" id="responses_create-input" data-normalized-id="responses-create-input"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-input" data-anchor="responses_create-input" id="responses_create-input-anchor" data-normalized-id="responses-create-input-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">input</div><div class="param-type"><div class="docs-markdown-content"><p>string or array</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Text, image, or file inputs to the model, used to generate a response.</p>
<p>Learn more:</p>
<ul>
<li><a href="/docs/guides/text" class="kZ98Q" data-underline="">Text inputs and outputs</a></li>
<li><a href="/docs/guides/images" class="kZ98Q" data-underline="">Image inputs</a></li>
<li><a href="/docs/guides/pdf-files" class="kZ98Q" data-underline="">File inputs</a></li>
<li><a href="/docs/guides/conversation-state" class="kZ98Q" data-underline="">Conversation state</a></li>
<li><a href="/docs/guides/function-calling" class="kZ98Q" data-underline="">Function calling</a></li>
</ul></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses_create-input_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show possible types</span></button></div><div class="param-row" id="responses_create-instructions" data-normalized-id="responses-create-instructions"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-instructions" data-anchor="responses_create-instructions" id="responses_create-instructions-anchor" data-normalized-id="responses-create-instructions-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">instructions</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>A system (or developer) message inserted into the model's context.</p>
<p>When using along with <code>previous_response_id</code>, the instructions from a previous
response will not be carried over to the next response. This makes it simple
to swap out system (or developer) messages in new responses.</p></div></div></div><div class="param-row" id="responses_create-max_output_tokens" data-normalized-id="responses-create-max-output-tokens"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-max_output_tokens" data-anchor="responses_create-max_output_tokens" id="responses_create-max_output_tokens-anchor" data-normalized-id="responses-create-max-output-tokens-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">max_output_tokens</div><div class="param-type"><div class="docs-markdown-content"><p>integer</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>An upper bound for the number of tokens that can be generated for a response, including visible output tokens and <a href="/docs/guides/reasoning" class="kZ98Q" data-underline="">reasoning tokens</a>.</p></div></div></div><div class="param-row" id="responses_create-max_tool_calls" data-normalized-id="responses-create-max-tool-calls"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-max_tool_calls" data-anchor="responses_create-max_tool_calls" id="responses_create-max_tool_calls-anchor" data-normalized-id="responses-create-max-tool-calls-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">max_tool_calls</div><div class="param-type"><div class="docs-markdown-content"><p>integer</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>The maximum number of total calls to built-in tools that can be processed in a response. This maximum number applies across all built-in tool calls, not per individual tool. Any further attempts to call a tool by the model will be ignored.</p></div></div></div><div class="param-row" id="responses_create-metadata" data-normalized-id="responses-create-metadata"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-metadata" data-anchor="responses_create-metadata" id="responses_create-metadata-anchor" data-normalized-id="responses-create-metadata-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">metadata</div><div class="param-type"><div class="docs-markdown-content"><p>map</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Set of 16 key-value pairs that can be attached to an object. This can be
useful for storing additional information about the object in a structured
format, and querying for objects via API or the dashboard.</p>
<p>Keys are strings with a maximum length of 64 characters. Values are strings
with a maximum length of 512 characters.</p></div></div></div><div class="param-row" id="responses_create-model" data-normalized-id="responses-create-model"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-model" data-anchor="responses_create-model" id="responses_create-model-anchor" data-normalized-id="responses-create-model-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">model</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Model ID used to generate the response, like <code>gpt-4o</code> or <code>o3</code>. OpenAI
offers a wide range of models with different capabilities, performance
characteristics, and price points. Refer to the <a href="/docs/models" class="kZ98Q" data-underline="">model guide</a>
to browse and compare available models.</p></div></div></div><div class="param-row" id="responses_create-parallel_tool_calls" data-normalized-id="responses-create-parallel-tool-calls"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-parallel_tool_calls" data-anchor="responses_create-parallel_tool_calls" id="responses_create-parallel_tool_calls-anchor" data-normalized-id="responses-create-parallel-tool-calls-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">parallel_tool_calls</div><div class="param-type"><div class="docs-markdown-content"><p>boolean</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to true</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Whether to allow the model to run tool calls in parallel.</p></div></div></div><div class="param-row" id="responses_create-previous_response_id" data-normalized-id="responses-create-previous-response-id"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-previous_response_id" data-anchor="responses_create-previous_response_id" id="responses_create-previous_response_id-anchor" data-normalized-id="responses-create-previous-response-id-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">previous_response_id</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>The unique ID of the previous response to the model. Use this to
create multi-turn conversations. Learn more about
<a href="/docs/guides/conversation-state" class="kZ98Q" data-underline="">conversation state</a>. Cannot be used in conjunction with <code>conversation</code>.</p></div></div></div><div class="param-row" id="responses_create-prompt" data-normalized-id="responses-create-prompt"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-prompt" data-anchor="responses_create-prompt" id="responses_create-prompt-anchor" data-normalized-id="responses-create-prompt-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">prompt</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Reference to a prompt template and its variables.
<a href="/docs/guides/text?api-mode=responses#reusable-prompts" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses_create-prompt_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses_create-prompt_cache_key" data-normalized-id="responses-create-prompt-cache-key"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-prompt_cache_key" data-anchor="responses_create-prompt_cache_key" id="responses_create-prompt_cache_key-anchor" data-normalized-id="responses-create-prompt-cache-key-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">prompt_cache_key</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Used by OpenAI to cache responses for similar requests to optimize your cache hit rates. Replaces the <code>user</code> field. <a href="/docs/guides/prompt-caching" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div></div><div class="param-row" id="responses_create-reasoning" data-normalized-id="responses-create-reasoning"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-reasoning" data-anchor="responses_create-reasoning" id="responses_create-reasoning-anchor" data-normalized-id="responses-create-reasoning-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">reasoning</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p><strong>gpt-5 and o-series models only</strong></p>
<p>Configuration options for
<a target="_blank" rel="noopener noreferrer" href="https://platform.openai.com/docs/guides/reasoning" class="kZ98Q" data-underline="">reasoning models</a>.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses_create-reasoning_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses_create-safety_identifier" data-normalized-id="responses-create-safety-identifier"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-safety_identifier" data-anchor="responses_create-safety_identifier" id="responses_create-safety_identifier-anchor" data-normalized-id="responses-create-safety-identifier-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">safety_identifier</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>A stable identifier used to help detect users of your application that may be violating OpenAI's usage policies.
The IDs should be a string that uniquely identifies each user. We recommend hashing their username or email address, in order to avoid sending us any identifying information. <a href="/docs/guides/safety-best-practices#safety-identifiers" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div></div><div class="param-row" id="responses_create-service_tier" data-normalized-id="responses-create-service-tier"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-service_tier" data-anchor="responses_create-service_tier" id="responses_create-service_tier-anchor" data-normalized-id="responses-create-service-tier-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">service_tier</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to auto</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Specifies the processing type used for serving the request.</p>
<ul>
<li>If set to 'auto', then the request will be processed with the service tier configured in the Project settings. Unless otherwise configured, the Project will use 'default'.</li>
<li>If set to 'default', then the request will be processed with the standard pricing and performance for the selected model.</li>
<li>If set to '<a href="/docs/guides/flex-processing" class="kZ98Q" data-underline="">flex</a>' or '<a target="_blank" rel="noopener noreferrer" href="https://openai.com/api-priority-processing/" class="kZ98Q" data-underline="">priority</a>', then the request will be processed with the corresponding service tier.</li>
<li>When not set, the default behavior is 'auto'.</li>
</ul>
<p>When the <code>service_tier</code> parameter is set, the response body will include the <code>service_tier</code> value based on the processing mode actually used to serve the request. This response value may be different from the value set in the parameter.</p></div></div></div><div class="param-row" id="responses_create-store" data-normalized-id="responses-create-store"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-store" data-anchor="responses_create-store" id="responses_create-store-anchor" data-normalized-id="responses-create-store-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">store</div><div class="param-type"><div class="docs-markdown-content"><p>boolean</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to true</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Whether to store the generated model response for later retrieval via
API.</p></div></div></div><div class="param-row" id="responses_create-stream" data-normalized-id="responses-create-stream"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-stream" data-anchor="responses_create-stream" id="responses_create-stream-anchor" data-normalized-id="responses-create-stream-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">stream</div><div class="param-type"><div class="docs-markdown-content"><p>boolean</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to false</div></div><div class="param-desc"><div class="docs-markdown-content"><p>If set to true, the model response data will be streamed to the client
as it is generated using <a target="_blank" rel="noopener noreferrer" href="https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format" class="kZ98Q" data-underline="">server-sent events</a>.
See the <a href="/docs/api-reference/responses-streaming" class="kZ98Q" data-underline="">Streaming section below</a>
for more information.</p></div></div></div><div class="param-row" id="responses_create-stream_options" data-normalized-id="responses-create-stream-options"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-stream_options" data-anchor="responses_create-stream_options" id="responses_create-stream_options-anchor" data-normalized-id="responses-create-stream-options-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">stream_options</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to null</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Options for streaming responses. Only set this when you set <code>stream: true</code>.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses_create-stream_options_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses_create-temperature" data-normalized-id="responses-create-temperature"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-temperature" data-anchor="responses_create-temperature" id="responses_create-temperature-anchor" data-normalized-id="responses-create-temperature-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">temperature</div><div class="param-type"><div class="docs-markdown-content"><p>number</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to 1</div></div><div class="param-desc"><div class="docs-markdown-content"><p>What sampling temperature to use, between 0 and 2. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.
We generally recommend altering this or <code>top_p</code> but not both.</p></div></div></div><div class="param-row" id="responses_create-text" data-normalized-id="responses-create-text"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-text" data-anchor="responses_create-text" id="responses_create-text-anchor" data-normalized-id="responses-create-text-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">text</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>Configuration options for a text response from the model. Can be plain
text or structured JSON data. Learn more:</p>
<ul>
<li><a href="/docs/guides/text" class="kZ98Q" data-underline="">Text inputs and outputs</a></li>
<li><a href="/docs/guides/structured-outputs" class="kZ98Q" data-underline="">Structured Outputs</a></li>
</ul></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses_create-text_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses_create-tool_choice" data-normalized-id="responses-create-tool-choice"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-tool_choice" data-anchor="responses_create-tool_choice" id="responses_create-tool_choice-anchor" data-normalized-id="responses-create-tool-choice-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">tool_choice</div><div class="param-type"><div class="docs-markdown-content"><p>string or object</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>How the model should select which tool (or tools) to use when generating
a response. See the <code>tools</code> parameter to see how to specify which tools
the model can call.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses_create-tool_choice_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show possible types</span></button></div><div class="param-row" id="responses_create-tools" data-normalized-id="responses-create-tools"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-tools" data-anchor="responses_create-tools" id="responses_create-tools-anchor" data-normalized-id="responses-create-tools-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">tools</div><div class="param-type"><div class="docs-markdown-content"><p>array</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>An array of tools the model may call while generating a response. You
can specify which tool to use by setting the <code>tool_choice</code> parameter.</p>
<p>We support the following categories of tools:</p>
<ul>
<li><strong>Built-in tools</strong>: Tools that are provided by OpenAI that extend the
model's capabilities, like <a href="/docs/guides/tools-web-search" class="kZ98Q" data-underline="">web search</a>
or <a href="/docs/guides/tools-file-search" class="kZ98Q" data-underline="">file search</a>. Learn more about
<a href="/docs/guides/tools" class="kZ98Q" data-underline="">built-in tools</a>.</li>
<li><strong>MCP Tools</strong>: Integrations with third-party systems via custom MCP servers
or predefined connectors such as Google Drive and SharePoint. Learn more about
<a href="/docs/guides/tools-connectors-mcp" class="kZ98Q" data-underline="">MCP Tools</a>.</li>
<li><strong>Function calls (custom tools)</strong>: Functions that are defined by you,
enabling the model to call your own code with strongly typed arguments
and outputs. Learn more about
<a href="/docs/guides/function-calling" class="kZ98Q" data-underline="">function calling</a>. You can also use
custom tools to call your own code.</li>
</ul></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses_create-tools_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show possible types</span></button></div><div class="param-row" id="responses_create-top_logprobs" data-normalized-id="responses-create-top-logprobs"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-top_logprobs" data-anchor="responses_create-top_logprobs" id="responses_create-top_logprobs-anchor" data-normalized-id="responses-create-top-logprobs-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">top_logprobs</div><div class="param-type"><div class="docs-markdown-content"><p>integer</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>An integer between 0 and 20 specifying the number of most likely tokens to
return at each token position, each with an associated log probability.</p></div></div></div><div class="param-row" id="responses_create-top_p" data-normalized-id="responses-create-top-p"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-top_p" data-anchor="responses_create-top_p" id="responses_create-top_p-anchor" data-normalized-id="responses-create-top-p-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">top_p</div><div class="param-type"><div class="docs-markdown-content"><p>number</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to 1</div></div><div class="param-desc"><div class="docs-markdown-content"><p>An alternative to sampling with temperature, called nucleus sampling,
where the model considers the results of the tokens with top_p probability
mass. So 0.1 means only the tokens comprising the top 10% probability mass
are considered.</p>
<p>We generally recommend altering this or <code>temperature</code> but not both.</p></div></div></div><div class="param-row" id="responses_create-truncation" data-normalized-id="responses-create-truncation"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-truncation" data-anchor="responses_create-truncation" id="responses_create-truncation-anchor" data-normalized-id="responses-create-truncation-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">truncation</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div><div class="param-optl">Optional</div><div class="param-default">Defaults to disabled</div></div><div class="param-desc"><div class="docs-markdown-content"><p>The truncation strategy to use for the model response.</p>
<ul>
<li><code>auto</code>: If the input to this Response exceeds
the model's context window size, the model will truncate the
response to fit the context window by dropping items from the beginning of the conversation.</li>
<li><code>disabled</code> (default): If the input size will exceed the context window
size for a model, the request will fail with a 400 error.</li>
</ul></div></div></div><div class="param-row" id="responses_create-user" data-normalized-id="responses-create-user"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses_create-user" data-anchor="responses_create-user" id="responses_create-user-anchor" data-normalized-id="responses-create-user-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">user</div><div class="param-depr">Deprecated</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div><div class="param-optl">Optional</div></div><div class="param-desc"><div class="docs-markdown-content"><p>This field is being replaced by <code>safety_identifier</code> and <code>prompt_cache_key</code>. Use <code>prompt_cache_key</code> instead to maintain caching optimizations.
A stable identifier for your end-users.
Used to boost cache hit rates by better bucketing similar requests and  to help OpenAI detect and prevent abuse. <a href="/docs/guides/safety-best-practices#safety-identifiers" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div></div></div></div><div class="param-section"><h4>Returns</h4><div class="param-table"><div class="param-row"><div class="docs-markdown-content"><p>Returns a <a href="/docs/api-reference/responses/object" class="kZ98Q" data-underline="">Response</a> object.</p></div></div></div></div></div><div class="section-right"><div class="section-right-inner section-right-inner-with-examples"><div class="mb-3 md:mb-0 flex"><div role="group" dir="ltr" class="F5Sy7" data-size="md" aria-label="Code example" tabindex="0" style="outline: none;"><div class="V5HTp" style="width: 87px; transform: translateX(2px); transition: width 300ms var(--cubic-enter), transform 300ms var(--cubic-enter);"></div><button type="button" data-state="on" role="radio" aria-checked="true" class="VewWL" tabindex="-1" data-radix-collection-item=""><span class="relative">Text input</span></button><button type="button" data-state="off" role="radio" aria-checked="false" class="VewWL" tabindex="-1" data-radix-collection-item=""><span class="relative">Image input</span></button><button type="button" data-state="off" role="radio" aria-checked="false" class="VewWL" tabindex="-1" data-radix-collection-item=""><span class="relative">File input</span></button><button type="button" data-state="off" role="radio" aria-checked="false" class="VewWL" tabindex="-1" data-radix-collection-item=""><span class="relative">Web search</span></button><button type="button" data-state="off" role="radio" aria-checked="false" class="VewWL" tabindex="-1" data-radix-collection-item=""><span class="relative">File search</span></button><button type="button" data-state="off" role="radio" aria-checked="false" class="VewWL" tabindex="-1" data-radix-collection-item=""><span class="relative">Streaming</span></button><button type="button" data-state="off" role="radio" aria-checked="false" class="VewWL" tabindex="-1" data-radix-collection-item=""><span class="relative">Functions</span></button><button type="button" data-state="off" role="radio" aria-checked="false" class="VewWL" tabindex="-1" data-radix-collection-item=""><span class="relative">Reasoning</span></button></div></div><div class="code-sample dark-mode"><div class="code-sample-header"><div class="code-sample-title body-small">Example request</div><div class="exclude-from-copy"><span class="fsluc" role="button" tabindex="0" data-variant="ghost" data-size="sm" data-selected="true" aria-disabled="false" id="select-trigger-:rs:" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="radix-:ru:" data-state="closed"><span class="ktL9G">curl</span><div class="FJZOe"><svg width="1em" height="1em" viewBox="0 0 10 16" fill="currentColor" class="ygzs6"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.34151 0.747423C4.71854 0.417526 5.28149 0.417526 5.65852 0.747423L9.65852 4.24742C10.0742 4.61111 10.1163 5.24287 9.75259 5.6585C9.38891 6.07414 8.75715 6.11626 8.34151 5.75258L5.00001 2.82877L1.65852 5.75258C1.24288 6.11626 0.61112 6.07414 0.247438 5.6585C-0.116244 5.24287 -0.0741267 4.61111 0.34151 4.24742L4.34151 0.747423ZM0.246065 10.3578C0.608879 9.94139 1.24055 9.89795 1.65695 10.2608L5.00001 13.1737L8.34308 10.2608C8.75948 9.89795 9.39115 9.94139 9.75396 10.3578C10.1168 10.7742 10.0733 11.4058 9.65695 11.7687L5.65695 15.2539C5.28043 15.582 4.7196 15.582 4.34308 15.2539L0.343082 11.7687C-0.0733128 11.4058 -0.116749 10.7742 0.246065 10.3578Z"></path></svg></div></span></div><button type="button" class="lkCln" data-color="primary" data-variant="ghost" data-size="sm" data-gutter-size="xs" data-icon-size="sm"><span class="NBPKZ"><span class="block relative w-[var(--button-icon-size)] h-[var(--button-icon-size)]" data-transition-position="absolute" style="--tg-will-change: transform, opacity; --tg-enter-opacity: 1; --tg-enter-transform: scale(1); --tg-enter-filter: none; --tg-enter-duration: 300ms; --tg-enter-delay: 150ms; --tg-enter-timing-function: var(--cubic-enter); --tg-exit-opacity: 0; --tg-exit-transform: scale(0.6); --tg-exit-filter: none; --tg-exit-duration: 150ms; --tg-exit-delay: 0ms; --tg-exit-timing-function: var(--cubic-exit); --tg-initial-opacity: 0; --tg-initial-transform: scale(0.6); --tg-initial-filter: none;"><span class="_4jUWi pdMy8"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M12.7587 2H16.2413C17.0463 1.99999 17.7106 1.99998 18.2518 2.04419C18.8139 2.09012 19.3306 2.18868 19.816 2.43597C20.5686 2.81947 21.1805 3.43139 21.564 4.18404C21.8113 4.66937 21.9099 5.18608 21.9558 5.74817C22 6.28936 22 6.95372 22 7.75868V11.2413C22 12.0463 22 12.7106 21.9558 13.2518C21.9099 13.8139 21.8113 14.3306 21.564 14.816C21.1805 15.5686 20.5686 16.1805 19.816 16.564C19.3306 16.8113 18.8139 16.9099 18.2518 16.9558C17.8906 16.9853 17.4745 16.9951 16.9984 16.9984C16.9951 17.4745 16.9853 17.8906 16.9558 18.2518C16.9099 18.8139 16.8113 19.3306 16.564 19.816C16.1805 20.5686 15.5686 21.1805 14.816 21.564C14.3306 21.8113 13.8139 21.9099 13.2518 21.9558C12.7106 22 12.0463 22 11.2413 22H7.75868C6.95372 22 6.28936 22 5.74818 21.9558C5.18608 21.9099 4.66937 21.8113 4.18404 21.564C3.43139 21.1805 2.81947 20.5686 2.43597 19.816C2.18868 19.3306 2.09012 18.8139 2.04419 18.2518C1.99998 17.7106 1.99999 17.0463 2 16.2413V12.7587C1.99999 11.9537 1.99998 11.2894 2.04419 10.7482C2.09012 10.1861 2.18868 9.66937 2.43597 9.18404C2.81947 8.43139 3.43139 7.81947 4.18404 7.43598C4.66937 7.18868 5.18608 7.09012 5.74817 7.04419C6.10939 7.01468 6.52548 7.00487 7.00162 7.00162C7.00487 6.52548 7.01468 6.10939 7.04419 5.74817C7.09012 5.18608 7.18868 4.66937 7.43598 4.18404C7.81947 3.43139 8.43139 2.81947 9.18404 2.43597C9.66937 2.18868 10.1861 2.09012 10.7482 2.04419C11.2894 1.99998 11.9537 1.99999 12.7587 2ZM9.00176 7L11.2413 7C12.0463 6.99999 12.7106 6.99998 13.2518 7.04419C13.8139 7.09012 14.3306 7.18868 14.816 7.43598C15.5686 7.81947 16.1805 8.43139 16.564 9.18404C16.8113 9.66937 16.9099 10.1861 16.9558 10.7482C17 11.2894 17 11.9537 17 12.7587V14.9982C17.4455 14.9951 17.7954 14.9864 18.089 14.9624C18.5274 14.9266 18.7516 14.8617 18.908 14.782C19.2843 14.5903 19.5903 14.2843 19.782 13.908C19.8617 13.7516 19.9266 13.5274 19.9624 13.089C19.9992 12.6389 20 12.0566 20 11.2V7.8C20 6.94342 19.9992 6.36113 19.9624 5.91104C19.9266 5.47262 19.8617 5.24842 19.782 5.09202C19.5903 4.7157 19.2843 4.40973 18.908 4.21799C18.7516 4.1383 18.5274 4.07337 18.089 4.03755C17.6389 4.00078 17.0566 4 16.2 4H12.8C11.9434 4 11.3611 4.00078 10.911 4.03755C10.4726 4.07337 10.2484 4.1383 10.092 4.21799C9.7157 4.40973 9.40973 4.7157 9.21799 5.09202C9.1383 5.24842 9.07337 5.47262 9.03755 5.91104C9.01357 6.20463 9.00489 6.55447 9.00176 7ZM5.91104 9.03755C5.47262 9.07337 5.24842 9.1383 5.09202 9.21799C4.7157 9.40973 4.40973 9.7157 4.21799 10.092C4.1383 10.2484 4.07337 10.4726 4.03755 10.911C4.00078 11.3611 4 11.9434 4 12.8V16.2C4 17.0566 4.00078 17.6389 4.03755 18.089C4.07337 18.5274 4.1383 18.7516 4.21799 18.908C4.40973 19.2843 4.7157 19.5903 5.09202 19.782C5.24842 19.8617 5.47262 19.9266 5.91104 19.9624C6.36113 19.9992 6.94342 20 7.8 20H11.2C12.0566 20 12.6389 19.9992 13.089 19.9624C13.5274 19.9266 13.7516 19.8617 13.908 19.782C14.2843 19.5903 14.5903 19.2843 14.782 18.908C14.8617 18.7516 14.9266 18.5274 14.9624 18.089C14.9992 17.6389 15 17.0566 15 16.2V12.8C15 11.9434 14.9992 11.3611 14.9624 10.911C14.9266 10.4726 14.8617 10.2484 14.782 10.092C14.5903 9.7157 14.2843 9.40973 13.908 9.21799C13.7516 9.1383 13.5274 9.07337 13.089 9.03755C12.6389 9.00078 12.0566 9 11.2 9H7.8C6.94342 9 6.36113 9.00078 5.91104 9.03755Z" fill="currentColor"></path></svg></span></span></span></button></div><div class="code-sample-body code-sample-body-small code-sample-body-with-header"><div class="code-block"><pre class="hljs syntax-highlighter dark-mode code-sample-pre"><code class="language-bash" style="white-space: pre;"><code style="float: left; padding-right: 10px;"><span class="react-syntax-highlighter-line-number">1
</span><span class="react-syntax-highlighter-line-number">2
</span><span class="react-syntax-highlighter-line-number">3
</span><span class="react-syntax-highlighter-line-number">4
</span><span class="react-syntax-highlighter-line-number">5
</span><span class="react-syntax-highlighter-line-number">6
</span><span class="react-syntax-highlighter-line-number">7
</span></code><span><span>curl https://api.openai.com/v1/responses \
</span></span><span><span>  -H </span><span class="hljs-string">"Content-Type: application/json"</span><span> \
</span></span><span><span>  -H </span><span class="hljs-string">"Authorization: Bearer </span><span class="hljs-string hljs-variable">$OPENAI_API_KEY</span><span class="hljs-string">"</span><span> \
</span></span><span><span>  -d </span><span class="hljs-string">'{
</span></span><span class="hljs-string">    "model": "gpt-4.1",
</span><span class="hljs-string">    "input": "Tell me a three sentence bedtime story about a unicorn."
</span><span class="hljs-string">  }'</span></code></pre></div><div class="code-block hidden"><pre class="hljs syntax-highlighter dark-mode code-sample-pre"><code class="language-javascript" style="white-space: pre;"><code style="float: left; padding-right: 10px;"><span class="react-syntax-highlighter-line-number">1
</span><span class="react-syntax-highlighter-line-number">2
</span><span class="react-syntax-highlighter-line-number">3
</span><span class="react-syntax-highlighter-line-number">4
</span><span class="react-syntax-highlighter-line-number">5
</span><span class="react-syntax-highlighter-line-number">6
</span><span class="react-syntax-highlighter-line-number">7
</span><span class="react-syntax-highlighter-line-number">8
</span><span class="react-syntax-highlighter-line-number">9
</span><span class="react-syntax-highlighter-line-number">10
</span></code><span><span class="hljs-keyword">import</span><span> OpenAI </span><span class="hljs-keyword">from</span><span> </span><span class="hljs-string">"openai"</span><span>;
</span></span><span>
</span><span><span></span><span class="hljs-keyword">const</span><span> openai = </span><span class="hljs-keyword">new</span><span> OpenAI();
</span></span><span>
</span><span><span></span><span class="hljs-keyword">const</span><span> response = </span><span class="hljs-keyword">await</span><span> openai.responses.create({
</span></span><span><span>    </span><span class="hljs-attr">model</span><span>: </span><span class="hljs-string">"gpt-4.1"</span><span>,
</span></span><span><span>    </span><span class="hljs-attr">input</span><span>: </span><span class="hljs-string">"Tell me a three sentence bedtime story about a unicorn."</span><span>
</span></span><span>});
</span><span>
</span><span><span></span><span class="hljs-built_in">console</span><span>.log(response);</span></span></code></pre></div><div class="code-block hidden"><pre class="hljs syntax-highlighter dark-mode code-sample-pre"><code class="language-python" style="white-space: pre;"><code style="float: left; padding-right: 10px;"><span class="react-syntax-highlighter-line-number">1
</span><span class="react-syntax-highlighter-line-number">2
</span><span class="react-syntax-highlighter-line-number">3
</span><span class="react-syntax-highlighter-line-number">4
</span><span class="react-syntax-highlighter-line-number">5
</span><span class="react-syntax-highlighter-line-number">6
</span><span class="react-syntax-highlighter-line-number">7
</span><span class="react-syntax-highlighter-line-number">8
</span><span class="react-syntax-highlighter-line-number">9
</span><span class="react-syntax-highlighter-line-number">10
</span></code><span><span class="hljs-keyword">from</span><span> openai </span><span class="hljs-keyword">import</span><span> OpenAI
</span></span><span>
</span><span>client = OpenAI()
</span><span>
</span><span>response = client.responses.create(
</span><span><span>  model=</span><span class="hljs-string">"gpt-4.1"</span><span>,
</span></span><span><span>  </span><span class="hljs-built_in">input</span><span>=</span><span class="hljs-string">"Tell me a three sentence bedtime story about a unicorn."</span><span>
</span></span><span>)
</span><span>
</span><span><span></span><span class="hljs-built_in">print</span><span>(response)</span></span></code></pre></div><div class="code-block hidden"><pre class="hljs syntax-highlighter dark-mode code-sample-pre"><code class="language-csharp" style="white-space: pre;"><code style="float: left; padding-right: 10px;"><span class="react-syntax-highlighter-line-number">1
</span><span class="react-syntax-highlighter-line-number">2
</span><span class="react-syntax-highlighter-line-number">3
</span><span class="react-syntax-highlighter-line-number">4
</span><span class="react-syntax-highlighter-line-number">5
</span><span class="react-syntax-highlighter-line-number">6
</span><span class="react-syntax-highlighter-line-number">7
</span><span class="react-syntax-highlighter-line-number">8
</span><span class="react-syntax-highlighter-line-number">9
</span><span class="react-syntax-highlighter-line-number">10
</span><span class="react-syntax-highlighter-line-number">11
</span></code><span><span class="hljs-keyword">using</span><span> System;
</span></span><span><span></span><span class="hljs-keyword">using</span><span> OpenAI.Responses;
</span></span><span>
</span><span><span>OpenAIResponseClient client = </span><span class="hljs-keyword">new</span><span>(
</span></span><span><span>    model: </span><span class="hljs-string">"gpt-4.1"</span><span>,
</span></span><span><span>    apiKey: Environment.GetEnvironmentVariable(</span><span class="hljs-string">"OPENAI_API_KEY"</span><span>)
</span></span><span>);
</span><span>
</span><span><span>OpenAIResponse response = client.CreateResponse(</span><span class="hljs-string">"Tell me a three sentence bedtime story about a unicorn."</span><span>);
</span></span><span>
</span><span>Console.WriteLine(response.GetOutputText());</span></code></pre></div></div></div><div class="code-sample dark-mode"><div class="code-sample-header"><div class="code-sample-title body-small">Response</div><button type="button" class="lkCln" data-color="primary" data-variant="ghost" data-size="sm" data-gutter-size="xs" data-icon-size="sm"><span class="NBPKZ"><span class="block relative w-[var(--button-icon-size)] h-[var(--button-icon-size)]" data-transition-position="absolute" style="--tg-will-change: transform, opacity; --tg-enter-opacity: 1; --tg-enter-transform: scale(1); --tg-enter-filter: none; --tg-enter-duration: 300ms; --tg-enter-delay: 150ms; --tg-enter-timing-function: var(--cubic-enter); --tg-exit-opacity: 0; --tg-exit-transform: scale(0.6); --tg-exit-filter: none; --tg-exit-duration: 150ms; --tg-exit-delay: 0ms; --tg-exit-timing-function: var(--cubic-exit); --tg-initial-opacity: 0; --tg-initial-transform: scale(0.6); --tg-initial-filter: none;"><span class="_4jUWi pdMy8"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M12.7587 2H16.2413C17.0463 1.99999 17.7106 1.99998 18.2518 2.04419C18.8139 2.09012 19.3306 2.18868 19.816 2.43597C20.5686 2.81947 21.1805 3.43139 21.564 4.18404C21.8113 4.66937 21.9099 5.18608 21.9558 5.74817C22 6.28936 22 6.95372 22 7.75868V11.2413C22 12.0463 22 12.7106 21.9558 13.2518C21.9099 13.8139 21.8113 14.3306 21.564 14.816C21.1805 15.5686 20.5686 16.1805 19.816 16.564C19.3306 16.8113 18.8139 16.9099 18.2518 16.9558C17.8906 16.9853 17.4745 16.9951 16.9984 16.9984C16.9951 17.4745 16.9853 17.8906 16.9558 18.2518C16.9099 18.8139 16.8113 19.3306 16.564 19.816C16.1805 20.5686 15.5686 21.1805 14.816 21.564C14.3306 21.8113 13.8139 21.9099 13.2518 21.9558C12.7106 22 12.0463 22 11.2413 22H7.75868C6.95372 22 6.28936 22 5.74818 21.9558C5.18608 21.9099 4.66937 21.8113 4.18404 21.564C3.43139 21.1805 2.81947 20.5686 2.43597 19.816C2.18868 19.3306 2.09012 18.8139 2.04419 18.2518C1.99998 17.7106 1.99999 17.0463 2 16.2413V12.7587C1.99999 11.9537 1.99998 11.2894 2.04419 10.7482C2.09012 10.1861 2.18868 9.66937 2.43597 9.18404C2.81947 8.43139 3.43139 7.81947 4.18404 7.43598C4.66937 7.18868 5.18608 7.09012 5.74817 7.04419C6.10939 7.01468 6.52548 7.00487 7.00162 7.00162C7.00487 6.52548 7.01468 6.10939 7.04419 5.74817C7.09012 5.18608 7.18868 4.66937 7.43598 4.18404C7.81947 3.43139 8.43139 2.81947 9.18404 2.43597C9.66937 2.18868 10.1861 2.09012 10.7482 2.04419C11.2894 1.99998 11.9537 1.99999 12.7587 2ZM9.00176 7L11.2413 7C12.0463 6.99999 12.7106 6.99998 13.2518 7.04419C13.8139 7.09012 14.3306 7.18868 14.816 7.43598C15.5686 7.81947 16.1805 8.43139 16.564 9.18404C16.8113 9.66937 16.9099 10.1861 16.9558 10.7482C17 11.2894 17 11.9537 17 12.7587V14.9982C17.4455 14.9951 17.7954 14.9864 18.089 14.9624C18.5274 14.9266 18.7516 14.8617 18.908 14.782C19.2843 14.5903 19.5903 14.2843 19.782 13.908C19.8617 13.7516 19.9266 13.5274 19.9624 13.089C19.9992 12.6389 20 12.0566 20 11.2V7.8C20 6.94342 19.9992 6.36113 19.9624 5.91104C19.9266 5.47262 19.8617 5.24842 19.782 5.09202C19.5903 4.7157 19.2843 4.40973 18.908 4.21799C18.7516 4.1383 18.5274 4.07337 18.089 4.03755C17.6389 4.00078 17.0566 4 16.2 4H12.8C11.9434 4 11.3611 4.00078 10.911 4.03755C10.4726 4.07337 10.2484 4.1383 10.092 4.21799C9.7157 4.40973 9.40973 4.7157 9.21799 5.09202C9.1383 5.24842 9.07337 5.47262 9.03755 5.91104C9.01357 6.20463 9.00489 6.55447 9.00176 7ZM5.91104 9.03755C5.47262 9.07337 5.24842 9.1383 5.09202 9.21799C4.7157 9.40973 4.40973 9.7157 4.21799 10.092C4.1383 10.2484 4.07337 10.4726 4.03755 10.911C4.00078 11.3611 4 11.9434 4 12.8V16.2C4 17.0566 4.00078 17.6389 4.03755 18.089C4.07337 18.5274 4.1383 18.7516 4.21799 18.908C4.40973 19.2843 4.7157 19.5903 5.09202 19.782C5.24842 19.8617 5.47262 19.9266 5.91104 19.9624C6.36113 19.9992 6.94342 20 7.8 20H11.2C12.0566 20 12.6389 19.9992 13.089 19.9624C13.5274 19.9266 13.7516 19.8617 13.908 19.782C14.2843 19.5903 14.5903 19.2843 14.782 18.908C14.8617 18.7516 14.9266 18.5274 14.9624 18.089C14.9992 17.6389 15 17.0566 15 16.2V12.8C15 11.9434 14.9992 11.3611 14.9624 10.911C14.9266 10.4726 14.8617 10.2484 14.782 10.092C14.5903 9.7157 14.2843 9.40973 13.908 9.21799C13.7516 9.1383 13.5274 9.07337 13.089 9.03755C12.6389 9.00078 12.0566 9 11.2 9H7.8C6.94342 9 6.36113 9.00078 5.91104 9.03755Z" fill="currentColor"></path></svg></span></span></span></button></div><div class="code-sample-body code-sample-body-small code-sample-body-with-header"><pre class="hljs syntax-highlighter dark-mode code-sample-pre"><code class="language-json" style="white-space: pre;"><code style="float: left; padding-right: 10px;"><span class="react-syntax-highlighter-line-number">1
</span><span class="react-syntax-highlighter-line-number">2
</span><span class="react-syntax-highlighter-line-number">3
</span><span class="react-syntax-highlighter-line-number">4
</span><span class="react-syntax-highlighter-line-number">5
</span><span class="react-syntax-highlighter-line-number">6
</span><span class="react-syntax-highlighter-line-number">7
</span><span class="react-syntax-highlighter-line-number">8
</span><span class="react-syntax-highlighter-line-number">9
</span><span class="react-syntax-highlighter-line-number">10
</span><span class="react-syntax-highlighter-line-number">11
</span><span class="react-syntax-highlighter-line-number">12
</span><span class="react-syntax-highlighter-line-number">13
</span><span class="react-syntax-highlighter-line-number">14
</span><span class="react-syntax-highlighter-line-number">15
</span><span class="react-syntax-highlighter-line-number">16
</span><span class="react-syntax-highlighter-line-number">17
</span><span class="react-syntax-highlighter-line-number">18
</span><span class="react-syntax-highlighter-line-number">19
</span><span class="react-syntax-highlighter-line-number">20
</span><span class="react-syntax-highlighter-line-number">21
</span><span class="react-syntax-highlighter-line-number">22
</span><span class="react-syntax-highlighter-line-number">23
</span><span class="react-syntax-highlighter-line-number">24
</span><span class="react-syntax-highlighter-line-number">25
</span><span class="react-syntax-highlighter-line-number">26
</span><span class="react-syntax-highlighter-line-number">27
</span><span class="react-syntax-highlighter-line-number">28
</span><span class="react-syntax-highlighter-line-number">29
</span><span class="react-syntax-highlighter-line-number">30
</span><span class="react-syntax-highlighter-line-number">31
</span><span class="react-syntax-highlighter-line-number">32
</span><span class="react-syntax-highlighter-line-number">33
</span><span class="react-syntax-highlighter-line-number">34
</span><span class="react-syntax-highlighter-line-number">35
</span><span class="react-syntax-highlighter-line-number">36
</span><span class="react-syntax-highlighter-line-number">37
</span><span class="react-syntax-highlighter-line-number">38
</span><span class="react-syntax-highlighter-line-number">39
</span><span class="react-syntax-highlighter-line-number">40
</span><span class="react-syntax-highlighter-line-number">41
</span><span class="react-syntax-highlighter-line-number">42
</span><span class="react-syntax-highlighter-line-number">43
</span><span class="react-syntax-highlighter-line-number">44
</span><span class="react-syntax-highlighter-line-number">45
</span><span class="react-syntax-highlighter-line-number">46
</span><span class="react-syntax-highlighter-line-number">47
</span><span class="react-syntax-highlighter-line-number">48
</span><span class="react-syntax-highlighter-line-number">49
</span><span class="react-syntax-highlighter-line-number">50
</span><span class="react-syntax-highlighter-line-number">51
</span><span class="react-syntax-highlighter-line-number">52
</span><span class="react-syntax-highlighter-line-number">53
</span><span class="react-syntax-highlighter-line-number">54
</span><span class="react-syntax-highlighter-line-number">55
</span><span class="react-syntax-highlighter-line-number">56
</span></code><span><span>{
</span></span><span><span>  </span><span class="hljs-attr">"id"</span><span>: </span><span class="hljs-string">"resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"object"</span><span>: </span><span class="hljs-string">"response"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"created_at"</span><span>: </span><span class="hljs-number">1741476542</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"status"</span><span>: </span><span class="hljs-string">"completed"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"error"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"incomplete_details"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"instructions"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"max_output_tokens"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"model"</span><span>: </span><span class="hljs-string">"gpt-4.1-2025-04-14"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"output"</span><span>: [
</span></span><span>    {
</span><span><span>      </span><span class="hljs-attr">"type"</span><span>: </span><span class="hljs-string">"message"</span><span>,
</span></span><span><span>      </span><span class="hljs-attr">"id"</span><span>: </span><span class="hljs-string">"msg_67ccd2bf17f0819081ff3bb2cf6508e60bb6a6b452d3795b"</span><span>,
</span></span><span><span>      </span><span class="hljs-attr">"status"</span><span>: </span><span class="hljs-string">"completed"</span><span>,
</span></span><span><span>      </span><span class="hljs-attr">"role"</span><span>: </span><span class="hljs-string">"assistant"</span><span>,
</span></span><span><span>      </span><span class="hljs-attr">"content"</span><span>: [
</span></span><span>        {
</span><span><span>          </span><span class="hljs-attr">"type"</span><span>: </span><span class="hljs-string">"output_text"</span><span>,
</span></span><span><span>          </span><span class="hljs-attr">"text"</span><span>: </span><span class="hljs-string">"In a peaceful grove beneath a silver moon, a unicorn named Lumina discovered a hidden pool that reflected the stars. As she dipped her horn into the water, the pool began to shimmer, revealing a pathway to a magical realm of endless night skies. Filled with wonder, Lumina whispered a wish for all who dream to find their own hidden magic, and as she glanced back, her hoofprints sparkled like stardust."</span><span>,
</span></span><span><span>          </span><span class="hljs-attr">"annotations"</span><span>: []
</span></span><span>        }
</span><span>      ]
</span><span>    }
</span><span>  ],
</span><span><span>  </span><span class="hljs-attr">"parallel_tool_calls"</span><span>: </span><span class="hljs-literal">true</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"previous_response_id"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"reasoning"</span><span>: {
</span></span><span><span>    </span><span class="hljs-attr">"effort"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>    </span><span class="hljs-attr">"summary"</span><span>: </span><span class="hljs-literal">null</span><span>
</span></span><span>  },
</span><span><span>  </span><span class="hljs-attr">"store"</span><span>: </span><span class="hljs-literal">true</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"temperature"</span><span>: </span><span class="hljs-number">1.0</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"text"</span><span>: {
</span></span><span><span>    </span><span class="hljs-attr">"format"</span><span>: {
</span></span><span><span>      </span><span class="hljs-attr">"type"</span><span>: </span><span class="hljs-string">"text"</span><span>
</span></span><span>    }
</span><span>  },
</span><span><span>  </span><span class="hljs-attr">"tool_choice"</span><span>: </span><span class="hljs-string">"auto"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"tools"</span><span>: [],
</span></span><span><span>  </span><span class="hljs-attr">"top_p"</span><span>: </span><span class="hljs-number">1.0</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"truncation"</span><span>: </span><span class="hljs-string">"disabled"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"usage"</span><span>: {
</span></span><span><span>    </span><span class="hljs-attr">"input_tokens"</span><span>: </span><span class="hljs-number">36</span><span>,
</span></span><span><span>    </span><span class="hljs-attr">"input_tokens_details"</span><span>: {
</span></span><span><span>      </span><span class="hljs-attr">"cached_tokens"</span><span>: </span><span class="hljs-number">0</span><span>
</span></span><span>    },
</span><span><span>    </span><span class="hljs-attr">"output_tokens"</span><span>: </span><span class="hljs-number">87</span><span>,
</span></span><span><span>    </span><span class="hljs-attr">"output_tokens_details"</span><span>: {
</span></span><span><span>      </span><span class="hljs-attr">"reasoning_tokens"</span><span>: </span><span class="hljs-number">0</span><span>
</span></span><span>    },
</span><span><span>    </span><span class="hljs-attr">"total_tokens"</span><span>: </span><span class="hljs-number">123</span><span>
</span></span><span>  },
</span><span><span>  </span><span class="hljs-attr">"user"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"metadata"</span><span>: {}
</span></span><span>}</span></code></pre></div></div></div></div></div></div>

<div class="section"><div class="anchor-heading-wrapper"><h2 id="responses/object" class="anchor-heading" data-name="responses/object"><div class="flex flex-row items-center gap-3">The response object</div><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" class="anchor-heading-icon" role="presentation"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></h2></div><div class="endpoint"><div class="section-left"><div class="docs-markdown-content"></div><div class="param-table" id="responses-object__table"><div class="param-row" id="responses-object-background" data-normalized-id="responses-object-background"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-background" data-anchor="responses-object-background" id="responses-object-background-anchor" data-normalized-id="responses-object-background-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">background</div><div class="param-type"><div class="docs-markdown-content"><p>boolean</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Whether to run the model response in the background.
<a href="/docs/guides/background" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div></div><div class="param-row" id="responses-object-conversation" data-normalized-id="responses-object-conversation"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-conversation" data-anchor="responses-object-conversation" id="responses-object-conversation-anchor" data-normalized-id="responses-object-conversation-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">conversation</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>The conversation that this response belongs to. Input items and output items from this response are automatically added to this conversation.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-conversation_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses-object-created_at" data-normalized-id="responses-object-created-at"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-created_at" data-anchor="responses-object-created_at" id="responses-object-created_at-anchor" data-normalized-id="responses-object-created-at-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">created_at</div><div class="param-type"><div class="docs-markdown-content"><p>number</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Unix timestamp (in seconds) of when this Response was created.</p></div></div></div><div class="param-row" id="responses-object-error" data-normalized-id="responses-object-error"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-error" data-anchor="responses-object-error" id="responses-object-error-anchor" data-normalized-id="responses-object-error-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">error</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>An error object returned when the model fails to generate a Response.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-error_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses-object-id" data-normalized-id="responses-object-id"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-id" data-anchor="responses-object-id" id="responses-object-id-anchor" data-normalized-id="responses-object-id-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">id</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Unique identifier for this Response.</p></div></div></div><div class="param-row" id="responses-object-incomplete_details" data-normalized-id="responses-object-incomplete-details"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-incomplete_details" data-anchor="responses-object-incomplete_details" id="responses-object-incomplete_details-anchor" data-normalized-id="responses-object-incomplete-details-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">incomplete_details</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Details about why the response is incomplete.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-incomplete_details_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses-object-instructions" data-normalized-id="responses-object-instructions"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-instructions" data-anchor="responses-object-instructions" id="responses-object-instructions-anchor" data-normalized-id="responses-object-instructions-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">instructions</div><div class="param-type"><div class="docs-markdown-content"><p>string or array</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>A system (or developer) message inserted into the model's context.</p>
<p>When using along with <code>previous_response_id</code>, the instructions from a previous
response will not be carried over to the next response. This makes it simple
to swap out system (or developer) messages in new responses.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-instructions_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show possible types</span></button></div><div class="param-row" id="responses-object-max_output_tokens" data-normalized-id="responses-object-max-output-tokens"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-max_output_tokens" data-anchor="responses-object-max_output_tokens" id="responses-object-max_output_tokens-anchor" data-normalized-id="responses-object-max-output-tokens-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">max_output_tokens</div><div class="param-type"><div class="docs-markdown-content"><p>integer</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>An upper bound for the number of tokens that can be generated for a response, including visible output tokens and <a href="/docs/guides/reasoning" class="kZ98Q" data-underline="">reasoning tokens</a>.</p></div></div></div><div class="param-row" id="responses-object-max_tool_calls" data-normalized-id="responses-object-max-tool-calls"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-max_tool_calls" data-anchor="responses-object-max_tool_calls" id="responses-object-max_tool_calls-anchor" data-normalized-id="responses-object-max-tool-calls-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">max_tool_calls</div><div class="param-type"><div class="docs-markdown-content"><p>integer</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>The maximum number of total calls to built-in tools that can be processed in a response. This maximum number applies across all built-in tool calls, not per individual tool. Any further attempts to call a tool by the model will be ignored.</p></div></div></div><div class="param-row" id="responses-object-metadata" data-normalized-id="responses-object-metadata"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-metadata" data-anchor="responses-object-metadata" id="responses-object-metadata-anchor" data-normalized-id="responses-object-metadata-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">metadata</div><div class="param-type"><div class="docs-markdown-content"><p>map</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Set of 16 key-value pairs that can be attached to an object. This can be
useful for storing additional information about the object in a structured
format, and querying for objects via API or the dashboard.</p>
<p>Keys are strings with a maximum length of 64 characters. Values are strings
with a maximum length of 512 characters.</p></div></div></div><div class="param-row" id="responses-object-model" data-normalized-id="responses-object-model"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-model" data-anchor="responses-object-model" id="responses-object-model-anchor" data-normalized-id="responses-object-model-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">model</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Model ID used to generate the response, like <code>gpt-4o</code> or <code>o3</code>. OpenAI
offers a wide range of models with different capabilities, performance
characteristics, and price points. Refer to the <a href="/docs/models" class="kZ98Q" data-underline="">model guide</a>
to browse and compare available models.</p></div></div></div><div class="param-row" id="responses-object-object" data-normalized-id="responses-object-object"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-object" data-anchor="responses-object-object" id="responses-object-object-anchor" data-normalized-id="responses-object-object-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">object</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>The object type of this resource - always set to <code>response</code>.</p></div></div></div><div class="param-row" id="responses-object-output" data-normalized-id="responses-object-output"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-output" data-anchor="responses-object-output" id="responses-object-output-anchor" data-normalized-id="responses-object-output-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">output</div><div class="param-type"><div class="docs-markdown-content"><p>array</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>An array of content items generated by the model.</p>
<ul>
<li>The length and order of items in the <code>output</code> array is dependent
on the model's response.</li>
<li>Rather than accessing the first item in the <code>output</code> array and
assuming it's an <code>assistant</code> message with the content generated by
the model, you might consider using the <code>output_text</code> property where
supported in SDKs.</li>
</ul></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-output_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show possible types</span></button></div><div class="param-row" id="responses-object-output_text" data-normalized-id="responses-object-output-text"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-output_text" data-anchor="responses-object-output_text" id="responses-object-output_text-anchor" data-normalized-id="responses-object-output-text-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">output_text</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div><div class="ml-2 rounded-sm bg-blue-900 px-1 py-0.5 text-xs text-white">SDK Only</div></div><div class="param-desc"><div class="docs-markdown-content"><p>SDK-only convenience property that contains the aggregated text output
from all <code>output_text</code> items in the <code>output</code> array, if any are present.
Supported in the Python and JavaScript SDKs.</p></div></div></div><div class="param-row" id="responses-object-parallel_tool_calls" data-normalized-id="responses-object-parallel-tool-calls"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-parallel_tool_calls" data-anchor="responses-object-parallel_tool_calls" id="responses-object-parallel_tool_calls-anchor" data-normalized-id="responses-object-parallel-tool-calls-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">parallel_tool_calls</div><div class="param-type"><div class="docs-markdown-content"><p>boolean</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Whether to allow the model to run tool calls in parallel.</p></div></div></div><div class="param-row" id="responses-object-previous_response_id" data-normalized-id="responses-object-previous-response-id"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-previous_response_id" data-anchor="responses-object-previous_response_id" id="responses-object-previous_response_id-anchor" data-normalized-id="responses-object-previous-response-id-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">previous_response_id</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>The unique ID of the previous response to the model. Use this to
create multi-turn conversations. Learn more about
<a href="/docs/guides/conversation-state" class="kZ98Q" data-underline="">conversation state</a>. Cannot be used in conjunction with <code>conversation</code>.</p></div></div></div><div class="param-row" id="responses-object-prompt" data-normalized-id="responses-object-prompt"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-prompt" data-anchor="responses-object-prompt" id="responses-object-prompt-anchor" data-normalized-id="responses-object-prompt-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">prompt</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Reference to a prompt template and its variables.
<a href="/docs/guides/text?api-mode=responses#reusable-prompts" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-prompt_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses-object-prompt_cache_key" data-normalized-id="responses-object-prompt-cache-key"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-prompt_cache_key" data-anchor="responses-object-prompt_cache_key" id="responses-object-prompt_cache_key-anchor" data-normalized-id="responses-object-prompt-cache-key-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">prompt_cache_key</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Used by OpenAI to cache responses for similar requests to optimize your cache hit rates. Replaces the <code>user</code> field. <a href="/docs/guides/prompt-caching" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div></div><div class="param-row" id="responses-object-reasoning" data-normalized-id="responses-object-reasoning"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-reasoning" data-anchor="responses-object-reasoning" id="responses-object-reasoning-anchor" data-normalized-id="responses-object-reasoning-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">reasoning</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p><strong>gpt-5 and o-series models only</strong></p>
<p>Configuration options for
<a target="_blank" rel="noopener noreferrer" href="https://platform.openai.com/docs/guides/reasoning" class="kZ98Q" data-underline="">reasoning models</a>.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-reasoning_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses-object-safety_identifier" data-normalized-id="responses-object-safety-identifier"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-safety_identifier" data-anchor="responses-object-safety_identifier" id="responses-object-safety_identifier-anchor" data-normalized-id="responses-object-safety-identifier-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">safety_identifier</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>A stable identifier used to help detect users of your application that may be violating OpenAI's usage policies.
The IDs should be a string that uniquely identifies each user. We recommend hashing their username or email address, in order to avoid sending us any identifying information. <a href="/docs/guides/safety-best-practices#safety-identifiers" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div></div><div class="param-row" id="responses-object-service_tier" data-normalized-id="responses-object-service-tier"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-service_tier" data-anchor="responses-object-service_tier" id="responses-object-service_tier-anchor" data-normalized-id="responses-object-service-tier-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">service_tier</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Specifies the processing type used for serving the request.</p>
<ul>
<li>If set to 'auto', then the request will be processed with the service tier configured in the Project settings. Unless otherwise configured, the Project will use 'default'.</li>
<li>If set to 'default', then the request will be processed with the standard pricing and performance for the selected model.</li>
<li>If set to '<a href="/docs/guides/flex-processing" class="kZ98Q" data-underline="">flex</a>' or '<a target="_blank" rel="noopener noreferrer" href="https://openai.com/api-priority-processing/" class="kZ98Q" data-underline="">priority</a>', then the request will be processed with the corresponding service tier.</li>
<li>When not set, the default behavior is 'auto'.</li>
</ul>
<p>When the <code>service_tier</code> parameter is set, the response body will include the <code>service_tier</code> value based on the processing mode actually used to serve the request. This response value may be different from the value set in the parameter.</p></div></div></div><div class="param-row" id="responses-object-status" data-normalized-id="responses-object-status"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-status" data-anchor="responses-object-status" id="responses-object-status-anchor" data-normalized-id="responses-object-status-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">status</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>The status of the response generation. One of <code>completed</code>, <code>failed</code>,
<code>in_progress</code>, <code>cancelled</code>, <code>queued</code>, or <code>incomplete</code>.</p></div></div></div><div class="param-row" id="responses-object-temperature" data-normalized-id="responses-object-temperature"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-temperature" data-anchor="responses-object-temperature" id="responses-object-temperature-anchor" data-normalized-id="responses-object-temperature-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">temperature</div><div class="param-type"><div class="docs-markdown-content"><p>number</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>What sampling temperature to use, between 0 and 2. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.
We generally recommend altering this or <code>top_p</code> but not both.</p></div></div></div><div class="param-row" id="responses-object-text" data-normalized-id="responses-object-text"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-text" data-anchor="responses-object-text" id="responses-object-text-anchor" data-normalized-id="responses-object-text-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">text</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Configuration options for a text response from the model. Can be plain
text or structured JSON data. Learn more:</p>
<ul>
<li><a href="/docs/guides/text" class="kZ98Q" data-underline="">Text inputs and outputs</a></li>
<li><a href="/docs/guides/structured-outputs" class="kZ98Q" data-underline="">Structured Outputs</a></li>
</ul></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-text_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses-object-tool_choice" data-normalized-id="responses-object-tool-choice"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-tool_choice" data-anchor="responses-object-tool_choice" id="responses-object-tool_choice-anchor" data-normalized-id="responses-object-tool-choice-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">tool_choice</div><div class="param-type"><div class="docs-markdown-content"><p>string or object</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>How the model should select which tool (or tools) to use when generating
a response. See the <code>tools</code> parameter to see how to specify which tools
the model can call.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-tool_choice_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show possible types</span></button></div><div class="param-row" id="responses-object-tools" data-normalized-id="responses-object-tools"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-tools" data-anchor="responses-object-tools" id="responses-object-tools-anchor" data-normalized-id="responses-object-tools-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">tools</div><div class="param-type"><div class="docs-markdown-content"><p>array</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>An array of tools the model may call while generating a response. You
can specify which tool to use by setting the <code>tool_choice</code> parameter.</p>
<p>We support the following categories of tools:</p>
<ul>
<li><strong>Built-in tools</strong>: Tools that are provided by OpenAI that extend the
model's capabilities, like <a href="/docs/guides/tools-web-search" class="kZ98Q" data-underline="">web search</a>
or <a href="/docs/guides/tools-file-search" class="kZ98Q" data-underline="">file search</a>. Learn more about
<a href="/docs/guides/tools" class="kZ98Q" data-underline="">built-in tools</a>.</li>
<li><strong>MCP Tools</strong>: Integrations with third-party systems via custom MCP servers
or predefined connectors such as Google Drive and SharePoint. Learn more about
<a href="/docs/guides/tools-connectors-mcp" class="kZ98Q" data-underline="">MCP Tools</a>.</li>
<li><strong>Function calls (custom tools)</strong>: Functions that are defined by you,
enabling the model to call your own code with strongly typed arguments
and outputs. Learn more about
<a href="/docs/guides/function-calling" class="kZ98Q" data-underline="">function calling</a>. You can also use
custom tools to call your own code.</li>
</ul></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-tools_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show possible types</span></button></div><div class="param-row" id="responses-object-top_logprobs" data-normalized-id="responses-object-top-logprobs"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-top_logprobs" data-anchor="responses-object-top_logprobs" id="responses-object-top_logprobs-anchor" data-normalized-id="responses-object-top-logprobs-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">top_logprobs</div><div class="param-type"><div class="docs-markdown-content"><p>integer</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>An integer between 0 and 20 specifying the number of most likely tokens to
return at each token position, each with an associated log probability.</p></div></div></div><div class="param-row" id="responses-object-top_p" data-normalized-id="responses-object-top-p"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-top_p" data-anchor="responses-object-top_p" id="responses-object-top_p-anchor" data-normalized-id="responses-object-top-p-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">top_p</div><div class="param-type"><div class="docs-markdown-content"><p>number</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>An alternative to sampling with temperature, called nucleus sampling,
where the model considers the results of the tokens with top_p probability
mass. So 0.1 means only the tokens comprising the top 10% probability mass
are considered.</p>
<p>We generally recommend altering this or <code>temperature</code> but not both.</p></div></div></div><div class="param-row" id="responses-object-truncation" data-normalized-id="responses-object-truncation"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-truncation" data-anchor="responses-object-truncation" id="responses-object-truncation-anchor" data-normalized-id="responses-object-truncation-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">truncation</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>The truncation strategy to use for the model response.</p>
<ul>
<li><code>auto</code>: If the input to this Response exceeds
the model's context window size, the model will truncate the
response to fit the context window by dropping items from the beginning of the conversation.</li>
<li><code>disabled</code> (default): If the input size will exceed the context window
size for a model, the request will fail with a 400 error.</li>
</ul></div></div></div><div class="param-row" id="responses-object-usage" data-normalized-id="responses-object-usage"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-usage" data-anchor="responses-object-usage" id="responses-object-usage-anchor" data-normalized-id="responses-object-usage-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">usage</div><div class="param-type"><div class="docs-markdown-content"><p>object</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>Represents token usage details including input tokens, output tokens,
a breakdown of output tokens, and the total tokens used.</p></div></div><button class="param-expand-button" aria-expanded="false" aria-controls="responses-object-usage_table"><span class="param-expand-chevron" aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.293 8.293a1 1 0 0 1 1.414 0L12 14.586l6.293-6.293a1 1 0 1 1 1.414 1.414l-7 7a1 1 0 0 1-1.414 0l-7-7a1 1 0 0 1 0-1.414Z" clip-rule="evenodd"></path></svg></span><span>Show properties</span></button></div><div class="param-row" id="responses-object-user" data-normalized-id="responses-object-user"><div class="param-row-header api-ref-anchor-link-hover"><a href="#responses-object-user" data-anchor="responses-object-user" id="responses-object-user-anchor" data-normalized-id="responses-object-user-anchor" class="api-ref-anchor-link"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M18.2929 5.7071C16.4743 3.88849 13.5257 3.88849 11.7071 5.7071L10.7071 6.7071C10.3166 7.09763 9.68341 7.09763 9.29289 6.7071C8.90236 6.31658 8.90236 5.68341 9.29289 5.29289L10.2929 4.29289C12.8926 1.69322 17.1074 1.69322 19.7071 4.29289C22.3068 6.89255 22.3068 11.1074 19.7071 13.7071L18.7071 14.7071C18.3166 15.0976 17.6834 15.0976 17.2929 14.7071C16.9024 14.3166 16.9024 13.6834 17.2929 13.2929L18.2929 12.2929C20.1115 10.4743 20.1115 7.52572 18.2929 5.7071ZM15.7071 8.29289C16.0976 8.68341 16.0976 9.31658 15.7071 9.7071L9.7071 15.7071C9.31658 16.0976 8.68341 16.0976 8.29289 15.7071C7.90236 15.3166 7.90236 14.6834 8.29289 14.2929L14.2929 8.29289C14.6834 7.90236 15.3166 7.90236 15.7071 8.29289ZM6.7071 9.29289C7.09763 9.68341 7.09763 10.3166 6.7071 10.7071L5.7071 11.7071C3.88849 13.5257 3.88849 16.4743 5.7071 18.2929C7.52572 20.1115 10.4743 20.1115 12.2929 18.2929L13.2929 17.2929C13.6834 16.9024 14.3166 16.9024 14.7071 17.2929C15.0976 17.6834 15.0976 18.3166 14.7071 18.7071L13.7071 19.7071C11.1074 22.3068 6.89255 22.3068 4.29289 19.7071C1.69322 17.1074 1.69322 12.8926 4.29289 10.2929L5.29289 9.29289C5.68341 8.90236 6.31658 8.90236 6.7071 9.29289Z" fill="currentColor"></path></svg></a><div class="param-name">user</div><div class="param-depr">Deprecated</div><div class="param-type"><div class="docs-markdown-content"><p>string</p></div></div></div><div class="param-desc"><div class="docs-markdown-content"><p>This field is being replaced by <code>safety_identifier</code> and <code>prompt_cache_key</code>. Use <code>prompt_cache_key</code> instead to maintain caching optimizations.
A stable identifier for your end-users.
Used to boost cache hit rates by better bucketing similar requests and  to help OpenAI detect and prevent abuse. <a href="/docs/guides/safety-best-practices#safety-identifiers" class="kZ98Q" data-underline="">Learn more</a>.</p></div></div></div></div><div class="param-table"></div></div><div class="section-right"><div class="section-right-inner"><div class="code-sample dark-mode"><div class="code-sample-header"><div class="code-sample-title body-small">OBJECT The response object</div><button type="button" class="lkCln" data-color="primary" data-variant="ghost" data-size="sm" data-gutter-size="xs" data-icon-size="sm"><span class="NBPKZ"><span class="block relative w-[var(--button-icon-size)] h-[var(--button-icon-size)]" data-transition-position="absolute" style="--tg-will-change: transform, opacity; --tg-enter-opacity: 1; --tg-enter-transform: scale(1); --tg-enter-filter: none; --tg-enter-duration: 300ms; --tg-enter-delay: 150ms; --tg-enter-timing-function: var(--cubic-enter); --tg-exit-opacity: 0; --tg-exit-transform: scale(0.6); --tg-exit-filter: none; --tg-exit-duration: 150ms; --tg-exit-delay: 0ms; --tg-exit-timing-function: var(--cubic-exit); --tg-initial-opacity: 0; --tg-initial-transform: scale(0.6); --tg-initial-filter: none;"><span class="_4jUWi pdMy8"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><path d="M12.7587 2H16.2413C17.0463 1.99999 17.7106 1.99998 18.2518 2.04419C18.8139 2.09012 19.3306 2.18868 19.816 2.43597C20.5686 2.81947 21.1805 3.43139 21.564 4.18404C21.8113 4.66937 21.9099 5.18608 21.9558 5.74817C22 6.28936 22 6.95372 22 7.75868V11.2413C22 12.0463 22 12.7106 21.9558 13.2518C21.9099 13.8139 21.8113 14.3306 21.564 14.816C21.1805 15.5686 20.5686 16.1805 19.816 16.564C19.3306 16.8113 18.8139 16.9099 18.2518 16.9558C17.8906 16.9853 17.4745 16.9951 16.9984 16.9984C16.9951 17.4745 16.9853 17.8906 16.9558 18.2518C16.9099 18.8139 16.8113 19.3306 16.564 19.816C16.1805 20.5686 15.5686 21.1805 14.816 21.564C14.3306 21.8113 13.8139 21.9099 13.2518 21.9558C12.7106 22 12.0463 22 11.2413 22H7.75868C6.95372 22 6.28936 22 5.74818 21.9558C5.18608 21.9099 4.66937 21.8113 4.18404 21.564C3.43139 21.1805 2.81947 20.5686 2.43597 19.816C2.18868 19.3306 2.09012 18.8139 2.04419 18.2518C1.99998 17.7106 1.99999 17.0463 2 16.2413V12.7587C1.99999 11.9537 1.99998 11.2894 2.04419 10.7482C2.09012 10.1861 2.18868 9.66937 2.43597 9.18404C2.81947 8.43139 3.43139 7.81947 4.18404 7.43598C4.66937 7.18868 5.18608 7.09012 5.74817 7.04419C6.10939 7.01468 6.52548 7.00487 7.00162 7.00162C7.00487 6.52548 7.01468 6.10939 7.04419 5.74817C7.09012 5.18608 7.18868 4.66937 7.43598 4.18404C7.81947 3.43139 8.43139 2.81947 9.18404 2.43597C9.66937 2.18868 10.1861 2.09012 10.7482 2.04419C11.2894 1.99998 11.9537 1.99999 12.7587 2ZM9.00176 7L11.2413 7C12.0463 6.99999 12.7106 6.99998 13.2518 7.04419C13.8139 7.09012 14.3306 7.18868 14.816 7.43598C15.5686 7.81947 16.1805 8.43139 16.564 9.18404C16.8113 9.66937 16.9099 10.1861 16.9558 10.7482C17 11.2894 17 11.9537 17 12.7587V14.9982C17.4455 14.9951 17.7954 14.9864 18.089 14.9624C18.5274 14.9266 18.7516 14.8617 18.908 14.782C19.2843 14.5903 19.5903 14.2843 19.782 13.908C19.8617 13.7516 19.9266 13.5274 19.9624 13.089C19.9992 12.6389 20 12.0566 20 11.2V7.8C20 6.94342 19.9992 6.36113 19.9624 5.91104C19.9266 5.47262 19.8617 5.24842 19.782 5.09202C19.5903 4.7157 19.2843 4.40973 18.908 4.21799C18.7516 4.1383 18.5274 4.07337 18.089 4.03755C17.6389 4.00078 17.0566 4 16.2 4H12.8C11.9434 4 11.3611 4.00078 10.911 4.03755C10.4726 4.07337 10.2484 4.1383 10.092 4.21799C9.7157 4.40973 9.40973 4.7157 9.21799 5.09202C9.1383 5.24842 9.07337 5.47262 9.03755 5.91104C9.01357 6.20463 9.00489 6.55447 9.00176 7ZM5.91104 9.03755C5.47262 9.07337 5.24842 9.1383 5.09202 9.21799C4.7157 9.40973 4.40973 9.7157 4.21799 10.092C4.1383 10.2484 4.07337 10.4726 4.03755 10.911C4.00078 11.3611 4 11.9434 4 12.8V16.2C4 17.0566 4.00078 17.6389 4.03755 18.089C4.07337 18.5274 4.1383 18.7516 4.21799 18.908C4.40973 19.2843 4.7157 19.5903 5.09202 19.782C5.24842 19.8617 5.47262 19.9266 5.91104 19.9624C6.36113 19.9992 6.94342 20 7.8 20H11.2C12.0566 20 12.6389 19.9992 13.089 19.9624C13.5274 19.9266 13.7516 19.8617 13.908 19.782C14.2843 19.5903 14.5903 19.2843 14.782 18.908C14.8617 18.7516 14.9266 18.5274 14.9624 18.089C14.9992 17.6389 15 17.0566 15 16.2V12.8C15 11.9434 14.9992 11.3611 14.9624 10.911C14.9266 10.4726 14.8617 10.2484 14.782 10.092C14.5903 9.7157 14.2843 9.40973 13.908 9.21799C13.7516 9.1383 13.5274 9.07337 13.089 9.03755C12.6389 9.00078 12.0566 9 11.2 9H7.8C6.94342 9 6.36113 9.00078 5.91104 9.03755Z" fill="currentColor"></path></svg></span></span></span></button></div><div class="code-sample-body code-sample-body-small code-sample-body-with-header"><pre class="hljs syntax-highlighter dark-mode code-sample-pre"><code class="language-json" style="white-space: pre;"><code style="float: left; padding-right: 10px;"><span class="react-syntax-highlighter-line-number">1
</span><span class="react-syntax-highlighter-line-number">2
</span><span class="react-syntax-highlighter-line-number">3
</span><span class="react-syntax-highlighter-line-number">4
</span><span class="react-syntax-highlighter-line-number">5
</span><span class="react-syntax-highlighter-line-number">6
</span><span class="react-syntax-highlighter-line-number">7
</span><span class="react-syntax-highlighter-line-number">8
</span><span class="react-syntax-highlighter-line-number">9
</span><span class="react-syntax-highlighter-line-number">10
</span><span class="react-syntax-highlighter-line-number">11
</span><span class="react-syntax-highlighter-line-number">12
</span><span class="react-syntax-highlighter-line-number">13
</span><span class="react-syntax-highlighter-line-number">14
</span><span class="react-syntax-highlighter-line-number">15
</span><span class="react-syntax-highlighter-line-number">16
</span><span class="react-syntax-highlighter-line-number">17
</span><span class="react-syntax-highlighter-line-number">18
</span><span class="react-syntax-highlighter-line-number">19
</span><span class="react-syntax-highlighter-line-number">20
</span><span class="react-syntax-highlighter-line-number">21
</span><span class="react-syntax-highlighter-line-number">22
</span><span class="react-syntax-highlighter-line-number">23
</span><span class="react-syntax-highlighter-line-number">24
</span><span class="react-syntax-highlighter-line-number">25
</span><span class="react-syntax-highlighter-line-number">26
</span><span class="react-syntax-highlighter-line-number">27
</span><span class="react-syntax-highlighter-line-number">28
</span><span class="react-syntax-highlighter-line-number">29
</span><span class="react-syntax-highlighter-line-number">30
</span><span class="react-syntax-highlighter-line-number">31
</span><span class="react-syntax-highlighter-line-number">32
</span><span class="react-syntax-highlighter-line-number">33
</span><span class="react-syntax-highlighter-line-number">34
</span><span class="react-syntax-highlighter-line-number">35
</span><span class="react-syntax-highlighter-line-number">36
</span><span class="react-syntax-highlighter-line-number">37
</span><span class="react-syntax-highlighter-line-number">38
</span><span class="react-syntax-highlighter-line-number">39
</span><span class="react-syntax-highlighter-line-number">40
</span><span class="react-syntax-highlighter-line-number">41
</span><span class="react-syntax-highlighter-line-number">42
</span><span class="react-syntax-highlighter-line-number">43
</span><span class="react-syntax-highlighter-line-number">44
</span><span class="react-syntax-highlighter-line-number">45
</span><span class="react-syntax-highlighter-line-number">46
</span><span class="react-syntax-highlighter-line-number">47
</span><span class="react-syntax-highlighter-line-number">48
</span><span class="react-syntax-highlighter-line-number">49
</span><span class="react-syntax-highlighter-line-number">50
</span><span class="react-syntax-highlighter-line-number">51
</span><span class="react-syntax-highlighter-line-number">52
</span><span class="react-syntax-highlighter-line-number">53
</span><span class="react-syntax-highlighter-line-number">54
</span><span class="react-syntax-highlighter-line-number">55
</span><span class="react-syntax-highlighter-line-number">56
</span></code><span><span>{
</span></span><span><span>  </span><span class="hljs-attr">"id"</span><span>: </span><span class="hljs-string">"resp_67ccd3a9da748190baa7f1570fe91ac604becb25c45c1d41"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"object"</span><span>: </span><span class="hljs-string">"response"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"created_at"</span><span>: </span><span class="hljs-number">1741476777</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"status"</span><span>: </span><span class="hljs-string">"completed"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"error"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"incomplete_details"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"instructions"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"max_output_tokens"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"model"</span><span>: </span><span class="hljs-string">"gpt-4o-2024-08-06"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"output"</span><span>: [
</span></span><span>    {
</span><span><span>      </span><span class="hljs-attr">"type"</span><span>: </span><span class="hljs-string">"message"</span><span>,
</span></span><span><span>      </span><span class="hljs-attr">"id"</span><span>: </span><span class="hljs-string">"msg_67ccd3acc8d48190a77525dc6de64b4104becb25c45c1d41"</span><span>,
</span></span><span><span>      </span><span class="hljs-attr">"status"</span><span>: </span><span class="hljs-string">"completed"</span><span>,
</span></span><span><span>      </span><span class="hljs-attr">"role"</span><span>: </span><span class="hljs-string">"assistant"</span><span>,
</span></span><span><span>      </span><span class="hljs-attr">"content"</span><span>: [
</span></span><span>        {
</span><span><span>          </span><span class="hljs-attr">"type"</span><span>: </span><span class="hljs-string">"output_text"</span><span>,
</span></span><span><span>          </span><span class="hljs-attr">"text"</span><span>: </span><span class="hljs-string">"The image depicts a scenic landscape with a wooden boardwalk or pathway leading through lush, green grass under a blue sky with some clouds. The setting suggests a peaceful natural area, possibly a park or nature reserve. There are trees and shrubs in the background."</span><span>,
</span></span><span><span>          </span><span class="hljs-attr">"annotations"</span><span>: []
</span></span><span>        }
</span><span>      ]
</span><span>    }
</span><span>  ],
</span><span><span>  </span><span class="hljs-attr">"parallel_tool_calls"</span><span>: </span><span class="hljs-literal">true</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"previous_response_id"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"reasoning"</span><span>: {
</span></span><span><span>    </span><span class="hljs-attr">"effort"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>    </span><span class="hljs-attr">"summary"</span><span>: </span><span class="hljs-literal">null</span><span>
</span></span><span>  },
</span><span><span>  </span><span class="hljs-attr">"store"</span><span>: </span><span class="hljs-literal">true</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"temperature"</span><span>: </span><span class="hljs-number">1</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"text"</span><span>: {
</span></span><span><span>    </span><span class="hljs-attr">"format"</span><span>: {
</span></span><span><span>      </span><span class="hljs-attr">"type"</span><span>: </span><span class="hljs-string">"text"</span><span>
</span></span><span>    }
</span><span>  },
</span><span><span>  </span><span class="hljs-attr">"tool_choice"</span><span>: </span><span class="hljs-string">"auto"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"tools"</span><span>: [],
</span></span><span><span>  </span><span class="hljs-attr">"top_p"</span><span>: </span><span class="hljs-number">1</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"truncation"</span><span>: </span><span class="hljs-string">"disabled"</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"usage"</span><span>: {
</span></span><span><span>    </span><span class="hljs-attr">"input_tokens"</span><span>: </span><span class="hljs-number">328</span><span>,
</span></span><span><span>    </span><span class="hljs-attr">"input_tokens_details"</span><span>: {
</span></span><span><span>      </span><span class="hljs-attr">"cached_tokens"</span><span>: </span><span class="hljs-number">0</span><span>
</span></span><span>    },
</span><span><span>    </span><span class="hljs-attr">"output_tokens"</span><span>: </span><span class="hljs-number">52</span><span>,
</span></span><span><span>    </span><span class="hljs-attr">"output_tokens_details"</span><span>: {
</span></span><span><span>      </span><span class="hljs-attr">"reasoning_tokens"</span><span>: </span><span class="hljs-number">0</span><span>
</span></span><span>    },
</span><span><span>    </span><span class="hljs-attr">"total_tokens"</span><span>: </span><span class="hljs-number">380</span><span>
</span></span><span>  },
</span><span><span>  </span><span class="hljs-attr">"user"</span><span>: </span><span class="hljs-literal">null</span><span>,
</span></span><span><span>  </span><span class="hljs-attr">"metadata"</span><span>: {}
</span></span><span>}</span></code></pre></div></div></div></div></div></div>

# example

curl https://api.openai.com/v1/responses \
 -H "Content-Type: application/json" \
 -H "Authorization: Bearer $OPENAI_API_KEY" \
 -d '{
"model": "gpt-4.1",
"stream": true, "input": "Tell me a three sentence bedtime story about a unicorn."
}'

event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_0368dd025caa001800690e14faf7ac81a3bcc22844343fdb79","object":"response","created_at":1762530554,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-4.1-2025-04-14","output":[],"parallel_tool_calls":true,"previous_response_id":null,"prompt_cache_key":null,"prompt_cache_retention":null,"reasoning":{"effort":null,"summary":null},"safety_identifier":null,"service_tier":"auto","store":true,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tools":[],"top_logprobs":0,"top_p":1.0,"truncation":"disabled","usage":null,"user":null,"metadata":{}}}

event: response.in_progress
data: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_0368dd025caa001800690e14faf7ac81a3bcc22844343fdb79","object":"response","created_at":1762530554,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-4.1-2025-04-14","output":[],"parallel_tool_calls":true,"previous_response_id":null,"prompt_cache_key":null,"prompt_cache_retention":null,"reasoning":{"effort":null,"summary":null},"safety_identifier":null,"service_tier":"auto","store":true,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tools":[],"top_logprobs":0,"top_p":1.0,"truncation":"disabled","usage":null,"user":null,"metadata":{}}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","type":"message","status":"in_progress","content":[],"role":"assistant"}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":3,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":"In","logprobs":[],"obfuscation":"XPpKpkf1g1Hujq"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":5,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"O9JxCXtSko8RgQ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":6,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" magical","logprobs":[],"obfuscation":"01C9miZj"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":7,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" forest","logprobs":[],"obfuscation":"lLr92T8kF"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":8,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":",","logprobs":[],"obfuscation":"UJsWDVOi2xlrlgp"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":9,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"57pPZQhH8d41Jk"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":10,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" gentle","logprobs":[],"obfuscation":"jdiEqfpmX"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":11,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" unicorn","logprobs":[],"obfuscation":"taQt0tkV"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":12,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" named","logprobs":[],"obfuscation":"jAHW7P0v4j"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":13,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" Luna","logprobs":[],"obfuscation":"moAOSggBn2o"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":14,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" found","logprobs":[],"obfuscation":"6QzPq4RHhi"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":15,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"W442CRhoN2bcWl"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":16,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" glowing","logprobs":[],"obfuscation":"7VgJk4ba"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":17,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":",","logprobs":[],"obfuscation":"byJlxavulFroRuH"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":18,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" lost","logprobs":[],"obfuscation":"ffZfmwPkFSi"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":19,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" star","logprobs":[],"obfuscation":"Buy8nU0HGmF"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":20,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":".","logprobs":[],"obfuscation":"IJJI2WuPfoPE7dd"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":21,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" She","logprobs":[],"obfuscation":"DMLzwtccD3UF"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":22,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" le","logprobs":[],"obfuscation":"vvagWAEuDIWjf"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":23,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":"apt","logprobs":[],"obfuscation":"flGdHh1nCodea"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":24,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" high","logprobs":[],"obfuscation":"mlMf9CfVwfP"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":25,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" and","logprobs":[],"obfuscation":"N8mAcP9K5rjU"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":26,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" carried","logprobs":[],"obfuscation":"lSQ6cGxY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":27,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"fLo3NGGFuOFC"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":28,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" star","logprobs":[],"obfuscation":"XGNZYDLtGq1"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":29,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" back","logprobs":[],"obfuscation":"EgrR6g2kGnI"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":30,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" to","logprobs":[],"obfuscation":"Vw1mTtdz77jaI"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":31,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"g44DJZdxc3na"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":32,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" night","logprobs":[],"obfuscation":"XTbciy5jmQ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":33,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" sky","logprobs":[],"obfuscation":"QOPfAYZSVdkt"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":34,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":",","logprobs":[],"obfuscation":"cUbGP4bYGL8bx4W"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":35,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" where","logprobs":[],"obfuscation":"a01AzgJEzg"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":36,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" it","logprobs":[],"obfuscation":"h8Lo4nrUHwL0e"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":37,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" tw","logprobs":[],"obfuscation":"D2SKx9sxX2Rxx"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":38,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":"ink","logprobs":[],"obfuscation":"MDaa8FdW8Ende"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":39,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":"led","logprobs":[],"obfuscation":"cw2lKgmXMp9As"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":40,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" with","logprobs":[],"obfuscation":"DzZ73gRsGUp"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":41,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" happiness","logprobs":[],"obfuscation":"QoCxSh"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":42,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":".","logprobs":[],"obfuscation":"vxi6sTx23fFMuB6"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":43,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" The","logprobs":[],"obfuscation":"si91sdJEVuwo"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":44,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" forest","logprobs":[],"obfuscation":"fl5yaga5u"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":45,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" spark","logprobs":[],"obfuscation":"mRbLBqLw6t"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":46,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":"led","logprobs":[],"obfuscation":"hDUCjhdmGFfku"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":47,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" with","logprobs":[],"obfuscation":"UKUaOhOlFH3"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":48,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" moon","logprobs":[],"obfuscation":"bfdanoEyT6Q"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":49,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":"light","logprobs":[],"obfuscation":"5guVhpdF9d4"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":50,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":",","logprobs":[],"obfuscation":"2LVMo9QeQhcUhea"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":51,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" and","logprobs":[],"obfuscation":"b60mH6SjkZwI"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":52,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" Luna","logprobs":[],"obfuscation":"xJIsujeEeNA"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":53,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" drift","logprobs":[],"obfuscation":"iH06QaxYIw"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":54,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":"ed","logprobs":[],"obfuscation":"UBX7ChK6RAbiao"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":55,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" to","logprobs":[],"obfuscation":"oq5jrhSjW5fcR"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":56,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" sleep","logprobs":[],"obfuscation":"dRenorGP53"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":57,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":",","logprobs":[],"obfuscation":"iFYTUBV0dRcc4Mi"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":58,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" knowing","logprobs":[],"obfuscation":"Q3XW2Lih"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":59,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" she'd","logprobs":[],"obfuscation":"fkBCGszybm"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":60,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" brought","logprobs":[],"obfuscation":"wGchNjxK"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":61,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" sweet","logprobs":[],"obfuscation":"jrTeLX9Nnb"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":62,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" dreams","logprobs":[],"obfuscation":"UjeDADYBW"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":63,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" to","logprobs":[],"obfuscation":"yDswXrBFuZk2D"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":64,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":" everyone","logprobs":[],"obfuscation":"DSS4gEE"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":65,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"delta":".","logprobs":[],"obfuscation":"iVGhaiKMD0nM9pu"}

event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":66,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"text":"In a magical forest, a gentle unicorn named Luna found a glowing, lost star. She leapt high and carried the star back to the night sky, where it twinkled with happiness. The forest sparkled with moonlight, and Luna drifted to sleep, knowing she'd brought sweet dreams to everyone.","logprobs":[]}

event: response.content_part.done
data: {"type":"response.content_part.done","sequence_number":67,"item_id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","output_index":0,"content_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"In a magical forest, a gentle unicorn named Luna found a glowing, lost star. She leapt high and carried the star back to the night sky, where it twinkled with happiness. The forest sparkled with moonlight, and Luna drifted to sleep, knowing she'd brought sweet dreams to everyone."}}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":68,"output_index":0,"item":{"id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"In a magical forest, a gentle unicorn named Luna found a glowing, lost star. She leapt high and carried the star back to the night sky, where it twinkled with happiness. The forest sparkled with moonlight, and Luna drifted to sleep, knowing she'd brought sweet dreams to everyone."}],"role":"assistant"}}

event: response.completed
data: {"type":"response.completed","sequence_number":69,"response":{"id":"resp_0368dd025caa001800690e14faf7ac81a3bcc22844343fdb79","object":"response","created_at":1762530554,"status":"completed","background":false,"error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-4.1-2025-04-14","output":[{"id":"msg_0368dd025caa001800690e14fbcfa481a382a0ab7b5367debb","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"In a magical forest, a gentle unicorn named Luna found a glowing, lost star. She leapt high and carried the star back to the night sky, where it twinkled with happiness. The forest sparkled with moonlight, and Luna drifted to sleep, knowing she'd brought sweet dreams to everyone."}],"role":"assistant"}],"parallel_tool_calls":true,"previous_response_id":null,"prompt_cache_key":null,"prompt_cache_retention":null,"reasoning":{"effort":null,"summary":null},"safety_identifier":null,"service_tier":"default","store":true,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tools":[],"top_logprobs":0,"top_p":1.0,"truncation":"disabled","usage":{"input_tokens":18,"input_tokens_details":{"cached_tokens":0},"output_tokens":63,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":81},"user":null,"metadata":{}}}

# example 2

curl https://api.openai.com/v1/responses \
 -H "Content-Type: application/json" \
 -H "Authorization: Bearer $OPENAI_API_KEY" \
 -d '{
"model": "gpt-4.1",
"input": "What is the weather like in Boston today?",
"tools": [
{
"type": "function",
"name": "get_current_weather",
"description": "Get the current weather in a given location",
"parameters": {
"type": "object",
"properties": {
"location": {
"type": "string",
"description": "The city and state, e.g. San Francisco, CA"
},
"unit": {
"type": "string",
"enum": ["celsius", "fahrenheit"]
}
},
"required": ["location", "unit"]
}
}
],
"tool_choice": "auto",
"stream": true }'

event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_00ee1d2e5321b4ac00690e15473d38819e9d545ea757cbfef8","object":"response","created_at":1762530631,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-4.1-2025-04-14","output":[],"parallel_tool_calls":true,"previous_response_id":null,"prompt_cache_key":null,"prompt_cache_retention":null,"reasoning":{"effort":null,"summary":null},"safety_identifier":null,"service_tier":"auto","store":true,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tools":[{"type":"function","description":"Get the current weather in a given location","name":"get_current_weather","parameters":{"type":"object","properties":{"location":{"type":"string","description":"The city and state, e.g. San Francisco, CA"},"unit":{"type":"string","enum":["celsius","fahrenheit"]}},"required":["location","unit"],"additionalProperties":false},"strict":true}],"top_logprobs":0,"top_p":1.0,"truncation":"disabled","usage":null,"user":null,"metadata":{}}}

event: response.in_progress
data: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_00ee1d2e5321b4ac00690e15473d38819e9d545ea757cbfef8","object":"response","created_at":1762530631,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-4.1-2025-04-14","output":[],"parallel_tool_calls":true,"previous_response_id":null,"prompt_cache_key":null,"prompt_cache_retention":null,"reasoning":{"effort":null,"summary":null},"safety_identifier":null,"service_tier":"auto","store":true,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tools":[{"type":"function","description":"Get the current weather in a given location","name":"get_current_weather","parameters":{"type":"object","properties":{"location":{"type":"string","description":"The city and state, e.g. San Francisco, CA"},"unit":{"type":"string","enum":["celsius","fahrenheit"]}},"required":["location","unit"],"additionalProperties":false},"strict":true}],"top_logprobs":0,"top_p":1.0,"truncation":"disabled","usage":null,"user":null,"metadata":{}}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","type":"function_call","status":"in_progress","arguments":"","call_id":"call_Y4U2twUkcJxwn6RqWDlEbboX","name":"get_current_weather"}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"{\"","obfuscation":"dckgXVXBj8JGGm"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"location","obfuscation":"GZd1gR9o"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":5,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"\":\"","obfuscation":"bS7WxBzRlqhNX"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":6,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"Boston","obfuscation":"9CodaU5oZX"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":7,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":",","obfuscation":"4mi8RpedWk5a1xO"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":8,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":" MA","obfuscation":"KWBkSP0d5uAtb"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":9,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"\",\"","obfuscation":"xb4aXJ67RThbS"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":10,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"unit","obfuscation":"l3WFgTYnDhpR"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":11,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"\":\"","obfuscation":"RHHJcYBCkP8kl"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":12,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"c","obfuscation":"HVR7qmpsArk2ahf"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":13,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"elsius","obfuscation":"eplfVjOcGR"}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":14,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"delta":"\"}","obfuscation":"7oQxmp7Dgmah1M"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","sequence_number":15,"item_id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","output_index":0,"arguments":"{\"location\":\"Boston, MA\",\"unit\":\"celsius\"}"}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":16,"output_index":0,"item":{"id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","type":"function_call","status":"completed","arguments":"{\"location\":\"Boston, MA\",\"unit\":\"celsius\"}","call_id":"call_Y4U2twUkcJxwn6RqWDlEbboX","name":"get_current_weather"}}

event: response.completed
data: {"type":"response.completed","sequence_number":17,"response":{"id":"resp_00ee1d2e5321b4ac00690e15473d38819e9d545ea757cbfef8","object":"response","created_at":1762530631,"status":"completed","background":false,"error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-4.1-2025-04-14","output":[{"id":"fc_00ee1d2e5321b4ac00690e15483ff8819e8245d3f6f0ba9fa0","type":"function_call","status":"completed","arguments":"{\"location\":\"Boston, MA\",\"unit\":\"celsius\"}","call_id":"call_Y4U2twUkcJxwn6RqWDlEbboX","name":"get_current_weather"}],"parallel_tool_calls":true,"previous_response_id":null,"prompt_cache_key":null,"prompt_cache_retention":null,"reasoning":{"effort":null,"summary":null},"safety_identifier":null,"service_tier":"default","store":true,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tools":[{"type":"function","description":"Get the current weather in a given location","name":"get_current_weather","parameters":{"type":"object","properties":{"location":{"type":"string","description":"The city and state, e.g. San Francisco, CA"},"unit":{"type":"string","enum":["celsius","fahrenheit"]}},"required":["location","unit"],"additionalProperties":false},"strict":true}],"top_logprobs":0,"top_p":1.0,"truncation":"disabled","usage":{"input_tokens":75,"input_tokens_details":{"cached_tokens":0},"output_tokens":23,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":98},"user":null,"metadata":{}}}

# example 3

% curl https://api.openai.com/v1/responses \
 -H "Content-Type: application/json" \
 -H "Authorization: Bearer $OPENAI_API_KEY" \
 -d '{
"model": "gpt-4.1",
"tools": [{ "type": "web_search_preview" }],
"input": "What was a positive news story from today?", "stream": true
}'

event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_0095dcb3c4d9653000690e3af0147c8191899e226c94052d44","object":"response","created_at":1762540272,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-4.1-2025-04-14","output":[],"parallel_tool_calls":true,"previous_response_id":null,"prompt_cache_key":null,"prompt_cache_retention":null,"reasoning":{"effort":null,"summary":null},"safety_identifier":null,"service_tier":"auto","store":true,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tools":[{"type":"web_search_preview","search_context_size":"medium","user_location":{"type":"approximate","city":null,"country":"US","region":null,"timezone":null}}],"top_logprobs":0,"top_p":1.0,"truncation":"disabled","usage":null,"user":null,"metadata":{}}}

event: response.in_progress
data: {"type":"response.in_progress","sequence_number":1,"response":{"id":"resp_0095dcb3c4d9653000690e3af0147c8191899e226c94052d44","object":"response","created_at":1762540272,"status":"in_progress","background":false,"error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-4.1-2025-04-14","output":[],"parallel_tool_calls":true,"previous_response_id":null,"prompt_cache_key":null,"prompt_cache_retention":null,"reasoning":{"effort":null,"summary":null},"safety_identifier":null,"service_tier":"auto","store":true,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tools":[{"type":"web_search_preview","search_context_size":"medium","user_location":{"type":"approximate","city":null,"country":"US","region":null,"timezone":null}}],"top_logprobs":0,"top_p":1.0,"truncation":"disabled","usage":null,"user":null,"metadata":{}}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"ws_0095dcb3c4d9653000690e3af0d25081918b765ea961fc7466","type":"web_search_call","status":"in_progress","action":{"type":"search"}}}

event: response.web_search_call.in_progress
data: {"type":"response.web_search_call.in_progress","sequence_number":3,"output_index":0,"item_id":"ws_0095dcb3c4d9653000690e3af0d25081918b765ea961fc7466"}

event: response.web_search_call.searching
data: {"type":"response.web_search_call.searching","sequence_number":4,"output_index":0,"item_id":"ws_0095dcb3c4d9653000690e3af0d25081918b765ea961fc7466"}

event: response.web_search_call.completed
data: {"type":"response.web_search_call.completed","sequence_number":5,"output_index":0,"item_id":"ws_0095dcb3c4d9653000690e3af0d25081918b765ea961fc7466"}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":{"id":"ws_0095dcb3c4d9653000690e3af0d25081918b765ea961fc7466","type":"web_search_call","status":"completed","action":{"type":"search","query":"positive news stories today"}}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":7,"output_index":1,"item":{"id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","type":"message","status":"in_progress","content":[],"role":"assistant"}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":8,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":9,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"On","logprobs":[],"obfuscation":"0c64CtZun3nwdL"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":10,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" November","logprobs":[],"obfuscation":"rkFcQ01"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":11,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"sufB6xEaTK7sdf3"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":12,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"7","logprobs":[],"obfuscation":"3gRdylLpW43QtXn"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":13,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"3saxOdEE0G9zT3J"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":14,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"Rfas4MuEqmcZ2vb"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":15,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"202","logprobs":[],"obfuscation":"9ROoQNqv735ac"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":16,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"5","logprobs":[],"obfuscation":"a3hy807M13LFlDQ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":17,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"Oo4YAWxFwMocFmz"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":18,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" several","logprobs":[],"obfuscation":"45sbxcCY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":19,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" uplifting","logprobs":[],"obfuscation":"O7fwt4"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":20,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" news","logprobs":[],"obfuscation":"EvOMJK47zgU"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":21,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" stories","logprobs":[],"obfuscation":"GlkAVJA2"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":22,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" emerged","logprobs":[],"obfuscation":"e096PpRW"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":23,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":":","logprobs":[],"obfuscation":"KzT1kHFcVfAx86h"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":24,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\n\n\*\*","logprobs":[],"obfuscation":"GmjDN9MQUjey"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":25,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"Environmental","logprobs":[],"obfuscation":"5Qc"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":26,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Restoration","logprobs":[],"obfuscation":"PXAL"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":27,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" in","logprobs":[],"obfuscation":"g7psETEpWhJhI"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":28,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Brazil","logprobs":[],"obfuscation":"rcq2MBCbl"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":29,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\*\*","logprobs":[],"obfuscation":"ipZJ3vhxgxcGfN"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":30,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\n\nThe","logprobs":[],"obfuscation":"NQ7WIRG7Q9E"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":31,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Brazilian","logprobs":[],"obfuscation":"10hZSI"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":32,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" company","logprobs":[],"obfuscation":"WW8ILCiy"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":33,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" re","logprobs":[],"obfuscation":"I92ijuHM3M3gY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":34,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".green","logprobs":[],"obfuscation":"OyJ8wWi7OC"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":35,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" was","logprobs":[],"obfuscation":"sQmhKAJc73dv"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":36,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" awarded","logprobs":[],"obfuscation":"HWswrwNF"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":37,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"g4fswi7BRNS8"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":38,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Earth","logprobs":[],"obfuscation":"4qfLOGTrEr"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":39,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"shot","logprobs":[],"obfuscation":"kCFlb3qWkaLE"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":40,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Prize","logprobs":[],"obfuscation":"cdT8FgPIzo"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":41,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" for","logprobs":[],"obfuscation":"TMBBkfOVxYk6"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":42,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" its","logprobs":[],"obfuscation":"ZFGDmJnJu45n"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":43,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" innovative","logprobs":[],"obfuscation":"1xfGO"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":44,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" use","logprobs":[],"obfuscation":"bfwzhlp9QN7h"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":45,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" of","logprobs":[],"obfuscation":"00RPDWeuPfnK7"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":46,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" artificial","logprobs":[],"obfuscation":"YTlG5"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":47,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" intelligence","logprobs":[],"obfuscation":"kjy"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":48,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" and","logprobs":[],"obfuscation":"GGtlQwlmQyGb"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":49,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" satellite","logprobs":[],"obfuscation":"8tRo2L"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":50,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" data","logprobs":[],"obfuscation":"P3XyPvc9XCL"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":51,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" to","logprobs":[],"obfuscation":"498LoBQ96fjdc"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":52,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" restore","logprobs":[],"obfuscation":"4YmSk8Zk"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":53,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"pFLqr64IrH4M"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":54,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Atlantic","logprobs":[],"obfuscation":"T03ckkQ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":55,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Forest","logprobs":[],"obfuscation":"iyoOXK01P"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":56,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"RoIB6rFURBDlele"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":57,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"O7ztTQdMhrHnS7b"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":58,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"Their","logprobs":[],"obfuscation":"k9MjQMrX1u5"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":59,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" efforts","logprobs":[],"obfuscation":"HDhMPDCm"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":60,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" have","logprobs":[],"obfuscation":"nl8XDIXcmLW"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":61,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" led","logprobs":[],"obfuscation":"N4d6d8HGXxeO"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":62,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" to","logprobs":[],"obfuscation":"BRr4qHl3H1zni"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":63,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"cpb3sOSyt06I"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":64,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" planting","logprobs":[],"obfuscation":"cM6c6Mg"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":65,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" of","logprobs":[],"obfuscation":"YwFHqXYYhJhww"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":66,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" millions","logprobs":[],"obfuscation":"Boep4Ho"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":67,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" of","logprobs":[],"obfuscation":"muiKgweNKBJBy"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":68,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" trees","logprobs":[],"obfuscation":"0JGxXZ3lCT"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":69,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"ixZiNcAUOBNmD89"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":70,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"MfX9KSAn0JXQ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":71,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" creation","logprobs":[],"obfuscation":"aggx6pI"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":72,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" of","logprobs":[],"obfuscation":"LhCo7k9lDu4TI"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":73,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" numerous","logprobs":[],"obfuscation":"VSO3CRQ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":74,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" jobs","logprobs":[],"obfuscation":"6cn3f3BDLFE"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":75,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"WpfkgxWCfff0Y0p"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":76,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" and","logprobs":[],"obfuscation":"AEx3wEzW1mLH"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":77,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" significant","logprobs":[],"obfuscation":"QU0B"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":78,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" protection","logprobs":[],"obfuscation":"EXuxS"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":79,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" of","logprobs":[],"obfuscation":"r6u5dt0CpmNCH"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":80,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" biodiversity","logprobs":[],"obfuscation":"nYa"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":81,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"vVHtz1zME3S2bS1"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":82,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"7Rh8JVUqaJqV4bZ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":83,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"([en.wikipedia.org](https://en.wikipedia.org/wiki/Earthshot_Prize?utm_source=openai))","logprobs":[],"obfuscation":"7RmoPSw5S3U"}

event: response.output_text.annotation.added
data: {"type":"response.output_text.annotation.added","sequence_number":84,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"annotation_index":0,"annotation":{"type":"url_citation","end_index":488,"start_index":403,"title":"Earthshot Prize","url":"https://en.wikipedia.org/wiki/Earthshot_Prize?utm_source=openai"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":85,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\n\n\*\*","logprobs":[],"obfuscation":"Qk9RIUnuR8d1"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":86,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"Adv","logprobs":[],"obfuscation":"BWJEbo5E6KtEV"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":87,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"ancements","logprobs":[],"obfuscation":"SuE8jBD"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":88,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" in","logprobs":[],"obfuscation":"xCj83afNd8eOV"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":89,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Children's","logprobs":[],"obfuscation":"MZ1Of"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":90,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Health","logprobs":[],"obfuscation":"y5GVwSYXd"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":91,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" in","logprobs":[],"obfuscation":"HzDaslGXHF3qy"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":92,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Finland","logprobs":[],"obfuscation":"fL0rB5qX"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":93,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\*\*","logprobs":[],"obfuscation":"J2GQbzvF1G9SwD"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":94,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\n\nIn","logprobs":[],"obfuscation":"PWd375q1XKxP"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":95,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Finland","logprobs":[],"obfuscation":"19bfYtyw"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":96,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"fOzfIDaKU9DJdJt"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":97,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"2fnZwkVf5jnasD"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":98,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" daycare","logprobs":[],"obfuscation":"Za5N1p1a"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":99,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" center","logprobs":[],"obfuscation":"tgw4QFJKw"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":100,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" replaced","logprobs":[],"obfuscation":"yO23dQH"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":101,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" its","logprobs":[],"obfuscation":"BSjEhCnjRKV9"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":102,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" traditional","logprobs":[],"obfuscation":"BU9r"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":103,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" playground","logprobs":[],"obfuscation":"8Asuc"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":104,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" with","logprobs":[],"obfuscation":"EWqHkxmMN9a"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":105,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"1kd5TnvOLdPtDB"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":106,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" patch","logprobs":[],"obfuscation":"bAupJzR53R"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":107,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" of","logprobs":[],"obfuscation":"XFdnVz8w95fkH"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":108,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" wild","logprobs":[],"obfuscation":"5PvBGvRhm8A"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":109,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" forest","logprobs":[],"obfuscation":"9SUu5tosZ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":110,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" floor","logprobs":[],"obfuscation":"AGvdEP6fix"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":111,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"myW8MAULzulRvJ2"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":112,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" resulting","logprobs":[],"obfuscation":"Z2Oq7A"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":113,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" in","logprobs":[],"obfuscation":"6R5hom71Yhw2L"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":114,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" improved","logprobs":[],"obfuscation":"3ZcFPRW"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":115,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" health","logprobs":[],"obfuscation":"suEDKW9AO"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":116,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" among","logprobs":[],"obfuscation":"BWLbqemeDA"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":117,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" children","logprobs":[],"obfuscation":"qKQyZm8"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":118,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"rSAgTfvx79Xgfgh"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":119,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"7ZdZkwOqvtgr7sZ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":120,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"The","logprobs":[],"obfuscation":"NQRTnDjJeRDVw"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":121,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" initiative","logprobs":[],"obfuscation":"6lNhM"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":122,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" led","logprobs":[],"obfuscation":"CcOyObVc1cbk"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":123,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" to","logprobs":[],"obfuscation":"VIYf1RIRhYX8D"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":124,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" stronger","logprobs":[],"obfuscation":"26PTops"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":125,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" immune","logprobs":[],"obfuscation":"lkNVYjH4A"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":126,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" systems","logprobs":[],"obfuscation":"IX4Nrkdf"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":127,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" and","logprobs":[],"obfuscation":"40ZvYG1CM3PR"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":128,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"5f4G02ks0GVQO9"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":129,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" decrease","logprobs":[],"obfuscation":"sz1tlVf"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":130,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" in","logprobs":[],"obfuscation":"xcKh2tDRPJlMv"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":131,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" allergies","logprobs":[],"obfuscation":"B3gh3V"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":132,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"Yq6PhsiJb9YxR4R"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":133,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" highlighting","logprobs":[],"obfuscation":"Jvz"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":134,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"TsWXmwMvlsfa"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":135,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" benefits","logprobs":[],"obfuscation":"j85HLdJ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":136,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" of","logprobs":[],"obfuscation":"UqCT1W1QXripq"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":137,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" natural","logprobs":[],"obfuscation":"sGu40aHh"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":138,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" environments","logprobs":[],"obfuscation":"LxP"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":139,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" for","logprobs":[],"obfuscation":"Ayu0v6aRWrUN"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":140,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" child","logprobs":[],"obfuscation":"FGfmVo7FWF"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":141,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" development","logprobs":[],"obfuscation":"YBHw"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":142,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"nFaIUczihqBnWew"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":143,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"53X9R4idB02lh6s"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":144,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))","logprobs":[],"obfuscation":"mC9WgFgEMu5B4a"}

event: response.output_text.annotation.added
data: {"type":"response.output_text.annotation.added","sequence_number":145,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"annotation_index":1,"annotation":{"type":"url_citation","end_index":947,"start_index":833,"title":"Good News Friday — 7th November 2025 | by Paddy Murphy | Mind Yourself | Nov, 2025 | Medium","url":"https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":146,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\n\n\*\*","logprobs":[],"obfuscation":"XtIoPSRsDd4O"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":147,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"Innov","logprobs":[],"obfuscation":"nzhTMgGMJa9"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":148,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"ative","logprobs":[],"obfuscation":"9IjUllTAnY1"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":149,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Music","logprobs":[],"obfuscation":"GvUg5k9VOr"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":150,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Project","logprobs":[],"obfuscation":"bAFjRU5i"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":151,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" in","logprobs":[],"obfuscation":"HYyGxrAUeX2Y0"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":152,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" England","logprobs":[],"obfuscation":"BFVeuV2W"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":153,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\*\*","logprobs":[],"obfuscation":"gs81ldAa0FJ4VY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":154,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\n\nIn","logprobs":[],"obfuscation":"jy8G4nAn0zK2"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":155,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" England","logprobs":[],"obfuscation":"otD1igQ6"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":156,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"59ijCkTTVpdv0OB"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":157,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"nWOznNRQBSr5"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":158,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" \"","logprobs":[],"obfuscation":"Q7f7zbJ9dZTlbr"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":159,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"B","logprobs":[],"obfuscation":"rjcvgR1QusYdK8K"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":160,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"ionic","logprobs":[],"obfuscation":"NpAXaPSX8BE"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":161,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" and","logprobs":[],"obfuscation":"5PBQKYtUf6Av"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":162,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"D7wClbN365Mu"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":163,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" W","logprobs":[],"obfuscation":"0ODVTLA2etqTg4"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":164,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"ires","logprobs":[],"obfuscation":"QNCKONjSxOts"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":165,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\"","logprobs":[],"obfuscation":"kyp7bVaaWgWqdc3"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":166,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" project","logprobs":[],"obfuscation":"2uMb3JEI"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":167,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" showcased","logprobs":[],"obfuscation":"mArE3E"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":168,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" mushrooms","logprobs":[],"obfuscation":"upOUm8"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":169,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" creating","logprobs":[],"obfuscation":"DMM83rn"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":170,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" music","logprobs":[],"obfuscation":"HqSngclTcH"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":171,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" through","logprobs":[],"obfuscation":"S8rBc7wL"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":172,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" robotic","logprobs":[],"obfuscation":"0blMF8Hb"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":173,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" limbs","logprobs":[],"obfuscation":"XH7o2W4AgY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":174,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" that","logprobs":[],"obfuscation":"QlR6A8UsamU"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":175,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" translate","logprobs":[],"obfuscation":"M6l5R4"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":176,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" their","logprobs":[],"obfuscation":"ZRQ1mG9v4P"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":177,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" bio","logprobs":[],"obfuscation":"bamA9AppTsyL"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":178,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"electric","logprobs":[],"obfuscation":"F8gBlrsg"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":179,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" signals","logprobs":[],"obfuscation":"6SJT3hye"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":180,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" into","logprobs":[],"obfuscation":"2VXgRtRS4mY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":181,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" movement","logprobs":[],"obfuscation":"mWk9Va4"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":182,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"UrD5s6wsIegvDAY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":183,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"r74jFdXbgbXEVAs"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":184,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"This","logprobs":[],"obfuscation":"m5iWhAvIZe7f"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":185,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" unique","logprobs":[],"obfuscation":"8OqFsY8Qs"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":186,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" collaboration","logprobs":[],"obfuscation":"qT"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":187,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" between","logprobs":[],"obfuscation":"8pySuUTW"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":188,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" nature","logprobs":[],"obfuscation":"CmasiwlVj"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":189,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" and","logprobs":[],"obfuscation":"pe7QeZoJVs0Z"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":190,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" technology","logprobs":[],"obfuscation":"RZsiT"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":191,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" offers","logprobs":[],"obfuscation":"Jqf87OOtn"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":192,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"DrboelETEu1qsR"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":193,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" fresh","logprobs":[],"obfuscation":"RWF36a53ua"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":194,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" perspective","logprobs":[],"obfuscation":"JrOh"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":195,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" on","logprobs":[],"obfuscation":"k8wsiJwBY3rho"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":196,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"Whlr63o0yd59"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":197,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" hidden","logprobs":[],"obfuscation":"WsblNAYQz"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":198,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" intelligence","logprobs":[],"obfuscation":"NXO"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":199,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" of","logprobs":[],"obfuscation":"XcLMWuICCKVof"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":200,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"OOmOTyvdULbf"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":201,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" natural","logprobs":[],"obfuscation":"VlAatD7p"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":202,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" world","logprobs":[],"obfuscation":"P1Q4Z4aPMf"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":203,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"WSuoo2PRH3wkNvX"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":204,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"7AQiCPWhpPIe7dZ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":205,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))","logprobs":[],"obfuscation":"2P7ErZWPHYuhVv"}

event: response.output_text.annotation.added
data: {"type":"response.output_text.annotation.added","sequence_number":206,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"annotation_index":2,"annotation":{"type":"url_citation","end_index":1396,"start_index":1282,"title":"Good News Friday — 7th November 2025 | by Paddy Murphy | Mind Yourself | Nov, 2025 | Medium","url":"https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":207,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\n\n\*\*","logprobs":[],"obfuscation":"3bmBj4NC0Mm2"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":208,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"Ad","logprobs":[],"obfuscation":"TL3bscJEux6DBF"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":209,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"option","logprobs":[],"obfuscation":"OFMbhr83KR"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":210,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Success","logprobs":[],"obfuscation":"11txOz2h"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":211,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" in","logprobs":[],"obfuscation":"qaCoHxVYQa8bP"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":212,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Riverside","logprobs":[],"obfuscation":"3L7Uph"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":213,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"C9IQqrbypXqnSsc"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":214,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" California","logprobs":[],"obfuscation":"8kdxc"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":215,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\*\*","logprobs":[],"obfuscation":"mQb29ezMp94rLw"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":216,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\n\nIn","logprobs":[],"obfuscation":"BXfAFf5neCjs"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":217,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Riverside","logprobs":[],"obfuscation":"kX3CFB"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":218,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"CSX6zLvdhlzG29s"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":219,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" California","logprobs":[],"obfuscation":"nr5Jw"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":220,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"36ZUs5kUcZRIWzC"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":221,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"CJsgbIVkHLxk"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":222,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Mary","logprobs":[],"obfuscation":"KcviLua3yS4"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":223,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" S","logprobs":[],"obfuscation":"IeN5hCsJoEYJ4A"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":224,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"PxbFA1mR7XzEKqK"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":225,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Roberts","logprobs":[],"obfuscation":"PwrRtF9p"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":226,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Pet","logprobs":[],"obfuscation":"LAWJZwdgjO0s"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":227,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Adoption","logprobs":[],"obfuscation":"riev2Rw"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":228,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Center","logprobs":[],"obfuscation":"OrPjvv3Xp"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":229,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" celebrated","logprobs":[],"obfuscation":"YPAbG"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":230,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" the","logprobs":[],"obfuscation":"pVWfDhzN8r7K"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":231,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" adoption","logprobs":[],"obfuscation":"AwdrM6c"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":232,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" of","logprobs":[],"obfuscation":"gi7RsKMy066zv"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":233,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"KhhtGjRply4vBL"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":234,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" dog","logprobs":[],"obfuscation":"mRMLlVGdgIVE"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":235,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" named","logprobs":[],"obfuscation":"jmN24VHrrU"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":236,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Button","logprobs":[],"obfuscation":"tmXO4aGpi"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":237,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"VunCjgXvbxQp5xn"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":238,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"HNu5bclxDwGCZCZ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":239,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"Additionally","logprobs":[],"obfuscation":"jrOI"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":240,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"qVK3QnS3PC5CyaY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":241,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" Bal","logprobs":[],"obfuscation":"4w5kBZ9dtHwH"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":242,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"to","logprobs":[],"obfuscation":"6W4UFPSWZO0eno"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":243,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"q7cNAgoIhCC9yaO"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":244,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"gBFS8tSLdiSVh0"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":245,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" playful","logprobs":[],"obfuscation":"OybkH2cc"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":246,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" and","logprobs":[],"obfuscation":"2ruUOZ7HSHGR"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":247,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" friendly","logprobs":[],"obfuscation":"KO0ioXo"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":248,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"JE7Ol1KhH2QuBaj"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":249,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"3","logprobs":[],"obfuscation":"2xoZGCcKX6UGGiO"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":250,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"-year","logprobs":[],"obfuscation":"jRyoAnnC5PL"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":251,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"-old","logprobs":[],"obfuscation":"zNnxKwdTFHvL"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":252,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" dog","logprobs":[],"obfuscation":"JGgP94y0kqRY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":253,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"VAcbhrWorpPpHJW"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":254,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" is","logprobs":[],"obfuscation":"1AcT4YSvqUCGA"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":255,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" available","logprobs":[],"obfuscation":"wXqN8v"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":256,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" for","logprobs":[],"obfuscation":"d1y15qq0XLyC"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":257,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" adoption","logprobs":[],"obfuscation":"B9oKaVL"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":258,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"qB6kHySFWechmur"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":259,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" with","logprobs":[],"obfuscation":"a84jly6A0ak"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":260,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" a","logprobs":[],"obfuscation":"6pyTQIotX22s2i"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":261,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" special","logprobs":[],"obfuscation":"Uh3PpiSZ"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":262,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" reduced","logprobs":[],"obfuscation":"u5QdwltE"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":263,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" fee","logprobs":[],"obfuscation":"2TMqDHdKJK0v"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":264,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" through","logprobs":[],"obfuscation":"IMraEKVt"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":265,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" November","logprobs":[],"obfuscation":"Z41ewwb"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":266,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"Z2HwXbAgagodY2f"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":267,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"10","logprobs":[],"obfuscation":"c5PUzfwHI6Soj4"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":268,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"OnjoAXEuWOQ14zF"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":269,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"FiBgZm87l1LWffD"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":270,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"([raincrossgazette.com](https://www.raincrossgazette.com/riverside-news-november-7-2025/?utm_source=openai))","logprobs":[],"obfuscation":"sV24"}

event: response.output_text.annotation.added
data: {"type":"response.output_text.annotation.added","sequence_number":271,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"annotation_index":3,"annotation":{"type":"url_citation","end_index":1801,"start_index":1693,"title":"🗞️ Riverside News- November 7, 2025","url":"https://www.raincrossgazette.com/riverside-news-november-7-2025/?utm_source=openai"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":272,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":"\n\nThese","logprobs":[],"obfuscation":"wA5Fue2T4"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":273,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" stories","logprobs":[],"obfuscation":"AqTfwyKi"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":274,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" highlight","logprobs":[],"obfuscation":"ijb78j"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":275,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" positive","logprobs":[],"obfuscation":"2rgcEcu"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":276,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" developments","logprobs":[],"obfuscation":"QFu"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":277,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" in","logprobs":[],"obfuscation":"J81MlRi0MPvb9"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":278,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" environmental","logprobs":[],"obfuscation":"qY"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":279,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" restoration","logprobs":[],"obfuscation":"Q4xw"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":280,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"8gAPOr43wB7GSMr"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":281,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" child","logprobs":[],"obfuscation":"Sz8eZPeqH6"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":282,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" health","logprobs":[],"obfuscation":"dFia0BIJe"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":283,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"ka7V41CM6PvoP6z"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":284,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" innovative","logprobs":[],"obfuscation":"GY4Od"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":285,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" art","logprobs":[],"obfuscation":"kyjQGGohQcYh"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":286,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":",","logprobs":[],"obfuscation":"SnZUuI2L8j5CZR1"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":287,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" and","logprobs":[],"obfuscation":"rHd8ISFXcTh3"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":288,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" animal","logprobs":[],"obfuscation":"IpPkC4IvG"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":289,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" welfare","logprobs":[],"obfuscation":"pcotwUxd"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":290,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":".","logprobs":[],"obfuscation":"LtRxglvWkqYTemR"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":291,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"delta":" ","logprobs":[],"obfuscation":"jxVGjEklTpfQEhf"}

event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":292,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"text":"On November 7, 2025, several uplifting news stories emerged:\n\n**Environmental Restoration in Brazil**\n\nThe Brazilian company re.green was awarded the Earthshot Prize for its innovative use of artificial intelligence and satellite data to restore the Atlantic Forest. Their efforts have led to the planting of millions of trees, the creation of numerous jobs, and significant protection of biodiversity. ([en.wikipedia.org](https://en.wikipedia.org/wiki/Earthshot_Prize?utm_source=openai))\n\n**Advancements in Children's Health in Finland**\n\nIn Finland, a daycare center replaced its traditional playground with a patch of wild forest floor, resulting in improved health among children. The initiative led to stronger immune systems and a decrease in allergies, highlighting the benefits of natural environments for child development. ([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))\n\n**Innovative Music Project in England**\n\nIn England, the \"Bionic and the Wires\" project showcased mushrooms creating music through robotic limbs that translate their bioelectric signals into movement. This unique collaboration between nature and technology offers a fresh perspective on the hidden intelligence of the natural world. ([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))\n\n**Adoption Success in Riverside, California**\n\nIn Riverside, California, the Mary S. Roberts Pet Adoption Center celebrated the adoption of a dog named Button. Additionally, Balto, a playful and friendly 3-year-old dog, is available for adoption, with a special reduced fee through November 10. ([raincrossgazette.com](https://www.raincrossgazette.com/riverside-news-november-7-2025/?utm_source=openai))\n\nThese stories highlight positive developments in environmental restoration, child health, innovative art, and animal welfare. ","logprobs":[]}

event: response.content_part.done
data: {"type":"response.content_part.done","sequence_number":293,"item_id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","output_index":1,"content_index":0,"part":{"type":"output_text","annotations":[{"type":"url_citation","end_index":488,"start_index":403,"title":"Earthshot Prize","url":"https://en.wikipedia.org/wiki/Earthshot_Prize?utm_source=openai"},{"type":"url_citation","end_index":947,"start_index":833,"title":"Good News Friday — 7th November 2025 | by Paddy Murphy | Mind Yourself | Nov, 2025 | Medium","url":"https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai"},{"type":"url_citation","end_index":1396,"start_index":1282,"title":"Good News Friday — 7th November 2025 | by Paddy Murphy | Mind Yourself | Nov, 2025 | Medium","url":"https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai"},{"type":"url_citation","end_index":1801,"start_index":1693,"title":"🗞️ Riverside News- November 7, 2025","url":"https://www.raincrossgazette.com/riverside-news-november-7-2025/?utm_source=openai"}],"logprobs":[],"text":"On November 7, 2025, several uplifting news stories emerged:\n\n**Environmental Restoration in Brazil**\n\nThe Brazilian company re.green was awarded the Earthshot Prize for its innovative use of artificial intelligence and satellite data to restore the Atlantic Forest. Their efforts have led to the planting of millions of trees, the creation of numerous jobs, and significant protection of biodiversity. ([en.wikipedia.org](https://en.wikipedia.org/wiki/Earthshot_Prize?utm_source=openai))\n\n**Advancements in Children's Health in Finland**\n\nIn Finland, a daycare center replaced its traditional playground with a patch of wild forest floor, resulting in improved health among children. The initiative led to stronger immune systems and a decrease in allergies, highlighting the benefits of natural environments for child development. ([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))\n\n**Innovative Music Project in England**\n\nIn England, the \"Bionic and the Wires\" project showcased mushrooms creating music through robotic limbs that translate their bioelectric signals into movement. This unique collaboration between nature and technology offers a fresh perspective on the hidden intelligence of the natural world. ([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))\n\n**Adoption Success in Riverside, California**\n\nIn Riverside, California, the Mary S. Roberts Pet Adoption Center celebrated the adoption of a dog named Button. Additionally, Balto, a playful and friendly 3-year-old dog, is available for adoption, with a special reduced fee through November 10. ([raincrossgazette.com](https://www.raincrossgazette.com/riverside-news-november-7-2025/?utm_source=openai))\n\nThese stories highlight positive developments in environmental restoration, child health, innovative art, and animal welfare. "}}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":294,"output_index":1,"item":{"id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","type":"message","status":"completed","content":[{"type":"output_text","annotations":[{"type":"url_citation","end_index":488,"start_index":403,"title":"Earthshot Prize","url":"https://en.wikipedia.org/wiki/Earthshot_Prize?utm_source=openai"},{"type":"url_citation","end_index":947,"start_index":833,"title":"Good News Friday — 7th November 2025 | by Paddy Murphy | Mind Yourself | Nov, 2025 | Medium","url":"https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai"},{"type":"url_citation","end_index":1396,"start_index":1282,"title":"Good News Friday — 7th November 2025 | by Paddy Murphy | Mind Yourself | Nov, 2025 | Medium","url":"https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai"},{"type":"url_citation","end_index":1801,"start_index":1693,"title":"🗞️ Riverside News- November 7, 2025","url":"https://www.raincrossgazette.com/riverside-news-november-7-2025/?utm_source=openai"}],"logprobs":[],"text":"On November 7, 2025, several uplifting news stories emerged:\n\n**Environmental Restoration in Brazil**\n\nThe Brazilian company re.green was awarded the Earthshot Prize for its innovative use of artificial intelligence and satellite data to restore the Atlantic Forest. Their efforts have led to the planting of millions of trees, the creation of numerous jobs, and significant protection of biodiversity. ([en.wikipedia.org](https://en.wikipedia.org/wiki/Earthshot_Prize?utm_source=openai))\n\n**Advancements in Children's Health in Finland**\n\nIn Finland, a daycare center replaced its traditional playground with a patch of wild forest floor, resulting in improved health among children. The initiative led to stronger immune systems and a decrease in allergies, highlighting the benefits of natural environments for child development. ([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))\n\n**Innovative Music Project in England**\n\nIn England, the \"Bionic and the Wires\" project showcased mushrooms creating music through robotic limbs that translate their bioelectric signals into movement. This unique collaboration between nature and technology offers a fresh perspective on the hidden intelligence of the natural world. ([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))\n\n**Adoption Success in Riverside, California**\n\nIn Riverside, California, the Mary S. Roberts Pet Adoption Center celebrated the adoption of a dog named Button. Additionally, Balto, a playful and friendly 3-year-old dog, is available for adoption, with a special reduced fee through November 10. ([raincrossgazette.com](https://www.raincrossgazette.com/riverside-news-november-7-2025/?utm_source=openai))\n\nThese stories highlight positive developments in environmental restoration, child health, innovative art, and animal welfare. "}],"role":"assistant"}}

event: response.completed
data: {"type":"response.completed","sequence_number":295,"response":{"id":"resp_0095dcb3c4d9653000690e3af0147c8191899e226c94052d44","object":"response","created_at":1762540272,"status":"completed","background":false,"error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"max_tool_calls":null,"model":"gpt-4.1-2025-04-14","output":[{"id":"ws_0095dcb3c4d9653000690e3af0d25081918b765ea961fc7466","type":"web_search_call","status":"completed","action":{"type":"search","query":"positive news stories today"}},{"id":"msg_0095dcb3c4d9653000690e3af1ec4081918ef9ec47b428101a","type":"message","status":"completed","content":[{"type":"output_text","annotations":[{"type":"url_citation","end_index":488,"start_index":403,"title":"Earthshot Prize","url":"https://en.wikipedia.org/wiki/Earthshot_Prize?utm_source=openai"},{"type":"url_citation","end_index":947,"start_index":833,"title":"Good News Friday — 7th November 2025 | by Paddy Murphy | Mind Yourself | Nov, 2025 | Medium","url":"https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai"},{"type":"url_citation","end_index":1396,"start_index":1282,"title":"Good News Friday — 7th November 2025 | by Paddy Murphy | Mind Yourself | Nov, 2025 | Medium","url":"https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai"},{"type":"url_citation","end_index":1801,"start_index":1693,"title":"🗞️ Riverside News- November 7, 2025","url":"https://www.raincrossgazette.com/riverside-news-november-7-2025/?utm_source=openai"}],"logprobs":[],"text":"On November 7, 2025, several uplifting news stories emerged:\n\n**Environmental Restoration in Brazil**\n\nThe Brazilian company re.green was awarded the Earthshot Prize for its innovative use of artificial intelligence and satellite data to restore the Atlantic Forest. Their efforts have led to the planting of millions of trees, the creation of numerous jobs, and significant protection of biodiversity. ([en.wikipedia.org](https://en.wikipedia.org/wiki/Earthshot_Prize?utm_source=openai))\n\n**Advancements in Children's Health in Finland**\n\nIn Finland, a daycare center replaced its traditional playground with a patch of wild forest floor, resulting in improved health among children. The initiative led to stronger immune systems and a decrease in allergies, highlighting the benefits of natural environments for child development. ([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))\n\n**Innovative Music Project in England**\n\nIn England, the \"Bionic and the Wires\" project showcased mushrooms creating music through robotic limbs that translate their bioelectric signals into movement. This unique collaboration between nature and technology offers a fresh perspective on the hidden intelligence of the natural world. ([medium.com](https://medium.com/mind-yourself/good-news-friday-7th-november-2025-478731be82ed?utm_source=openai))\n\n**Adoption Success in Riverside, California**\n\nIn Riverside, California, the Mary S. Roberts Pet Adoption Center celebrated the adoption of a dog named Button. Additionally, Balto, a playful and friendly 3-year-old dog, is available for adoption, with a special reduced fee through November 10. ([raincrossgazette.com](https://www.raincrossgazette.com/riverside-news-november-7-2025/?utm_source=openai))\n\nThese stories highlight positive developments in environmental restoration, child health, innovative art, and animal welfare. "}],"role":"assistant"}],"parallel_tool_calls":true,"previous_response_id":null,"prompt_cache_key":null,"prompt_cache_retention":null,"reasoning":{"effort":null,"summary":null},"safety_identifier":null,"service_tier":"default","store":true,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tools":[{"type":"web_search_preview","search_context_size":"medium","user_location":{"type":"approximate","city":null,"country":"US","region":null,"timezone":null}}],"top_logprobs":0,"top_p":1.0,"truncation":"disabled","usage":{"input_tokens":310,"input_tokens_details":{"cached_tokens":0},"output_tokens":413,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":723},"user":null,"metadata":{}}}
