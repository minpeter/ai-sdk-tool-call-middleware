# (Files content cropped to 300k characters, download full ingest to see more)

# FILE: packages/ai/README.md

![hero illustration](./assets/hero.gif)

# AI SDK

The [AI SDK](https://ai-sdk.dev/docs) is a TypeScript toolkit designed to help you build AI-powered applications and agents using popular frameworks like Next.js, React, Svelte, Vue and runtimes like Node.js.

To learn more about how to use the AI SDK, check out our [API Reference](https://ai-sdk.dev/docs/reference) and [Documentation](https://ai-sdk.dev/docs).

## Installation

You will need Node.js 18+ and npm (or another package manager) installed on your local development machine.

```shell
npm install ai
```

## Unified Provider Architecture

The AI SDK provides a [unified API](https://ai-sdk.dev/docs/foundations/providers-and-models) to interact with model providers like [OpenAI](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [Anthropic](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic), [Google](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai), and [more](https://ai-sdk.dev/providers/ai-sdk-providers).

```shell
npm install @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google
```

Alternatively you can use the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

## Usage

### Generating Text

```ts
import { generateText } from "ai";

const { text } = await generateText({
  model: "openai/gpt-5", // use Vercel AI Gateway
  prompt: "What is an agent?",
});
```

```ts
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const { text } = await generateText({
  model: openai("gpt-5"), // use OpenAI Responses API
  prompt: "What is an agent?",
});
```

### Generating Structured Data

```ts
import { generateObject } from "ai";
import { z } from "zod";

const { object } = await generateObject({
  model: "openai/gpt-4.1",
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
      steps: z.array(z.string()),
    }),
  }),
  prompt: "Generate a lasagna recipe.",
});
```

### Agents

```ts
import { ToolLoopAgent } from "ai";

const sandboxAgent = new ToolLoopAgent({
  model: "openai/gpt-5-codex",
  system: "You are an agent with access to a shell environment.",
  tools: {
    local_shell: openai.tools.localShell({
      execute: async ({ action }) => {
        const [cmd, ...args] = action.command;
        const sandbox = await getSandbox(); // Vercel Sandbox
        const command = await sandbox.runCommand({ cmd, args });
        return { output: await command.stdout() };
      },
    }),
  },
});
```

### UI Integration

The [AI SDK UI](https://ai-sdk.dev/docs/ai-sdk-ui/overview) module provides a set of hooks that help you build chatbots and generative user interfaces. These hooks are framework agnostic, so they can be used in Next.js, React, Svelte, and Vue.

You need to install the package for your framework, e.g.:

```shell
npm install @ai-sdk/react
```

#### Agent @/agent/image-generation-agent.ts

```ts
import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, InferAgentUIMessage } from "ai";

export const imageGenerationAgent = new ToolLoopAgent({
  model: openai("gpt-5"),
  tools: {
    image_generation: openai.tools.imageGeneration({
      partialImages: 3,
    }),
  },
});

export type ImageGenerationAgentMessage = InferAgentUIMessage<
  typeof imageGenerationAgent
>;
```

#### Route (Next.js App Router) @/app/api/chat/route.ts

```tsx
import { imageGenerationAgent } from "@/agent/image-generation-agent";
import { createAgentUIStreamResponse } from "ai";

export async function POST(req: Request) {
  const { messages } = await req.json();

  return createAgentUIStreamResponse({
    agent: imageGenerationAgent,
    messages,
  });
}
```

#### UI Component for Tool @/component/image-generation-view.tsx

```tsx
import { openai } from "@ai-sdk/openai";
import { UIToolInvocation } from "ai";

export default function ImageGenerationView({
  invocation,
}: {
  invocation: UIToolInvocation<ReturnType<typeof openai.tools.imageGeneration>>;
}) {
  switch (invocation.state) {
    case "input-available":
      return <div>Generating image...</div>;
    case "output-available":
      return <img src={`data:image/png;base64,${invocation.output.result}`} />;
  }
}
```

#### Page @/app/page.tsx

```tsx
"use client";

import { ImageGenerationAgentMessage } from "@/agent/image-generation-agent";
import ImageGenerationView from "@/component/image-generation-view";
import { useChat } from "@ai-sdk/react";

export default function Page() {
  const { messages, status, sendMessage } =
    useChat<ImageGenerationAgentMessage>();

  const [input, setInput] = useState("");
  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <div>
      {messages.map((message) => (
        <div key={message.id}>
          <strong>{`${message.role}: `}</strong>
          {message.parts.map((part, index) => {
            switch (part.type) {
              case "text":
                return <div key={index}>{part.text}</div>;
              case "tool-image_generation":
                return <ImageGenerationView key={index} invocation={part} />;
            }
          })}
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={status !== "ready"}
        />
      </form>
    </div>
  );
}
```

## Templates

We've built [templates](https://ai-sdk.dev/docs/introduction#templates) that include AI SDK integrations for different use cases, providers, and frameworks. You can use these templates to get started with your AI-powered application.

## Community

The AI SDK community can be found on [GitHub Discussions](https://github.com/vercel/ai/discussions) where you can ask questions, voice ideas, and share your projects with other people.

## Contributing

Contributions to the AI SDK are welcome and highly appreciated. However, before you jump right into it, we would like you to review our [Contribution Guidelines](https://github.com/vercel/ai/blob/main/CONTRIBUTING.md) to make sure you have smooth experience contributing to AI SDK.

## Authors

This library is created by [Vercel](https://vercel.com) and [Next.js](https://nextjs.org) team members, with contributions from the [Open Source Community](https://github.com/vercel/ai/graphs/contributors).

================================================
FILE: packages/ai/index.ts
================================================
// TODO remove once we can set the source folder in tsconfig.json to src/
export \* from './src';

================================================
FILE: packages/ai/internal.d.ts
================================================
export \* from './dist/internal';

================================================
FILE: packages/ai/package.json
================================================
{
"name": "ai",
"version": "6.0.0-beta.94",
"description": "AI SDK by Vercel - The AI Toolkit for TypeScript and JavaScript",
"license": "Apache-2.0",
"sideEffects": false,
"main": "./dist/index.js",
"module": "./dist/index.mjs",
"types": "./dist/index.d.ts",
"files": [
"dist/**/*",
"CHANGELOG.md",
"internal.d.ts",
"README.md",
"test.d.ts"
],
"scripts": {
"build": "pnpm clean && tsup --tsconfig tsconfig.build.json",
"build:watch": "pnpm clean && tsup --watch --tsconfig tsconfig.build.json",
"clean": "rm -rf dist _.tsbuildinfo",
"lint": "eslint \"./\*\*/_.ts*\"",
"type-check": "tsc --build",
"prettier-check": "prettier --check \"./\*\*/*.ts*\"",
"test": "pnpm test:node && pnpm test:edge",
"test:update": "pnpm test:node -u",
"test:watch": "vitest --config vitest.node.config.js",
"test:edge": "vitest --config vitest.edge.config.js --run",
"test:node": "vitest --config vitest.node.config.js --run",
"check-bundle-size": "tsx scripts/check-bundle-size.ts"
},
"exports": {
"./package.json": "./package.json",
".": {
"types": "./dist/index.d.ts",
"import": "./dist/index.mjs",
"require": "./dist/index.js"
},
"./internal": {
"types": "./dist/internal/index.d.ts",
"import": "./dist/internal/index.mjs",
"module": "./dist/internal/index.mjs",
"require": "./dist/internal/index.js"
},
"./test": {
"types": "./dist/test/index.d.ts",
"import": "./dist/test/index.mjs",
"module": "./dist/test/index.mjs",
"require": "./dist/test/index.js"
}
},
"dependencies": {
"@ai-sdk/gateway": "workspace:*",
"@ai-sdk/provider": "workspace:_",
"@ai-sdk/provider-utils": "workspace:_",
"@opentelemetry/api": "1.9.0"
},
"devDependencies": {
"@ai-sdk/test-server": "workspace:_",
"@edge-runtime/vm": "^5.0.0",
"@types/json-schema": "7.0.15",
"@types/node": "20.17.24",
"@vercel/ai-tsconfig": "workspace:_",
"esbuild": "^0.24.2",
"eslint": "8.57.1",
"eslint-config-vercel-ai": "workspace:\*",
"tsup": "^7.2.0",
"tsx": "^4.19.2",
"typescript": "5.8.3",
"zod": "3.25.76"
},
"peerDependencies": {
"zod": "^3.25.76 || ^4.1.8"
},
"engines": {
"node": ">=18"
},
"publishConfig": {
"access": "public"
},
"homepage": "https://ai-sdk.dev/docs",
"repository": {
"type": "git",
"url": "git+https://github.com/vercel/ai.git"
},
"bugs": {
"url": "https://github.com/vercel/ai/issues"
},
"keywords": [
"ai",
"vercel",
"sdk",
"mcp",
"tool-calling",
"tools",
"structured-output",
"agent",
"agentic",
"generative",
"chatbot",
"prompt",
"inference",
"llm",
"language-model",
"streaming"
]
}

================================================
FILE: packages/ai/test.d.ts
================================================
export \* from './dist/test';

================================================
FILE: packages/ai/tsconfig.build.json
================================================
{
"extends": "./tsconfig.json",
"compilerOptions": {
// Disable project configuration for tsup builds
"composite": false
}
}

================================================
FILE: packages/ai/tsconfig.json
================================================
{
"extends": "./node_modules/@vercel/ai-tsconfig/base.json",
"compilerOptions": {
"target": "ES2018",
"stripInternal": true,
"lib": ["dom", "dom.iterable", "esnext"],
"types": ["@types/node"],
"composite": true,
"rootDir": ".",
"outDir": "dist"
},
"exclude": [
"dist",
"build",
"node_modules",
"tsup.config.ts",
"internal.d.ts",
"test.d.ts"
],
"references": [
{
"path": "../provider"
},
{
"path": "../provider-utils"
},
{
"path": "../gateway"
},
{
"path": "../test-server"
}
]
}

================================================
FILE: packages/ai/tsup.config.ts
================================================
import { defineConfig } from 'tsup';

export default defineConfig([
// Universal APIs
{
entry: ['src/index.ts'],
format: ['cjs', 'esm'],
external: ['react', 'svelte', 'vue', 'chai', 'chai/*'],
dts: true,
sourcemap: true,
target: 'es2018',
platform: 'node',
define: {
**PACKAGE_VERSION**: JSON.stringify(
(await import('./package.json', { with: { type: 'json' } })).default
.version,
),
},
},
// Internal APIs
{
entry: ['internal/index.ts'],
outDir: 'dist/internal',
format: ['cjs', 'esm'],
external: ['chai', 'chai/*'],
dts: true,
sourcemap: true,
target: 'es2018',
platform: 'node',
define: {
**PACKAGE_VERSION**: JSON.stringify(
(await import('./package.json', { with: { type: 'json' } })).default
.version,
),
},
},
// Test utilities
{
entry: ['test/index.ts'],
outDir: 'dist/test',
format: ['cjs', 'esm'],
external: [
'chai',
'chai/*',
'vitest',
'vitest/*',
'@vitest/*',
'vitest/dist/*',
'vitest/dist/chunks/*',
'vitest/dist/node/*',
'vitest/dist/node/chunks/*',
],
dts: true,
sourcemap: true,
// Allow BigInt in tests
target: 'es2020',
platform: 'node',
define: {
**PACKAGE_VERSION**: JSON.stringify(
(await import('./package.json', { with: { type: 'json' } })).default
.version,
),
},
},
]);

================================================
FILE: packages/ai/turbo.json
================================================
{
"extends": [
"//"
],
"tasks": {
"build": {
"outputs": [
"**/dist/**"
]
}
}
}

================================================
FILE: packages/ai/vitest.edge.config.js
================================================
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const version = JSON.parse(
readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version;

// https://vitejs.dev/config/
export default defineConfig({
define: {
**PACKAGE_VERSION**: JSON.stringify(version),
},
test: {
environment: 'edge-runtime',
include: ['**/*.test.ts{,x}'],
exclude: [
'**/*.ui.test.ts{,x}',
'**/*.e2e.test.ts{,x}',
'**/node_modules/**',
],
typecheck: {
enabled: true,
},
},
});

================================================
FILE: packages/ai/vitest.node.config.js
================================================
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const version = JSON.parse(
readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version;

// https://vitejs.dev/config/
export default defineConfig({
define: {
**PACKAGE_VERSION**: JSON.stringify(version),
},
test: {
environment: 'node',
include: ['**/*.test.ts{,x}'],
exclude: [
'**/*.ui.test.ts{,x}',
'**/*.e2e.test.ts{,x}',
'**/node_modules/**',
],
typecheck: {
enabled: true,
},
},
});

================================================
FILE: packages/ai/.eslintrc.js
================================================
module.exports = {
root: true,
extends: ['vercel-ai'],
};

================================================
FILE: packages/ai/internal/index.ts
================================================
// internal re-exports
export { convertAsyncIteratorToReadableStream } from '@ai-sdk/provider-utils';

// internal
export { convertToLanguageModelPrompt } from '../src/prompt/convert-to-language-model-prompt';
export { prepareToolsAndToolChoice } from '../src/prompt/prepare-tools-and-tool-choice';
export { standardizePrompt } from '../src/prompt/standardize-prompt';
export { prepareCallSettings } from '../src/prompt/prepare-call-settings';
export { prepareRetries } from '../src/util/prepare-retries';

================================================
FILE: packages/ai/scripts/check-bundle-size.ts
================================================
import { build } from 'esbuild';
import { writeFileSync, statSync } from 'fs';
import { join } from 'path';

// Bundle size limits in bytes
const LIMIT = 550 \* 1024;

interface BundleResult {
size: number;
path: string;
condition: string;
}

async function bundleForNode(): Promise<BundleResult> {
const outfile = join(process.cwd(), 'dist-bundle-check', 'node.js');
const metafile = join(process.cwd(), 'dist-bundle-check', 'node-meta.json');

const result = await build({
entryPoints: [join(process.cwd(), 'src', 'index.ts')],
bundle: true,
platform: 'node',
target: 'es2020',
format: 'esm',
outfile,
metafile: true,
minify: true,
treeShaking: true,
external: ['arktype', 'effect', '@valibot/to-json-schema'],
});
writeFileSync(metafile, JSON.stringify(result.metafile, null, 2));

const size = statSync(outfile).size;
return { size, path: outfile, condition: 'node' };
}

async function bundleForBrowser(): Promise<BundleResult> {
const outfile = join(process.cwd(), 'dist-bundle-check', 'browser.js');
const metafile = join(
process.cwd(),
'dist-bundle-check',
'browser-meta.json',
);

const result = await build({
entryPoints: [join(process.cwd(), 'src', 'index.ts')],
bundle: true,
platform: 'browser',
target: 'es2020',
format: 'esm',
outfile,
metafile: true,
minify: true,
treeShaking: true,
conditions: ['browser'],
external: ['arktype', 'effect', '@valibot/to-json-schema'],
});
writeFileSync(metafile, JSON.stringify(result.metafile, null, 2));

const size = statSync(outfile).size;
return { size, path: outfile, condition: 'browser' };
}

function formatSize(bytes: number): string {
return `${(bytes / 1024).toFixed(2)} KB`;
}

function checkSize(result: BundleResult, limit: number): boolean {
const passed = result.size <= limit;
const status = passed ? '✅' : '❌';
const percentage = ((result.size / limit) \* 100).toFixed(1);

console.log(
`${status} ${result.condition.padEnd(10)} ${formatSize(result.size).padEnd(12)} (${percentage}% of ${formatSize(limit)} limit)`,
);

return passed;
}

async function main() {
console.log('📦 Checking bundle sizes...\n');

try {
const [nodeResult, browserResult] = await Promise.all([
bundleForNode(),
bundleForBrowser(),
]);

    console.log('Bundle sizes:');
    const nodePass = checkSize(nodeResult, LIMIT);
    const browserPass = checkSize(browserResult, LIMIT);

    console.log('\n---');

    console.log('📦 Bundle size check complete.');
    console.log(
      'Upload dist-bundle-check/*.json files to https://esbuild.github.io/analyze/ for detailed analysis.',
    );

    console.log('\n---');

    if (nodePass && browserPass) {
      console.log('✅ All bundle size checks passed!');
      process.exit(0);
    } else {
      console.log('❌ Bundle size check failed!');
      console.log('\nTo fix this, either:');
      console.log('1. Reduce the bundle size by optimizing code');
      console.log(
        '2. Update the limit at https://github.com/vercel/ai/settings/variables/actions/BUNDLE_SIZE_LIMIT_KB',
      );
      process.exit(1);
    }

} catch (error) {
console.error('Error during bundle size check:', error);
process.exit(1);
}
}

main();

================================================
FILE: packages/ai/src/global.ts
================================================
import { ProviderV3 } from '@ai-sdk/provider';
import { LogWarningsFunction } from './logger/log-warnings';

// add AI SDK default provider to the globalThis object
declare global {
/\*\*

- The default provider to use for the AI SDK.
- String model ids are resolved to the default provider and model id.
-
- If not set, the default provider is the Vercel AI gateway provider.
-
- @see https://ai-sdk.dev/docs/ai-sdk-core/provider-management#global-provider-configuration
  \*/
  var AI_SDK_DEFAULT_PROVIDER: ProviderV3 | undefined;

/\*\*

- The warning logger to use for the AI SDK.
-
- If not set, the default logger is the console.warn function.
-
- If set to false, no warnings are logged.
  \*/
  var AI_SDK_LOG_WARNINGS: LogWarningsFunction | undefined | false;
  }

================================================
FILE: packages/ai/src/index.ts
================================================
// re-exports:
export { createGateway, gateway } from '@ai-sdk/gateway';
export {
asSchema,
createIdGenerator,
dynamicTool,
generateId,
jsonSchema,
parseJsonEventStream,
tool,
zodSchema,
type FlexibleSchema,
type IdGenerator,
type InferSchema,
type InferToolInput,
type InferToolOutput,
type Schema,
type Tool,
type ToolApprovalRequest,
type ToolApprovalResponse,
type ToolCallOptions,
type ToolExecuteFunction,
} from '@ai-sdk/provider-utils';

// directory exports
export _ from './agent';
export _ from './embed';
export _ from './error';
export _ from './generate-image';
export _ from './generate-object';
export _ from './generate-speech';
export _ from './generate-text';
export _ from './logger';
export _ from './middleware';
export _ from './prompt';
export _ from './registry';
export _ from './rerank';
export _ from './text-stream';
export _ from './transcribe';
export _ from './types';
export _ from './ui';
export _ from './ui-message-stream';
export _ from './util';

// telemetry types:
export type { TelemetrySettings } from './telemetry/telemetry-settings';

// import globals
import './global';

================================================
FILE: packages/ai/src/version.ts
================================================
declare const **PACKAGE_VERSION**: string | undefined;
export const VERSION: string =
typeof **PACKAGE_VERSION** !== 'undefined'
? **PACKAGE_VERSION**
: '0.0.0-test';

================================================
FILE: packages/ai/src/agent/agent.ts
================================================
import { ModelMessage } from '@ai-sdk/provider-utils';
import { GenerateTextResult } from '../generate-text/generate-text-result';
import { Output } from '../generate-text/output';
import { StreamTextResult } from '../generate-text/stream-text-result';
import { ToolSet } from '../generate-text/tool-set';

export type AgentCallParameters<CALL_OPTIONS> = ([CALL_OPTIONS] extends [never]
? { options?: never }
: { options: CALL_OPTIONS }) &
(
| {
/\*\*
_ A prompt. It can be either a text prompt or a list of messages.
_
_ You can either use `prompt` or `messages` but not both.
_/
prompt: string | Array<ModelMessage>;

        /**
         * A list of messages.
         *
         * You can either use `prompt` or `messages` but not both.
         */
        messages?: never;
      }
    | {
        /**
         * A list of messages.
         *
         * You can either use `prompt` or `messages` but not both.
         */
        messages: Array<ModelMessage>;

        /**
         * A prompt. It can be either a text prompt or a list of messages.
         *
         * You can either use `prompt` or `messages` but not both.
         */
        prompt?: never;
      }

);

/\*\*

- An Agent receives a prompt (text or messages) and generates or streams an output
- that consists of steps, tool calls, data parts, etc.
-
- You can implement your own Agent by implementing the `Agent` interface,
- or use the `ToolLoopAgent` class.
  \*/
  export interface Agent<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
  > {
  > /\*\*
  - The specification version of the agent interface. This will enable
  - us to evolve the agent interface and retain backwards compatibility.
    \*/
    readonly version: 'agent-v1';

/\*\*

- The id of the agent.
  \*/
  readonly id: string | undefined;

/\*\*

- The tools that the agent can use.
  \*/
  readonly tools: TOOLS;

/\*\*

- Generates an output from the agent (non-streaming).
  \*/
  generate(
  options: AgentCallParameters<CALL_OPTIONS>,
  ): PromiseLike<GenerateTextResult<TOOLS, OUTPUT>>;

/\*\*

- Streams an output from the agent (streaming).
  \*/
  stream(
  options: AgentCallParameters<CALL_OPTIONS>,
  ): PromiseLike<StreamTextResult<TOOLS, OUTPUT>>;
  }

================================================
FILE: packages/ai/src/agent/create-agent-ui-stream-response.test.ts
================================================
import { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { tool } from '@ai-sdk/provider-utils';
import {
convertArrayToReadableStream,
convertReadableStreamToArray,
} from '@ai-sdk/provider-utils/test';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { MockLanguageModelV3 } from '../test/mock-language-model-v3';
import { createAgentUIStreamResponse } from './create-agent-ui-stream-response';
import { ToolLoopAgent } from './tool-loop-agent';

describe('createAgentUIStreamResponse', () => {
describe('when using tools toModelOutput', () => {
let recordedInputs: LanguageModelV3CallOptions[];
let response: Response;
let decodedChunks: string[];

    beforeEach(async () => {
      recordedInputs = [];

      const agent = new ToolLoopAgent({
        model: new MockLanguageModelV3({
          doStream: async input => {
            recordedInputs.push(input);
            return {
              stream: convertArrayToReadableStream([
                {
                  type: 'stream-start',
                  warnings: [],
                },
                {
                  type: 'response-metadata',
                  id: 'id-0',
                  modelId: 'mock-model-id',
                  timestamp: new Date(0),
                },
                { type: 'text-start', id: '1' },
                { type: 'text-delta', id: '1', delta: 'Hello' },
                { type: 'text-delta', id: '1', delta: ', ' },
                { type: 'text-delta', id: '1', delta: `world!` },
                { type: 'text-end', id: '1' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: {
                    inputTokens: 10,
                    outputTokens: 10,
                    totalTokens: 20,
                  },
                  providerMetadata: {
                    testProvider: { testKey: 'testValue' },
                  },
                },
              ]),
            };
          },
        }),
        tools: {
          example: tool({
            description: 'Example tool',
            inputSchema: z.object({
              input: z.string(),
            }),
            outputSchema: z.object({
              value: z.string(),
            }),
            // important: tool has toModelOutput that needs to be called
            toModelOutput: output => ({
              type: 'content',
              value: [{ type: 'text', text: output.value }],
            }),
          }),
        },
      });

      response = await createAgentUIStreamResponse({
        agent,
        messages: [
          {
            role: 'user',
            id: 'msg-1',
            parts: [
              {
                type: 'text' as const,
                text: 'Hello, world!',
              },
            ],
          },
          {
            role: 'assistant',
            id: 'msg-2',
            parts: [
              {
                type: 'tool-example' as const,
                toolCallId: 'call-1',
                state: 'output-available',
                input: {
                  input: 'Hello, world!',
                },
                output: {
                  value: 'Example tool: Hello, world!',
                },
              },
            ],
          },
        ],
      });

      // consume the response
      const decoder = new TextDecoder();
      const encodedStream = response.body!;
      const chunks = await convertReadableStreamToArray(encodedStream);
      decodedChunks = chunks.map(chunk => decoder.decode(chunk));
    });

    it('should have a single call that contains the tool result as text', () => {
      expect(recordedInputs).toMatchInlineSnapshot(`
          [
            {
              "abortSignal": undefined,
              "frequencyPenalty": undefined,
              "headers": undefined,
              "includeRawChunks": false,
              "maxOutputTokens": undefined,
              "presencePenalty": undefined,
              "prompt": [
                {
                  "content": [
                    {
                      "providerOptions": undefined,
                      "text": "Hello, world!",
                      "type": "text",
                    },
                  ],
                  "providerOptions": undefined,
                  "role": "user",
                },
                {
                  "content": [
                    {
                      "input": {
                        "input": "Hello, world!",
                      },
                      "providerExecuted": undefined,
                      "providerOptions": undefined,
                      "toolCallId": "call-1",
                      "toolName": "example",
                      "type": "tool-call",
                    },
                  ],
                  "providerOptions": undefined,
                  "role": "assistant",
                },
                {
                  "content": [
                    {
                      "output": {
                        "type": "content",
                        "value": [
                          {
                            "text": "Example tool: Hello, world!",
                            "type": "text",
                          },
                        ],
                      },
                      "providerOptions": undefined,
                      "toolCallId": "call-1",
                      "toolName": "example",
                      "type": "tool-result",
                    },
                  ],
                  "providerOptions": undefined,
                  "role": "tool",
                },
              ],
              "providerOptions": undefined,
              "responseFormat": undefined,
              "seed": undefined,
              "stopSequences": undefined,
              "temperature": undefined,
              "toolChoice": {
                "type": "auto",
              },
              "tools": [
                {
                  "description": "Example tool",
                  "inputSchema": {
                    "$schema": "http://json-schema.org/draft-07/schema#",
                    "additionalProperties": false,
                    "properties": {
                      "input": {
                        "type": "string",
                      },
                    },
                    "required": [
                      "input",
                    ],
                    "type": "object",
                  },
                  "name": "example",
                  "providerOptions": undefined,
                  "type": "function",
                },
              ],
              "topK": undefined,
              "topP": undefined,
            },
          ]
        `);
    });

    it('should return the UI message stream response', () => {
      expect(decodedChunks).toMatchInlineSnapshot(`
        [
          "data: {"type":"start"}

        ",
          "data: {"type":"start-step"}

        ",
          "data: {"type":"text-start","id":"1"}

        ",
          "data: {"type":"text-delta","id":"1","delta":"Hello"}

        ",
          "data: {"type":"text-delta","id":"1","delta":", "}

        ",
          "data: {"type":"text-delta","id":"1","delta":"world!"}

        ",
          "data: {"type":"text-end","id":"1"}

        ",
          "data: {"type":"finish-step"}

        ",
          "data: {"type":"finish"}

        ",
          "data: [DONE]

        ",
        ]
      `);
    });

});
});

================================================
FILE: packages/ai/src/agent/create-agent-ui-stream-response.ts
================================================
import { UIMessageStreamOptions } from '../generate-text';
import { Output } from '../generate-text/output';
import { ToolSet } from '../generate-text/tool-set';
import { createUIMessageStreamResponse } from '../ui-message-stream';
import { UIMessageStreamResponseInit } from '../ui-message-stream/ui-message-stream-response-init';
import { InferUITools, UIMessage } from '../ui/ui-messages';
import { Agent } from './agent';
import { createAgentUIStream } from './create-agent-ui-stream';

/\*\*

- Runs the agent and returns a response object with a UI message stream.
-
- @param agent - The agent to run.
- @param messages - The input UI messages.
-
- @returns The response object.
  \*/
  export async function createAgentUIStreamResponse<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
  MESSAGE_METADATA = unknown,
  > ({
  > headers,
  > status,
  > statusText,
  > consumeSseStream,
  > ...options
  > }: {
  > agent: Agent<CALL_OPTIONS, TOOLS, OUTPUT>;
  > messages: unknown[];
  > options?: CALL_OPTIONS;
  > } & UIMessageStreamResponseInit &
  > UIMessageStreamOptions<
      UIMessage<MESSAGE_METADATA, never, InferUITools<TOOLS>>
  > ): Promise<Response> {
  > return createUIMessageStreamResponse({
      headers,
      status,
      statusText,
      consumeSseStream,
      stream: await createAgentUIStream(options),
  });
  }

================================================
FILE: packages/ai/src/agent/create-agent-ui-stream.ts
================================================
import { UIMessageStreamOptions } from '../generate-text';
import { Output } from '../generate-text/output';
import { ToolSet } from '../generate-text/tool-set';
import { InferUIMessageChunk } from '../ui-message-stream';
import { convertToModelMessages } from '../ui/convert-to-model-messages';
import { InferUITools, UIMessage } from '../ui/ui-messages';
import { validateUIMessages } from '../ui/validate-ui-messages';
import { AsyncIterableStream } from '../util/async-iterable-stream';
import { Agent } from './agent';

/\*\*

- Runs the agent and stream the output as a UI message stream.
-
- @param agent - The agent to run.
- @param messages - The input UI messages.
-
- @returns The UI message stream.
  \*/
  export async function createAgentUIStream<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
  MESSAGE_METADATA = unknown,
  > ({
  > agent,
  > messages,
  > options,
  > ...uiMessageStreamOptions
  > }: {
  > agent: Agent<CALL_OPTIONS, TOOLS, OUTPUT>;
  > messages: unknown[];
  > options?: CALL_OPTIONS;
  > } & UIMessageStreamOptions<
  > UIMessage<MESSAGE_METADATA, never, InferUITools<TOOLS>>
  > ): Promise<
  > AsyncIterableStream<
      InferUIMessageChunk<UIMessage<MESSAGE_METADATA, never, InferUITools<TOOLS>>>
  > {
  > const validatedMessages = await validateUIMessages<
      UIMessage<MESSAGE_METADATA, never, InferUITools<TOOLS>>
  > ({
      messages,
      tools: agent.tools,
  });

const modelMessages = convertToModelMessages(validatedMessages, {
tools: agent.tools,
});

const result = await agent.stream({
prompt: modelMessages,
options: options as CALL_OPTIONS,
});

return result.toUIMessageStream(uiMessageStreamOptions);
}

================================================
FILE: packages/ai/src/agent/index.ts
================================================
export { type Agent } from './agent';
export { type ToolLoopAgentOnFinishCallback } from './tool-loop-agent-on-finish-callback';
export { type ToolLoopAgentOnStepFinishCallback } from './tool-loop-agent-on-step-finish-callback';
export {
type ToolLoopAgentSettings,

/\*\*

- @deprecated Use `ToolLoopAgentSettings` instead.
  \*/
  type ToolLoopAgentSettings as Experimental_AgentSettings,
  } from './tool-loop-agent-settings';
  export {
  ToolLoopAgent,

/\*\*

- @deprecated Use `ToolLoopAgent` instead.
  \*/
  ToolLoopAgent as Experimental_Agent,
  } from './tool-loop-agent';
  export {
  /\*\*
- @deprecated Use `InferAgentUIMessage` instead.
  \*/
  type InferAgentUIMessage as Experimental_InferAgentUIMessage,
  type InferAgentUIMessage,
  } from './infer-agent-ui-message';
  export { createAgentUIStreamResponse } from './create-agent-ui-stream-response';
  export { createAgentUIStream } from './create-agent-ui-stream';
  export { pipeAgentUIStreamToResponse } from './pipe-agent-ui-stream-to-response';

================================================
FILE: packages/ai/src/agent/infer-agent-tools.ts
================================================
import { Agent } from './agent';

/\*\*

- Infer the type of the tools of an agent.
  \*/
  export type InferAgentTools<AGENT> =
  AGENT extends Agent<any, infer TOOLS, any> ? TOOLS : never;

================================================
FILE: packages/ai/src/agent/infer-agent-ui-message.test-d.ts
================================================
import { describe, expectTypeOf, it } from 'vitest';
import {
DataUIPart,
DynamicToolUIPart,
FileUIPart,
ReasoningUIPart,
SourceDocumentUIPart,
SourceUrlUIPart,
StepStartUIPart,
TextUIPart,
UIMessage,
} from '../ui/ui-messages';
import { ToolLoopAgent } from './tool-loop-agent';
import { InferAgentUIMessage } from './infer-agent-ui-message';

describe('InferAgentUIMessage', () => {
it('should not contain arbitrary static tools when no tools are provided', () => {
const baseAgent = new ToolLoopAgent({
model: 'openai/gpt-4o',
// no tools
});

    type Message = InferAgentUIMessage<typeof baseAgent>;

    expectTypeOf<Message>().toMatchTypeOf<UIMessage<never, never, {}>>();

    type MessagePart = Message['parts'][number];

    expectTypeOf<MessagePart>().toMatchTypeOf<
      | TextUIPart
      | ReasoningUIPart
      // No static tools, so no ToolUIPart
      | DynamicToolUIPart
      | SourceUrlUIPart
      | SourceDocumentUIPart
      | FileUIPart
      | DataUIPart<never>
      | StepStartUIPart
    >();

});
});

================================================
FILE: packages/ai/src/agent/infer-agent-ui-message.ts
================================================
import { InferUITools, UIMessage } from '../ui/ui-messages';
import { InferAgentTools } from './infer-agent-tools';

/\*\*

- Infer the UI message type of an agent.
  \*/
  export type InferAgentUIMessage<AGENT> = UIMessage<
  never,
  never,
  InferUITools<InferAgentTools<AGENT>>
  > ;

================================================
FILE: packages/ai/src/agent/pipe-agent-ui-stream-to-response.ts
================================================
import { ServerResponse } from 'node:http';
import { UIMessageStreamOptions } from '../generate-text';
import { Output } from '../generate-text/output';
import { ToolSet } from '../generate-text/tool-set';
import { pipeUIMessageStreamToResponse } from '../ui-message-stream';
import { UIMessageStreamResponseInit } from '../ui-message-stream/ui-message-stream-response-init';
import { InferUITools, UIMessage } from '../ui/ui-messages';
import { Agent } from './agent';
import { createAgentUIStream } from './create-agent-ui-stream';

/\*\*

- Pipes the agent UI message stream to a Node.js ServerResponse object.
-
- @param agent - The agent to run.
- @param messages - The input UI messages.
  \*/
  export async function pipeAgentUIStreamToResponse<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
  MESSAGE_METADATA = unknown,
  > ({
  > response,
  > headers,
  > status,
  > statusText,
  > consumeSseStream,
  > ...options
  > }: {
  > response: ServerResponse;
  > agent: Agent<CALL_OPTIONS, TOOLS, OUTPUT>;
  > messages: unknown[];
  > options?: CALL_OPTIONS;
  > } & UIMessageStreamResponseInit &
  > UIMessageStreamOptions<
      UIMessage<MESSAGE_METADATA, never, InferUITools<TOOLS>>
  > ): Promise<void> {
  > pipeUIMessageStreamToResponse({
      response,
      headers,
      status,
      statusText,
      consumeSseStream,
      stream: await createAgentUIStream(options),
  });
  }

================================================
FILE: packages/ai/src/agent/tool-loop-agent-on-finish-callback.ts
================================================
import { StepResult } from '../generate-text/step-result';
import { ToolSet } from '../generate-text/tool-set';
import { LanguageModelUsage } from '../types/usage';

/\*\*
Callback that is set using the `onFinish` option.

@param event - The event that is passed to the callback.
_/
export type ToolLoopAgentOnFinishCallback<TOOLS extends ToolSet = {}> = (
event: StepResult<TOOLS> & {
/\*\*
Details for all steps.
_/
readonly steps: StepResult<TOOLS>[];

    /**

Total usage for all steps. This is the sum of the usage of all steps.
\*/
readonly totalUsage: LanguageModelUsage;
},
) => PromiseLike<void> | void;

================================================
FILE: packages/ai/src/agent/tool-loop-agent-on-step-finish-callback.ts
================================================
import { StepResult } from '../generate-text/step-result';
import { ToolSet } from '../generate-text/tool-set';

/\*\*
Callback that is set using the `onStepFinish` option.

@param stepResult - The result of the step.
\*/
export type ToolLoopAgentOnStepFinishCallback<TOOLS extends ToolSet = {}> = (
stepResult: StepResult<TOOLS>,
) => Promise<void> | void;

================================================
FILE: packages/ai/src/agent/tool-loop-agent-settings.ts
================================================
import {
FlexibleSchema,
MaybePromiseLike,
ProviderOptions,
} from '@ai-sdk/provider-utils';
import { Output } from '../generate-text/output';
import { PrepareStepFunction } from '../generate-text/prepare-step';
import { StopCondition } from '../generate-text/stop-condition';
import { ToolCallRepairFunction } from '../generate-text/tool-call-repair-function';
import { ToolSet } from '../generate-text/tool-set';
import { CallSettings } from '../prompt/call-settings';
import { Prompt } from '../prompt/prompt';
import { TelemetrySettings } from '../telemetry/telemetry-settings';
import { LanguageModel, ToolChoice } from '../types/language-model';
import { AgentCallParameters } from './agent';
import { ToolLoopAgentOnFinishCallback } from './tool-loop-agent-on-finish-callback';
import { ToolLoopAgentOnStepFinishCallback } from './tool-loop-agent-on-step-finish-callback';

/\*\*

- Configuration options for an agent.
  \*/
  export type ToolLoopAgentSettings<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
  > = CallSettings & {
  > /\*\*
  - The id of the agent.
    \*/
    id?: string;

/\*\*

- The instructions for the agent.
  \*/
  instructions?: string;

/\*_
The language model to use.
_/
model: LanguageModel;

/\*_
The tools that the model can call. The model needs to support calling tools.
_/
tools?: TOOLS;

/\*_
The tool choice strategy. Default: 'auto'.
_/
toolChoice?: ToolChoice<NoInfer<TOOLS>>;

/\*\*
Condition for stopping the generation when there are tool results in the last step.
When the condition is an array, any of the conditions can be met to stop the generation.

@default stepCountIs(20)
\*/
stopWhen?:
| StopCondition<NoInfer<TOOLS>>
| Array<StopCondition<NoInfer<TOOLS>>>;

/\*_
Optional telemetry configuration (experimental).
_/
experimental_telemetry?: TelemetrySettings;

/\*_
Limits the tools that are available for the model to call without
changing the tool call and result types in the result.
_/
activeTools?: Array<keyof NoInfer<TOOLS>>;

/\*_
Optional specification for generating structured outputs.
_/
output?: OUTPUT;

/\*_
Optional function that you can use to provide different settings for a step.
_/
prepareStep?: PrepareStepFunction<NoInfer<TOOLS>>;

/\*_
A function that attempts to repair a tool call that failed to parse.
_/
experimental_repairToolCall?: ToolCallRepairFunction<NoInfer<TOOLS>>;

/\*\*

- Callback that is called when each step (LLM call) is finished, including intermediate steps.
  \*/
  onStepFinish?: ToolLoopAgentOnStepFinishCallback<NoInfer<TOOLS>>;

/\*\*

- Callback that is called when all steps are finished and the response is complete.
  \*/
  onFinish?: ToolLoopAgentOnFinishCallback<NoInfer<TOOLS>>;

/\*_
Additional provider-specific options. They are passed through
to the provider from the AI SDK and enable provider-specific
functionality that can be fully encapsulated in the provider.
_/
providerOptions?: ProviderOptions;

/\*\*

- Context that is passed into tool calls.
-
- Experimental (can break in patch releases).
-
- @default undefined
  \*/
  experimental_context?: unknown;

/\*\*

- The schema for the call options.
  \*/
  callOptionsSchema?: FlexibleSchema<CALL_OPTIONS>;

/\*\*

- Prepare the parameters for the generateText or streamText call.
-
- You can use this to have templates based on call options.
  \*/
  prepareCall?: (
  options: AgentCallParameters<CALL_OPTIONS> &
  Pick<
  ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, OUTPUT>,
  | 'model'
  | 'tools'
  | 'maxOutputTokens'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'presencePenalty'
  | 'frequencyPenalty'
  | 'stopSequences'
  | 'seed'
  | 'headers'
  | 'instructions'
  | 'stopWhen'
  | 'experimental_telemetry'
  | 'activeTools'
  | 'providerOptions'
  | 'experimental_context' >,
  ) => MaybePromiseLike<
  Pick<
  ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, OUTPUT>,
  | 'model'
  | 'tools'
  | 'maxOutputTokens'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'presencePenalty'
  | 'frequencyPenalty'
  | 'stopSequences'
  | 'seed'
  | 'headers'
  | 'instructions'
  | 'stopWhen'
  | 'experimental_telemetry'
  | 'activeTools'
  | 'providerOptions'
  | 'experimental_context' > &
  Omit<Prompt, 'system'>
  > ;
  > };

================================================
FILE: packages/ai/src/agent/tool-loop-agent.test-d.ts
================================================
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { Output } from '../generate-text';
import { MockLanguageModelV3 } from '../test/mock-language-model-v3';
import { ToolLoopAgent } from './tool-loop-agent';
import { AsyncIterableStream } from '../util/async-iterable-stream';
import { DeepPartial } from '../util/deep-partial';
import { ModelMessage } from '../prompt';

describe('ToolLoopAgent', () => {
describe('generate', () => {
it('should not allow system prompt', async () => {
const agent = new ToolLoopAgent({
model: new MockLanguageModelV3(),
});

      await agent.generate({
        // @ts-expect-error - system prompt is not allowed
        system: '123',
        prompt: 'Hello, world!',
      });
    });

    it('should require options when call options are provided', async () => {
      const agent = new ToolLoopAgent<{ callOption: string }>({
        model: new MockLanguageModelV3(),
      });

      expectTypeOf<Parameters<typeof agent.generate>[0]>().toEqualTypeOf<
        { options: { callOption: string } } & (
          | { prompt: string | ModelMessage[]; messages?: never }
          | { messages: ModelMessage[]; prompt?: never }
        )
      >();
    });

    it('should not require options when call options are not provided', async () => {
      const agent = new ToolLoopAgent({
        model: new MockLanguageModelV3(),
      });

      expectTypeOf<Parameters<typeof agent.generate>[0]>().toEqualTypeOf<
        { options?: never } & (
          | { prompt: string | ModelMessage[]; messages?: never }
          | { messages: ModelMessage[]; prompt?: never }
        )
      >();
    });

    it('should infer output type', async () => {
      const agent = new ToolLoopAgent({
        model: new MockLanguageModelV3(),
        output: Output.object({
          schema: z.object({ value: z.string() }),
        }),
      });

      const generateResult = await agent.generate({
        prompt: 'Hello, world!',
      });

      const output = generateResult.output;

      expectTypeOf<typeof output>().toEqualTypeOf<{ value: string }>();
    });

});

describe('stream', () => {
it('should not allow system prompt', () => {
const agent = new ToolLoopAgent({
model: new MockLanguageModelV3(),
});

      agent.stream({
        // @ts-expect-error - system prompt is not allowed
        system: '123',
        prompt: 'Hello, world!',
      });
    });

    it('should require options when call options are provided', async () => {
      const agent = new ToolLoopAgent<{ callOption: string }>({
        model: new MockLanguageModelV3(),
      });

      expectTypeOf<Parameters<typeof agent.stream>[0]>().toEqualTypeOf<
        { options: { callOption: string } } & (
          | { prompt: string | ModelMessage[]; messages?: never }
          | { messages: ModelMessage[]; prompt?: never }
        )
      >();
    });

    it('should not require options when call options are not provided', async () => {
      const agent = new ToolLoopAgent({
        model: new MockLanguageModelV3(),
      });

      expectTypeOf<Parameters<typeof agent.stream>[0]>().toEqualTypeOf<
        { options?: never } & (
          | { prompt: string | ModelMessage[]; messages?: never }
          | { messages: ModelMessage[]; prompt?: never }
        )
      >();
    });

    it('should infer output type', async () => {
      const agent = new ToolLoopAgent({
        model: new MockLanguageModelV3(),
        output: Output.object({
          schema: z.object({ value: z.string() }),
        }),
      });

      const streamResult = await agent.stream({
        prompt: 'Hello, world!',
      });

      const partialOutputStream = streamResult.partialOutputStream;

      expectTypeOf<typeof partialOutputStream>().toEqualTypeOf<
        AsyncIterableStream<DeepPartial<{ value: string }>>
      >();
    });

});
});

================================================
FILE: packages/ai/src/agent/tool-loop-agent.test.ts
================================================
import { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from '../test/mock-language-model-v3';
import { ToolLoopAgent } from './tool-loop-agent';
import { convertArrayToReadableStream } from '@ai-sdk/provider-utils/test';

describe('ToolLoopAgent', () => {
describe('generate', () => {
it('should use prepareCall', async () => {
let doGenerateOptions: LanguageModelV3CallOptions | undefined;

      const agent = new ToolLoopAgent<{ value: string }>({
        model: new MockLanguageModelV3({
          doGenerate: async options => {
            doGenerateOptions = options;
            return {
              finishReason: 'stop' as const,
              usage: {
                inputTokens: 3,
                outputTokens: 10,
                totalTokens: 13,
                reasoningTokens: undefined,
                cachedInputTokens: undefined,
              },
              warnings: [],
              content: [{ type: 'text', text: 'reply' }],
            };
          },
        }),
        prepareCall: ({ options, ...rest }) => {
          return {
            ...rest,
            providerOptions: {
              test: { value: options.value },
            },
          };
        },
      });

      await agent.generate({
        prompt: 'Hello, world!',
        options: { value: 'test' },
      });

      expect(doGenerateOptions?.providerOptions).toMatchInlineSnapshot(`
        {
          "test": {
            "value": "test",
          },
        }
      `);
    });

});

describe('stream', () => {
it('should use prepareCall', async () => {
let doStreamOptions: LanguageModelV3CallOptions | undefined;

      const agent = new ToolLoopAgent<{ value: string }>({
        model: new MockLanguageModelV3({
          doStream: async options => {
            doStreamOptions = options;
            return {
              stream: convertArrayToReadableStream([
                {
                  type: 'stream-start',
                  warnings: [],
                },
                {
                  type: 'response-metadata',
                  id: 'id-0',
                  modelId: 'mock-model-id',
                  timestamp: new Date(0),
                },
                { type: 'text-start', id: '1' },
                { type: 'text-delta', id: '1', delta: 'Hello' },
                { type: 'text-delta', id: '1', delta: ', ' },
                { type: 'text-delta', id: '1', delta: `world!` },
                { type: 'text-end', id: '1' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: {
                    inputTokens: 3,
                    outputTokens: 10,
                    totalTokens: 13,
                    reasoningTokens: undefined,
                    cachedInputTokens: undefined,
                  },
                  providerMetadata: {
                    testProvider: { testKey: 'testValue' },
                  },
                },
              ]),
            };
          },
        }),
        prepareCall: ({ options, ...rest }) => {
          return {
            ...rest,
            providerOptions: {
              test: { value: options.value },
            },
          };
        },
      });

      const result = await agent.stream({
        prompt: 'Hello, world!',
        options: { value: 'test' },
      });

      await result.consumeStream();

      expect(doStreamOptions?.providerOptions).toMatchInlineSnapshot(
        `
        {
          "test": {
            "value": "test",
          },
        }
      `,
      );
    });

});
});

================================================
FILE: packages/ai/src/agent/tool-loop-agent.ts
================================================
import { generateText } from '../generate-text/generate-text';
import { GenerateTextResult } from '../generate-text/generate-text-result';
import { Output } from '../generate-text/output';
import { stepCountIs } from '../generate-text/stop-condition';
import { streamText } from '../generate-text/stream-text';
import { StreamTextResult } from '../generate-text/stream-text-result';
import { ToolSet } from '../generate-text/tool-set';
import { Prompt } from '../prompt';
import { Agent, AgentCallParameters } from './agent';
import { ToolLoopAgentSettings } from './tool-loop-agent-settings';

/\*\*

- A tool loop agent is an agent that runs tools in a loop. In each step,
- it calls the LLM, and if there are tool calls, it executes the tools
- and calls the LLM again in a new step with the tool results.
-
- The loop continues until:
- - A finish reasoning other than tool-calls is returned, or
- - A tool that is invoked does not have an execute function, or
- - A tool call needs approval, or
- - A stop condition is met (default stop condition is stepCountIs(20))
    \*/
    export class ToolLoopAgent<
    CALL_OPTIONS = never,
    TOOLS extends ToolSet = {},
    OUTPUT extends Output = never,
    > implements Agent<CALL_OPTIONS, TOOLS, OUTPUT>
    > {
    > readonly version = 'agent-v1';

private readonly settings: ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, OUTPUT>;

constructor(settings: ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, OUTPUT>) {
this.settings = settings;
}

/\*\*

- The id of the agent.
  \*/
  get id(): string | undefined {
  return this.settings.id;
  }

/\*\*

- The tools that the agent can use.
  \*/
  get tools(): TOOLS {
  return this.settings.tools as TOOLS;
  }

private async prepareCall(
options: AgentCallParameters<CALL_OPTIONS>,
): Promise<
Omit<
ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, OUTPUT>,
'prepareCall' | 'instructions' > &
Prompt

> {

    const baseCallArgs = {
      ...this.settings,
      stopWhen: this.settings.stopWhen ?? stepCountIs(20),
      ...options,
    };

    const preparedCallArgs =
      (await this.settings.prepareCall?.(baseCallArgs)) ?? baseCallArgs;

    const { instructions, messages, prompt, ...callArgs } = preparedCallArgs;

    return {
      ...callArgs,

      // restore prompt types
      ...({ system: instructions, messages, prompt } as Prompt),
    };

}

/\*\*

- Generates an output from the agent (non-streaming).
  \*/
  async generate(
  options: AgentCallParameters<CALL_OPTIONS>,
  ): Promise<GenerateTextResult<TOOLS, OUTPUT>> {
  return generateText(await this.prepareCall(options));
  }

/\*\*

- Streams an output from the agent (streaming).
  \*/
  async stream(
  options: AgentCallParameters<CALL_OPTIONS>,
  ): Promise<StreamTextResult<TOOLS, OUTPUT>> {
  return streamText(await this.prepareCall(options));
  }
  }

================================================
FILE: packages/ai/src/embed/embed-many-result.ts
================================================
import { Embedding } from '../types';
import { EmbeddingModelUsage } from '../types/usage';
import { ProviderMetadata } from '../types';

/**
The result of a `embedMany` call.
It contains the embeddings, the values, and additional information.
\*/
export interface EmbedManyResult<VALUE> {
/**
The values that were embedded.
\*/
readonly values: Array<VALUE>;

/\*_
The embeddings. They are in the same order as the values.
_/
readonly embeddings: Array<Embedding>;

/\*_
The embedding token usage.
_/
readonly usage: EmbeddingModelUsage;

/\*_
Optional provider-specific metadata.
_/
readonly providerMetadata?: ProviderMetadata;

/**
Optional raw response data.
\*/
readonly responses?: Array<
| {
/**
Response headers.
\*/
headers?: Record<string, string>;

        /**
    The response body.
    */
        body?: unknown;
      }
    | undefined

> ;
> }

================================================
FILE: packages/ai/src/embed/embed-many.test.ts
================================================
import { EmbeddingModelV3 } from '@ai-sdk/provider';
import assert from 'node:assert';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockEmbeddingModelV3 } from '../test/mock-embedding-model-v3';
import { MockTracer } from '../test/mock-tracer';
import { Embedding, EmbeddingModelUsage } from '../types';
import { createResolvablePromise } from '../util/create-resolvable-promise';
import { embedMany } from './embed-many';

vi.mock('../version', () => {
return {
VERSION: '0.0.0-test',
};
});

const dummyEmbeddings = [
[0.1, 0.2, 0.3],
[0.4, 0.5, 0.6],
[0.7, 0.8, 0.9],
];

const testValues = [
'sunny day at the beach',
'rainy afternoon in the city',
'snowy night in the mountains',
];

describe('model.supportsParallelCalls', () => {
it('should not parallelize when false', async () => {
const events: string[] = [];
let callCount = 0;

    const resolvables = [
      createResolvablePromise<void>(),
      createResolvablePromise<void>(),
      createResolvablePromise<void>(),
    ];

    const embedManyPromise = embedMany({
      model: new MockEmbeddingModelV3({
        supportsParallelCalls: false,
        maxEmbeddingsPerCall: 1,
        doEmbed: async () => {
          const index = callCount++;
          events.push(`start-${index}`);

          await resolvables[index].promise;
          events.push(`end-${index}`);

          return {
            embeddings: [dummyEmbeddings[index]],
            response: { headers: {}, body: {} },
          };
        },
      }),
      values: testValues,
    });

    resolvables.forEach(resolvable => {
      resolvable.resolve();
    });

    const { embeddings } = await embedManyPromise;

    expect(events).toStrictEqual([
      'start-0',
      'end-0',
      'start-1',
      'end-1',
      'start-2',
      'end-2',
    ]);

    expect(embeddings).toStrictEqual(dummyEmbeddings);

});

it('should parallelize when true', async () => {
const events: string[] = [];
let callCount = 0;

    const resolvables = [
      createResolvablePromise<void>(),
      createResolvablePromise<void>(),
      createResolvablePromise<void>(),
    ];

    const embedManyPromise = embedMany({
      model: new MockEmbeddingModelV3({
        supportsParallelCalls: true,
        maxEmbeddingsPerCall: 1,
        doEmbed: async () => {
          const index = callCount++;
          events.push(`start-${index}`);

          await resolvables[index].promise;
          events.push(`end-${index}`);

          return {
            embeddings: [dummyEmbeddings[index]],
            response: { headers: {}, body: {} },
          };
        },
      }),
      values: testValues,
    });

    resolvables.forEach(resolvable => {
      resolvable.resolve();
    });

    const { embeddings } = await embedManyPromise;

    expect(events).toStrictEqual([
      'start-0',
      'start-1',
      'start-2',
      'end-0',
      'end-1',
      'end-2',
    ]);

    expect(embeddings).toStrictEqual(dummyEmbeddings);

});

it('should support maxParallelCalls', async () => {
const events: string[] = [];
let callCount = 0;

    const resolvables = [
      createResolvablePromise<void>(),
      createResolvablePromise<void>(),
      createResolvablePromise<void>(),
    ];

    const embedManyPromise = embedMany({
      maxParallelCalls: 2,
      model: new MockEmbeddingModelV3({
        supportsParallelCalls: true,
        maxEmbeddingsPerCall: 1,
        doEmbed: async () => {
          const index = callCount++;
          events.push(`start-${index}`);

          await resolvables[index].promise;
          events.push(`end-${index}`);

          return {
            embeddings: [dummyEmbeddings[index]],
            response: { headers: {}, body: {} },
          };
        },
      }),
      values: testValues,
    });

    resolvables.forEach(resolvable => {
      resolvable.resolve();
    });

    const { embeddings } = await embedManyPromise;

    expect(events).toStrictEqual([
      'start-0',
      'start-1',
      'end-0',
      'end-1',
      'start-2',
      'end-2',
    ]);

    expect(embeddings).toStrictEqual(dummyEmbeddings);

});
});

describe('result.embedding', () => {
it('should generate embeddings', async () => {
const result = await embedMany({
model: new MockEmbeddingModelV3({
maxEmbeddingsPerCall: 5,
doEmbed: mockEmbed(testValues, dummyEmbeddings),
}),
values: testValues,
});

    assert.deepStrictEqual(result.embeddings, dummyEmbeddings);

});

it('should generate embeddings when several calls are required', async () => {
let callCount = 0;

    const result = await embedMany({
      model: new MockEmbeddingModelV3({
        maxEmbeddingsPerCall: 2,
        doEmbed: async ({ values }) => {
          switch (callCount++) {
            case 0:
              assert.deepStrictEqual(values, testValues.slice(0, 2));
              return { embeddings: dummyEmbeddings.slice(0, 2) };
            case 1:
              assert.deepStrictEqual(values, testValues.slice(2));
              return { embeddings: dummyEmbeddings.slice(2) };
            default:
              throw new Error('Unexpected call');
          }
        },
      }),
      values: testValues,
    });

    assert.deepStrictEqual(result.embeddings, dummyEmbeddings);

});
});

describe('result.responses', () => {
it('should include responses in the result', async () => {
let callCount = 0;
const result = await embedMany({
model: new MockEmbeddingModelV3({
maxEmbeddingsPerCall: 1,

        doEmbed: async ({ values }) => {
          switch (callCount++) {
            case 0:
              assert.deepStrictEqual(values, [testValues[0]]);
              return {
                embeddings: dummyEmbeddings,
                response: {
                  body: { first: true },
                },
              };
            case 1:
              assert.deepStrictEqual(values, [testValues[1]]);
              return {
                embeddings: dummyEmbeddings,
                response: {
                  body: { second: true },
                },
              };
            case 2:
              assert.deepStrictEqual(values, [testValues[2]]);
              return {
                embeddings: dummyEmbeddings,
                response: {
                  body: { third: true },
                },
              };
            default:
              throw new Error('Unexpected call');
          }
        },
      }),
      values: testValues,
    });

    expect(result.responses).toMatchSnapshot();

});
});

describe('result.values', () => {
it('should include values in the result', async () => {
const result = await embedMany({
model: new MockEmbeddingModelV3({
maxEmbeddingsPerCall: 5,
doEmbed: mockEmbed(testValues, dummyEmbeddings),
}),
values: testValues,
});

    assert.deepStrictEqual(result.values, testValues);

});
});

describe('result.usage', () => {
it('should include usage in the result', async () => {
let callCount = 0;

    const result = await embedMany({
      model: new MockEmbeddingModelV3({
        maxEmbeddingsPerCall: 2,
        doEmbed: async () => {
          switch (callCount++) {
            case 0:
              return {
                embeddings: dummyEmbeddings.slice(0, 2),
                usage: { tokens: 10 },
              };
            case 1:
              return {
                embeddings: dummyEmbeddings.slice(2),
                usage: { tokens: 20 },
              };
            default:
              throw new Error('Unexpected call');
          }
        },
      }),
      values: testValues,
    });

    assert.deepStrictEqual(result.usage, { tokens: 30 });

});
});

describe('options.headers', () => {
it('should set headers', async () => {
const result = await embedMany({
model: new MockEmbeddingModelV3({
maxEmbeddingsPerCall: 5,
doEmbed: async ({ headers }) => {
assert.deepStrictEqual(headers, {
'custom-request-header': 'request-header-value',
'user-agent': 'ai/0.0.0-test',
});

          return { embeddings: dummyEmbeddings };
        },
      }),
      values: testValues,
      headers: {
        'custom-request-header': 'request-header-value',
      },
    });

    assert.deepStrictEqual(result.embeddings, dummyEmbeddings);

});
});

describe('options.providerOptions', () => {
it('should pass provider options to model', async () => {
const model = new MockEmbeddingModelV3({
doEmbed: async ({ providerOptions }) => {
return { embeddings: [[1, 2, 3]] };
},
});

    vi.spyOn(model, 'doEmbed');

    await embedMany({
      model,
      values: ['test-input'],
      providerOptions: {
        aProvider: { someKey: 'someValue' },
      },
    });

    expect(model.doEmbed).toHaveBeenCalledWith({
      abortSignal: undefined,
      headers: {
        'user-agent': 'ai/0.0.0-test',
      },
      providerOptions: {
        aProvider: { someKey: 'someValue' },
      },
      values: ['test-input'],
    });

});
});

describe('telemetry', () => {
let tracer: MockTracer;

beforeEach(() => {
tracer = new MockTracer();
});

it('should not record any telemetry data when not explicitly enabled', async () => {
await embedMany({
model: new MockEmbeddingModelV3({
maxEmbeddingsPerCall: 5,
doEmbed: mockEmbed(testValues, dummyEmbeddings),
}),
values: testValues,
});

    assert.deepStrictEqual(tracer.jsonSpans, []);

});

it('should record telemetry data when enabled (multiple calls path)', async () => {
let callCount = 0;

    await embedMany({
      model: new MockEmbeddingModelV3({
        maxEmbeddingsPerCall: 2,
        doEmbed: async ({ values }) => {
          switch (callCount++) {
            case 0:
              assert.deepStrictEqual(values, testValues.slice(0, 2));
              return {
                embeddings: dummyEmbeddings.slice(0, 2),
                usage: { tokens: 10 },
              };
            case 1:
              assert.deepStrictEqual(values, testValues.slice(2));
              return {
                embeddings: dummyEmbeddings.slice(2),
                usage: { tokens: 20 },
              };
            default:
              throw new Error('Unexpected call');
          }
        },
      }),
      values: testValues,
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'test-function-id',
        metadata: {
          test1: 'value1',
          test2: false,
        },
        tracer,
      },
    });

    expect(tracer.jsonSpans).toMatchSnapshot();

});

it('should record telemetry data when enabled (single call path)', async () => {
await embedMany({
model: new MockEmbeddingModelV3({
maxEmbeddingsPerCall: null,
doEmbed: mockEmbed(testValues, dummyEmbeddings, { tokens: 10 }),
}),
values: testValues,
experimental_telemetry: {
isEnabled: true,
functionId: 'test-function-id',
metadata: {
test1: 'value1',
test2: false,
},
tracer,
},
});

    expect(tracer.jsonSpans).toMatchSnapshot();

});

it('should not record telemetry inputs / outputs when disabled', async () => {
await embedMany({
model: new MockEmbeddingModelV3({
maxEmbeddingsPerCall: null,
doEmbed: mockEmbed(testValues, dummyEmbeddings, { tokens: 10 }),
}),
values: testValues,
experimental_telemetry: {
isEnabled: true,
recordInputs: false,
recordOutputs: false,
tracer,
},
});

    expect(tracer.jsonSpans).toMatchSnapshot();

});
});

describe('result.providerMetadata', () => {
it('should include provider metadata when returned by the model', async () => {
const providerMetadata = {
gateway: { routing: { resolvedProvider: 'test-provider' } },
};

    const result = await embedMany({
      model: new MockEmbeddingModelV3({
        supportsParallelCalls: false,
        maxEmbeddingsPerCall: 3,
        doEmbed: mockEmbed(
          testValues,
          dummyEmbeddings,
          undefined,
          {
            headers: {},
            body: {},
          },
          providerMetadata,
        ),
      }),
      values: testValues,
    });

    expect(result.providerMetadata).toStrictEqual(providerMetadata);

});
});

function mockEmbed<VALUE>(
expectedValues: Array<VALUE>,
embeddings: Array<Embedding>,
usage?: EmbeddingModelUsage,
response: Awaited<
ReturnType<EmbeddingModelV3<VALUE>['doEmbed']>

> ['response'] = { headers: {}, body: {} },
> providerMetadata?: Awaited<

    ReturnType<EmbeddingModelV3<VALUE>['doEmbed']>

> ['providerMetadata'],
> ): EmbeddingModelV3<VALUE>['doEmbed'] {
> return async ({ values }) => {

    assert.deepStrictEqual(expectedValues, values);
    return { embeddings, usage, response, providerMetadata };

};
}

================================================
FILE: packages/ai/src/embed/embed-many.ts
================================================
import { ProviderOptions, withUserAgentSuffix } from '@ai-sdk/provider-utils';
import { prepareRetries } from '../util/prepare-retries';
import { splitArray } from '../util/split-array';
import { UnsupportedModelVersionError } from '../error/unsupported-model-version-error';
import { assembleOperationName } from '../telemetry/assemble-operation-name';
import { getBaseTelemetryAttributes } from '../telemetry/get-base-telemetry-attributes';
import { getTracer } from '../telemetry/get-tracer';
import { recordSpan } from '../telemetry/record-span';
import { selectTelemetryAttributes } from '../telemetry/select-telemetry-attributes';
import { TelemetrySettings } from '../telemetry/telemetry-settings';
import { Embedding, EmbeddingModel, ProviderMetadata } from '../types';
import { resolveEmbeddingModel } from '../model/resolve-model';
import { EmbedManyResult } from './embed-many-result';
import { VERSION } from '../version';

/\*\*
Embed several values using an embedding model. The type of the value is defined
by the embedding model.

`embedMany` automatically splits large requests into smaller chunks if the model
has a limit on how many embeddings can be generated in a single call.

@param model - The embedding model to use.
@param values - The values that should be embedded.

@param maxRetries - Maximum number of retries. Set to 0 to disable retries. Default: 2.
@param abortSignal - An optional abort signal that can be used to cancel the call.
@param headers - Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.

@returns A result object that contains the embeddings, the value, and additional information.
_/
export async function embedMany<VALUE = string>({
model: modelArg,
values,
maxParallelCalls = Infinity,
maxRetries: maxRetriesArg,
abortSignal,
headers,
providerOptions,
experimental_telemetry: telemetry,
}: {
/\*\*
The embedding model to use.
_/
model: EmbeddingModel<VALUE>;

/\*_
The values that should be embedded.
_/
values: Array<VALUE>;

/\*\*
Maximum number of retries per embedding model call. Set to 0 to disable retries.

@default 2
\*/
maxRetries?: number;

/\*_
Abort signal.
_/
abortSignal?: AbortSignal;

/\*_
Additional headers to include in the request.
Only applicable for HTTP-based providers.
_/
headers?: Record<string, string>;

/\*\*

- Optional telemetry configuration (experimental).
  \*/
  experimental_telemetry?: TelemetrySettings;

/\*_
Additional provider-specific options. They are passed through
to the provider from the AI SDK and enable provider-specific
functionality that can be fully encapsulated in the provider.
_/
providerOptions?: ProviderOptions;

/\*\*

- Maximum number of concurrent requests.
-
- @default Infinity
  \*/
  maxParallelCalls?: number;
  }): Promise<EmbedManyResult<VALUE>> {
  const model = resolveEmbeddingModel<VALUE>(modelArg);

const { maxRetries, retry } = prepareRetries({
maxRetries: maxRetriesArg,
abortSignal,
});

const headersWithUserAgent = withUserAgentSuffix(
headers ?? {},
`ai/${VERSION}`,
);

const baseTelemetryAttributes = getBaseTelemetryAttributes({
model,
telemetry,
headers: headersWithUserAgent,
settings: { maxRetries },
});

const tracer = getTracer(telemetry);

return recordSpan({
name: 'ai.embedMany',
attributes: selectTelemetryAttributes({
telemetry,
attributes: {
...assembleOperationName({ operationId: 'ai.embedMany', telemetry }),
...baseTelemetryAttributes,
// specific settings that only make sense on the outer level:
'ai.values': {
input: () => values.map(value => JSON.stringify(value)),
},
},
}),
tracer,
fn: async span => {
const [maxEmbeddingsPerCall, supportsParallelCalls] = await Promise.all([
model.maxEmbeddingsPerCall,
model.supportsParallelCalls,
]);

      // the model has not specified limits on
      // how many embeddings can be generated in a single call
      if (maxEmbeddingsPerCall == null || maxEmbeddingsPerCall === Infinity) {
        const { embeddings, usage, response, providerMetadata } = await retry(
          () => {
            // nested spans to align with the embedMany telemetry data:
            return recordSpan({
              name: 'ai.embedMany.doEmbed',
              attributes: selectTelemetryAttributes({
                telemetry,
                attributes: {
                  ...assembleOperationName({
                    operationId: 'ai.embedMany.doEmbed',
                    telemetry,
                  }),
                  ...baseTelemetryAttributes,
                  // specific settings that only make sense on the outer level:
                  'ai.values': {
                    input: () => values.map(value => JSON.stringify(value)),
                  },
                },
              }),
              tracer,
              fn: async doEmbedSpan => {
                const modelResponse = await model.doEmbed({
                  values,
                  abortSignal,
                  headers: headersWithUserAgent,
                  providerOptions,
                });

                const embeddings = modelResponse.embeddings;
                const usage = modelResponse.usage ?? { tokens: NaN };

                doEmbedSpan.setAttributes(
                  await selectTelemetryAttributes({
                    telemetry,
                    attributes: {
                      'ai.embeddings': {
                        output: () =>
                          embeddings.map(embedding =>
                            JSON.stringify(embedding),
                          ),
                      },
                      'ai.usage.tokens': usage.tokens,
                    },
                  }),
                );

                return {
                  embeddings,
                  usage,
                  providerMetadata: modelResponse.providerMetadata,
                  response: modelResponse.response,
                };
              },
            });
          },
        );

        span.setAttributes(
          await selectTelemetryAttributes({
            telemetry,
            attributes: {
              'ai.embeddings': {
                output: () =>
                  embeddings.map(embedding => JSON.stringify(embedding)),
              },
              'ai.usage.tokens': usage.tokens,
            },
          }),
        );

        return new DefaultEmbedManyResult({
          values,
          embeddings,
          usage,
          providerMetadata,
          responses: [response],
        });
      }

      // split the values into chunks that are small enough for the model:
      const valueChunks = splitArray(values, maxEmbeddingsPerCall);

      // serially embed the chunks:
      const embeddings: Array<Embedding> = [];
      const responses: Array<
        | {
            headers?: Record<string, string>;
            body?: unknown;
          }
        | undefined
      > = [];
      let tokens = 0;
      let providerMetadata: ProviderMetadata | undefined;

      const parallelChunks = splitArray(
        valueChunks,
        supportsParallelCalls ? maxParallelCalls : 1,
      );

      for (const parallelChunk of parallelChunks) {
        const results = await Promise.all(
          parallelChunk.map(chunk => {
            return retry(() => {
              // nested spans to align with the embedMany telemetry data:
              return recordSpan({
                name: 'ai.embedMany.doEmbed',
                attributes: selectTelemetryAttributes({
                  telemetry,
                  attributes: {
                    ...assembleOperationName({
                      operationId: 'ai.embedMany.doEmbed',
                      telemetry,
                    }),
                    ...baseTelemetryAttributes,
                    // specific settings that only make sense on the outer level:
                    'ai.values': {
                      input: () => chunk.map(value => JSON.stringify(value)),
                    },
                  },
                }),
                tracer,
                fn: async doEmbedSpan => {
                  const modelResponse = await model.doEmbed({
                    values: chunk,
                    abortSignal,
                    headers: headersWithUserAgent,
                    providerOptions,
                  });

                  const embeddings = modelResponse.embeddings;
                  const usage = modelResponse.usage ?? { tokens: NaN };

                  doEmbedSpan.setAttributes(
                    await selectTelemetryAttributes({
                      telemetry,
                      attributes: {
                        'ai.embeddings': {
                          output: () =>
                            embeddings.map(embedding =>
                              JSON.stringify(embedding),
                            ),
                        },
                        'ai.usage.tokens': usage.tokens,
                      },
                    }),
                  );

                  return {
                    embeddings,
                    usage,
                    providerMetadata: modelResponse.providerMetadata,
                    response: modelResponse.response,
                  };
                },
              });
            });
          }),
        );

        for (const result of results) {
          embeddings.push(...result.embeddings);
          responses.push(result.response);
          tokens += result.usage.tokens;
          if (result.providerMetadata) {
            if (!providerMetadata) {
              providerMetadata = { ...result.providerMetadata };
            } else {
              for (const [providerName, metadata] of Object.entries(
                result.providerMetadata,
              )) {
                providerMetadata[providerName] = {
                  ...(providerMetadata[providerName] ?? {}),
                  ...metadata,
                };
              }
            }
          }
        }
      }

      span.setAttributes(
        await selectTelemetryAttributes({
          telemetry,
          attributes: {
            'ai.embeddings': {
              output: () =>
                embeddings.map(embedding => JSON.stringify(embedding)),
            },
            'ai.usage.tokens': tokens,
          },
        }),
      );

      return new DefaultEmbedManyResult({
        values,
        embeddings,
        usage: { tokens },
        providerMetadata: providerMetadata,
        responses,
      });
    },

});
}

class DefaultEmbedManyResult<VALUE> implements EmbedManyResult<VALUE> {
readonly values: EmbedManyResult<VALUE>['values'];
readonly embeddings: EmbedManyResult<VALUE>['embeddings'];
readonly usage: EmbedManyResult<VALUE>['usage'];
readonly providerMetadata: EmbedManyResult<VALUE>['providerMetadata'];
readonly responses: EmbedManyResult<VALUE>['responses'];

constructor(options: {
values: EmbedManyResult<VALUE>['values'];
embeddings: EmbedManyResult<VALUE>['embeddings'];
usage: EmbedManyResult<VALUE>['usage'];
providerMetadata?: EmbedManyResult<VALUE>['providerMetadata'];
responses?: EmbedManyResult<VALUE>['responses'];
}) {
this.values = options.values;
this.embeddings = options.embeddings;
this.usage = options.usage;
this.providerMetadata = options.providerMetadata;
this.responses = options.responses;
}
}

================================================
FILE: packages/ai/src/embed/embed-result.ts
================================================
import { Embedding } from '../types';
import { EmbeddingModelUsage } from '../types/usage';
import { ProviderMetadata } from '../types';

/**
The result of an `embed` call.
It contains the embedding, the value, and additional information.
\*/
export interface EmbedResult<VALUE> {
/**
The value that was embedded.
\*/
readonly value: VALUE;

/\*_
The embedding of the value.
_/
readonly embedding: Embedding;

/\*_
The embedding token usage.
_/
readonly usage: EmbeddingModelUsage;

/\*_
Optional provider-specific metadata.
_/
readonly providerMetadata?: ProviderMetadata;

/**
Optional response data.
\*/
readonly response?: {
/**
Response headers.
\*/
headers?: Record<string, string>;

    /**
    The response body.
    */
    body?: unknown;

};
}

================================================
FILE: packages/ai/src/embed/embed.test.ts
================================================
import { EmbeddingModelV3 } from '@ai-sdk/provider';
import assert from 'node:assert';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockEmbeddingModelV3 } from '../test/mock-embedding-model-v3';
import { MockTracer } from '../test/mock-tracer';
import { Embedding, EmbeddingModelUsage } from '../types';
import { embed } from './embed';

const dummyEmbedding = [0.1, 0.2, 0.3];
const testValue = 'sunny day at the beach';

vi.mock('../version', () => {
return {
VERSION: '0.0.0-test',
};
});

describe('result.embedding', () => {
it('should generate embedding', async () => {
const result = await embed({
model: new MockEmbeddingModelV3({
doEmbed: mockEmbed([testValue], [dummyEmbedding]),
}),
value: testValue,
});

    assert.deepStrictEqual(result.embedding, dummyEmbedding);

});
});

describe('result.response', () => {
it('should include response in the result', async () => {
const result = await embed({
model: new MockEmbeddingModelV3({
doEmbed: mockEmbed([testValue], [dummyEmbedding], undefined, {
body: { foo: 'bar' },
headers: { foo: 'bar' },
}),
}),
value: testValue,
});

    expect(result.response?.body).toMatchInlineSnapshot(`
      {
        "foo": "bar",
      }
    `);
    expect(result.response?.headers).toMatchInlineSnapshot(`
      {
        "foo": "bar",
      }
    `);

});
});

describe('result.value', () => {
it('should include value in the result', async () => {
const result = await embed({
model: new MockEmbeddingModelV3({
doEmbed: mockEmbed([testValue], [dummyEmbedding]),
}),
value: testValue,
});

    assert.deepStrictEqual(result.value, testValue);

});
});

describe('result.usage', () => {
it('should include usage in the result', async () => {
const result = await embed({
model: new MockEmbeddingModelV3({
doEmbed: mockEmbed([testValue], [dummyEmbedding], { tokens: 10 }),
}),
value: testValue,
});

    assert.deepStrictEqual(result.usage, { tokens: 10 });

});
});

describe('result.providerMetadata', () => {
it('should include provider metadata when returned by the model', async () => {
const providerMetadata = {
gateway: {
routing: {
resolvedProvider: 'test-provider',
},
},
};

    const result = await embed({
      model: new MockEmbeddingModelV3({
        doEmbed: mockEmbed(
          [testValue],
          [dummyEmbedding],
          undefined,
          {
            headers: {},
            body: {},
          },
          providerMetadata,
        ),
      }),
      value: testValue,
    });

    expect(result.providerMetadata).toStrictEqual(providerMetadata);

});
});

describe('options.headers', () => {
it('should set headers', async () => {
const result = await embed({
model: new MockEmbeddingModelV3({
doEmbed: async ({ headers }) => {
assert.deepStrictEqual(headers, {
'custom-request-header': 'request-header-value',
'user-agent': 'ai/0.0.0-test',
});

          return { embeddings: [dummyEmbedding] };
        },
      }),
      value: testValue,
      headers: {
        'custom-request-header': 'request-header-value',
      },
    });

    assert.deepStrictEqual(result.embedding, dummyEmbedding);

});
});

describe('options.providerOptions', () => {
it('should pass provider options to model', async () => {
const result = await embed({
model: new MockEmbeddingModelV3({
doEmbed: async ({ providerOptions }) => {
expect(providerOptions).toStrictEqual({
aProvider: { someKey: 'someValue' },
});

          return { embeddings: [[1, 2, 3]] };
        },
      }),
      value: 'test-input',
      providerOptions: {
        aProvider: { someKey: 'someValue' },
      },
    });

    expect(result.embedding).toStrictEqual([1, 2, 3]);

});
});

describe('telemetry', () => {
let tracer: MockTracer;

beforeEach(() => {
tracer = new MockTracer();
});

it('should not record any telemetry data when not explicitly enabled', async () => {
await embed({
model: new MockEmbeddingModelV3({
doEmbed: mockEmbed([testValue], [dummyEmbedding]),
}),
value: testValue,
experimental_telemetry: { tracer },
});

    expect(tracer.jsonSpans).toMatchSnapshot();

});

it('should record telemetry data when enabled', async () => {
await embed({
model: new MockEmbeddingModelV3({
doEmbed: mockEmbed([testValue], [dummyEmbedding], { tokens: 10 }),
}),
value: testValue,
experimental_telemetry: {
isEnabled: true,
functionId: 'test-function-id',
metadata: {
test1: 'value1',
test2: false,
},
tracer,
},
});

    expect(tracer.jsonSpans).toMatchSnapshot();

});

it('should not record telemetry inputs / outputs when disabled', async () => {
await embed({
model: new MockEmbeddingModelV3({
doEmbed: mockEmbed([testValue], [dummyEmbedding], { tokens: 10 }),
}),
value: testValue,
experimental_telemetry: {
isEnabled: true,
recordInputs: false,
recordOutputs: false,
tracer,
},
});

    expect(tracer.jsonSpans).toMatchSnapshot();

});
});

function mockEmbed<VALUE>(
expectedValues: Array<VALUE>,
embeddings: Array<Embedding>,
usage?: EmbeddingModelUsage,
response: Awaited<
ReturnType<EmbeddingModelV3<VALUE>['doEmbed']>

> ['response'] = { headers: {}, body: {} },
> providerMetadata?: Awaited<

    ReturnType<EmbeddingModelV3<VALUE>['doEmbed']>

> ['providerMetadata'],
> ): EmbeddingModelV3<VALUE>['doEmbed'] {
> return async ({ values }) => {

    assert.deepStrictEqual(expectedValues, values);
    return { embeddings, usage, response, providerMetadata };

};
}

================================================
FILE: packages/ai/src/embed/embed.ts
================================================
import { ProviderOptions, withUserAgentSuffix } from '@ai-sdk/provider-utils';
import { resolveEmbeddingModel } from '../model/resolve-model';
import { assembleOperationName } from '../telemetry/assemble-operation-name';
import { getBaseTelemetryAttributes } from '../telemetry/get-base-telemetry-attributes';
import { getTracer } from '../telemetry/get-tracer';
import { recordSpan } from '../telemetry/record-span';
import { selectTelemetryAttributes } from '../telemetry/select-telemetry-attributes';
import { TelemetrySettings } from '../telemetry/telemetry-settings';
import { EmbeddingModel } from '../types';
import { prepareRetries } from '../util/prepare-retries';
import { EmbedResult } from './embed-result';
import { VERSION } from '../version';

/\*\*
Embed a value using an embedding model. The type of the value is defined by the embedding model.

@param model - The embedding model to use.
@param value - The value that should be embedded.

@param maxRetries - Maximum number of retries. Set to 0 to disable retries. Default: 2.
@param abortSignal - An optional abort signal that can be used to cancel the call.
@param headers - Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.

@returns A result object that contains the embedding, the value, and additional information.
_/
export async function embed<VALUE = string>({
model: modelArg,
value,
providerOptions,
maxRetries: maxRetriesArg,
abortSignal,
headers,
experimental_telemetry: telemetry,
}: {
/\*\*
The embedding model to use.
_/
model: EmbeddingModel<VALUE>;

/\*_
The value that should be embedded.
_/
value: VALUE;

/\*\*
Maximum number of retries per embedding model call. Set to 0 to disable retries.

@default 2
\*/
maxRetries?: number;

/\*_
Abort signal.
_/
abortSignal?: AbortSignal;

/\*_
Additional headers to include in the request.
Only applicable for HTTP-based providers.
_/
headers?: Record<string, string>;

/\*_
Additional provider-specific options. They are passed through
to the provider from the AI SDK and enable provider-specific
functionality that can be fully encapsulated in the provider.
_/
providerOptions?: ProviderOptions;

/\*\*

- Optional telemetry configuration (experimental).
  \*/
  experimental_telemetry?: TelemetrySettings;
  }): Promise<EmbedResult<VALUE>> {
  const model = resolveEmbeddingModel<VALUE>(modelArg);

const { maxRetries, retry } = prepareRetries({
maxRetries: maxRetriesArg,
abortSignal,
});

const headersWithUserAgent = withUserAgentSuffix(
headers ?? {},
`ai/${VERSION}`,
);

const baseTelemetryAttributes = getBaseTelemetryAttributes({
model: model,
telemetry,
headers: headersWithUserAgent,
settings: { maxRetries },
});

const tracer = getTracer(telemetry);

return recordSpan({
name: 'ai.embed',
attributes: selectTelemetryAttributes({
telemetry,
attributes: {
...assembleOperationName({ operationId: 'ai.embed', telemetry }),
...baseTelemetryAttributes,
'ai.value': { input: () => JSON.stringify(value) },
},
}),
tracer,
fn: async span => {
const { embedding, usage, response, providerMetadata } = await retry(() =>
// nested spans to align with the embedMany telemetry data:
recordSpan({
name: 'ai.embed.doEmbed',
attributes: selectTelemetryAttributes({
telemetry,
attributes: {
...assembleOperationName({
operationId: 'ai.embed.doEmbed',
telemetry,
}),
...baseTelemetryAttributes,
// specific settings that only make sense on the outer level:
'ai.values': { input: () => [JSON.stringify(value)] },
},
}),
tracer,
fn: async doEmbedSpan => {
const modelResponse = await model.doEmbed({
values: [value],
abortSignal,
headers: headersWithUserAgent,
providerOptions,
});

            const embedding = modelResponse.embeddings[0];
            const usage = modelResponse.usage ?? { tokens: NaN };

            doEmbedSpan.setAttributes(
              await selectTelemetryAttributes({
                telemetry,
                attributes: {
                  'ai.embeddings': {
                    output: () =>
                      modelResponse.embeddings.map(embedding =>
                        JSON.stringify(embedding),
                      ),
                  },
                  'ai.usage.tokens': usage.tokens,
                },
              }),
            );

            return {
              embedding,
              usage,
              providerMetadata: modelResponse.providerMetadata,
              response: modelResponse.response,
            };
          },
        }),
      );

      span.setAttributes(
        await selectTelemetryAttributes({
          telemetry,
          attributes: {
            'ai.embedding': { output: () => JSON.stringify(embedding) },
            'ai.usage.tokens': usage.tokens,
          },
        }),
      );

      return new DefaultEmbedResult({
        value,
        embedding,
        usage,
        providerMetadata,
        response,
      });
    },

});
}

class DefaultEmbedResult<VALUE> implements EmbedResult<VALUE> {
readonly value: EmbedResult<VALUE>['value'];
readonly embedding: EmbedResult<VALUE>['embedding'];
readonly usage: EmbedResult<VALUE>['usage'];
readonly providerMetadata: EmbedResult<VALUE>['providerMetadata'];
readonly response: EmbedResult<VALUE>['response'];

constructor(options: {
value: EmbedResult<VALUE>['value'];
embedding: EmbedResult<VALUE>['embedding'];
usage: EmbedResult<VALUE>['usage'];
providerMetadata?: EmbedResult<VALUE>['providerMetadata'];
response?: EmbedResult<VALUE>['response'];
}) {
this.value = options.value;
this.embedding = options.embedding;
this.usage = options.usage;
this.providerMetadata = options.providerMetadata;
this.response = options.response;
}
}

================================================
FILE: packages/ai/src/embed/index.ts
================================================
export _ from './embed';
export _ from './embed-many';
export _ from './embed-many-result';
export _ from './embed-result';

================================================
FILE: packages/ai/src/embed/**snapshots**/embed-many.test.ts.snap
================================================
// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html

exports[`result.responses > should include responses in the result 1`] = `[
  {
    "body": {
      "first": true,
    },
  },
  {
    "body": {
      "second": true,
    },
  },
  {
    "body": {
      "third": true,
    },
  },
]`;

exports[`telemetry > should not record telemetry inputs / outputs when disabled 1`] = `[
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embedMany",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.usage.tokens": 10,
      "operation.name": "ai.embedMany",
    },
    "events": [],
    "name": "ai.embedMany",
  },
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embedMany.doEmbed",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.usage.tokens": 10,
      "operation.name": "ai.embedMany.doEmbed",
    },
    "events": [],
    "name": "ai.embedMany.doEmbed",
  },
]`;

exports[`telemetry > should record telemetry data when enabled (multiple calls path) 1`] = `[
  {
    "attributes": {
      "ai.embeddings": [
        "[0.1,0.2,0.3]",
        "[0.4,0.5,0.6]",
        "[0.7,0.8,0.9]",
      ],
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embedMany",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.tokens": 30,
      "ai.values": [
        ""sunny day at the beach"",
        ""rainy afternoon in the city"",
        ""snowy night in the mountains"",
      ],
      "operation.name": "ai.embedMany test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.embedMany",
  },
  {
    "attributes": {
      "ai.embeddings": [
        "[0.1,0.2,0.3]",
        "[0.4,0.5,0.6]",
      ],
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embedMany.doEmbed",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.tokens": 10,
      "ai.values": [
        ""sunny day at the beach"",
        ""rainy afternoon in the city"",
      ],
      "operation.name": "ai.embedMany.doEmbed test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.embedMany.doEmbed",
  },
  {
    "attributes": {
      "ai.embeddings": [
        "[0.7,0.8,0.9]",
      ],
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embedMany.doEmbed",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.tokens": 20,
      "ai.values": [
        ""snowy night in the mountains"",
      ],
      "operation.name": "ai.embedMany.doEmbed test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.embedMany.doEmbed",
  },
]`;

exports[`telemetry > should record telemetry data when enabled (single call path) 1`] = `[
  {
    "attributes": {
      "ai.embeddings": [
        "[0.1,0.2,0.3]",
        "[0.4,0.5,0.6]",
        "[0.7,0.8,0.9]",
      ],
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embedMany",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.tokens": 10,
      "ai.values": [
        ""sunny day at the beach"",
        ""rainy afternoon in the city"",
        ""snowy night in the mountains"",
      ],
      "operation.name": "ai.embedMany test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.embedMany",
  },
  {
    "attributes": {
      "ai.embeddings": [
        "[0.1,0.2,0.3]",
        "[0.4,0.5,0.6]",
        "[0.7,0.8,0.9]",
      ],
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embedMany.doEmbed",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.tokens": 10,
      "ai.values": [
        ""sunny day at the beach"",
        ""rainy afternoon in the city"",
        ""snowy night in the mountains"",
      ],
      "operation.name": "ai.embedMany.doEmbed test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.embedMany.doEmbed",
  },
]`;

================================================
FILE: packages/ai/src/embed/**snapshots**/embed.test.ts.snap
================================================
// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html

exports[`telemetry > should not record any telemetry data when not explicitly enabled 1`] = `[]`;

exports[`telemetry > should not record telemetry inputs / outputs when disabled 1`] = `[
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embed",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.usage.tokens": 10,
      "operation.name": "ai.embed",
    },
    "events": [],
    "name": "ai.embed",
  },
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embed.doEmbed",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.usage.tokens": 10,
      "operation.name": "ai.embed.doEmbed",
    },
    "events": [],
    "name": "ai.embed.doEmbed",
  },
]`;

exports[`telemetry > should record telemetry data when enabled 1`] = `[
  {
    "attributes": {
      "ai.embedding": "[0.1,0.2,0.3]",
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embed",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.tokens": 10,
      "ai.value": ""sunny day at the beach"",
      "operation.name": "ai.embed test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.embed",
  },
  {
    "attributes": {
      "ai.embeddings": [
        "[0.1,0.2,0.3]",
      ],
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.embed.doEmbed",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.settings.maxRetries": 2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.tokens": 10,
      "ai.values": [
        ""sunny day at the beach"",
      ],
      "operation.name": "ai.embed.doEmbed test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.embed.doEmbed",
  },
]`;

================================================
FILE: packages/ai/src/error/index.ts
================================================
export {
AISDKError,
APICallError,
EmptyResponseBodyError,
InvalidPromptError,
InvalidResponseDataError,
JSONParseError,
LoadAPIKeyError,
LoadSettingError,
NoContentGeneratedError,
NoSuchModelError,
TooManyEmbeddingValuesForCallError,
TypeValidationError,
UnsupportedFunctionalityError,
} from '@ai-sdk/provider';

export { InvalidArgumentError } from './invalid-argument-error';
export { InvalidStreamPartError } from './invalid-stream-part-error';
export { InvalidToolInputError } from './invalid-tool-input-error';
export { NoImageGeneratedError } from './no-image-generated-error';
export { NoObjectGeneratedError } from './no-object-generated-error';
export { NoOutputGeneratedError } from './no-output-generated-error';
export { NoSpeechGeneratedError } from './no-speech-generated-error';
export { NoSuchToolError } from './no-such-tool-error';
export { ToolCallRepairError } from './tool-call-repair-error';
export { UnsupportedModelVersionError } from './unsupported-model-version-error';

export { InvalidDataContentError } from '../prompt/invalid-data-content-error';
export { InvalidMessageRoleError } from '../prompt/invalid-message-role-error';
export { MessageConversionError } from '../prompt/message-conversion-error';
export { DownloadError } from '../util/download/download-error';
export { RetryError } from '../util/retry-error';

================================================
FILE: packages/ai/src/error/invalid-argument-error.ts
================================================
import { AISDKError } from '@ai-sdk/provider';

const name = 'AI_InvalidArgumentError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

export class InvalidArgumentError extends AISDKError {
private readonly [symbol] = true; // used in isInstance

readonly parameter: string;
readonly value: unknown;

constructor({
parameter,
value,
message,
}: {
parameter: string;
value: unknown;
message: string;
}) {
super({
name,
message: `Invalid argument for parameter ${parameter}: ${message}`,
});

    this.parameter = parameter;
    this.value = value;

}

static isInstance(error: unknown): error is InvalidArgumentError {
return AISDKError.hasMarker(error, marker);
}
}

================================================
FILE: packages/ai/src/error/invalid-stream-part-error.ts
================================================
import { AISDKError } from '@ai-sdk/provider';
import { SingleRequestTextStreamPart } from '../generate-text/run-tools-transformation';

const name = 'AI_InvalidStreamPartError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

export class InvalidStreamPartError extends AISDKError {
private readonly [symbol] = true; // used in isInstance

readonly chunk: SingleRequestTextStreamPart<any>;

constructor({
chunk,
message,
}: {
chunk: SingleRequestTextStreamPart<any>;
message: string;
}) {
super({ name, message });

    this.chunk = chunk;

}

static isInstance(error: unknown): error is InvalidStreamPartError {
return AISDKError.hasMarker(error, marker);
}
}

================================================
FILE: packages/ai/src/error/invalid-tool-input-error.ts
================================================
import { AISDKError, getErrorMessage } from '@ai-sdk/provider';

const name = 'AI_InvalidToolInputError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

export class InvalidToolInputError extends AISDKError {
private readonly [symbol] = true; // used in isInstance

readonly toolName: string;
readonly toolInput: string;

constructor({
toolInput,
toolName,
cause,
message = `Invalid input for tool ${toolName}: ${getErrorMessage(cause)}`,
}: {
message?: string;
toolInput: string;
toolName: string;
cause: unknown;
}) {
super({ name, message, cause });

    this.toolInput = toolInput;
    this.toolName = toolName;

}

static isInstance(error: unknown): error is InvalidToolInputError {
return AISDKError.hasMarker(error, marker);
}
}

================================================
FILE: packages/ai/src/error/no-image-generated-error.ts
================================================
import { AISDKError } from '@ai-sdk/provider';
import { ImageModelResponseMetadata } from '../types/image-model-response-metadata';

const name = 'AI_NoImageGeneratedError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

/\*\*
Thrown when no image could be generated. This can have multiple causes:

- The model failed to generate a response.
- The model generated a response that could not be parsed.
  \*/
  export class NoImageGeneratedError extends AISDKError {
  private readonly [symbol] = true; // used in isInstance

  /\*_
  The response metadata for each call.
  _/
  readonly responses: Array<ImageModelResponseMetadata> | undefined;

  constructor({
  message = 'No image generated.',
  cause,
  responses,
  }: {
  message?: string;
  cause?: Error;
  responses?: Array<ImageModelResponseMetadata>;
  }) {
  super({ name, message, cause });

      this.responses = responses;

  }

  static isInstance(error: unknown): error is NoImageGeneratedError {
  return AISDKError.hasMarker(error, marker);
  }
  }

================================================
FILE: packages/ai/src/error/no-object-generated-error.ts
================================================
import { AISDKError } from '@ai-sdk/provider';
import { FinishReason } from '../types/language-model';
import { LanguageModelResponseMetadata } from '../types/language-model-response-metadata';
import { LanguageModelUsage } from '../types/usage';

const name = 'AI_NoObjectGeneratedError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

/\*\*
Thrown when no object could be generated. This can have several causes:

- The model failed to generate a response.
- The model generated a response that could not be parsed.
- The model generated a response that could not be validated against the schema.

The error contains the following properties:

- `text`: The text that was generated by the model. This can be the raw text or the tool call text, depending on the model.
  \*/
  export class NoObjectGeneratedError extends AISDKError {
  private readonly [symbol] = true; // used in isInstance

  /\*_
  The text that was generated by the model. This can be the raw text or the tool call text, depending on the model.
  _/
  readonly text: string | undefined;

  /\*_
  The response metadata.
  _/
  readonly response: LanguageModelResponseMetadata | undefined;

  /\*_
  The usage of the model.
  _/
  readonly usage: LanguageModelUsage | undefined;

  /\*_
  Reason why the model finished generating a response.
  _/
  readonly finishReason: FinishReason | undefined;

  constructor({
  message = 'No object generated.',
  cause,
  text,
  response,
  usage,
  finishReason,
  }: {
  message?: string;
  cause?: Error;
  text?: string;
  response: LanguageModelResponseMetadata;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
  }) {
  super({ name, message, cause });

      this.text = text;
      this.response = response;
      this.usage = usage;
      this.finishReason = finishReason;

  }

  static isInstance(error: unknown): error is NoObjectGeneratedError {
  return AISDKError.hasMarker(error, marker);
  }
  }

================================================
FILE: packages/ai/src/error/no-output-generated-error.ts
================================================
import { AISDKError } from '@ai-sdk/provider';

const name = 'AI_NoOutputGeneratedError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

/\*_
Thrown when no LLM output was generated, e.g. because of errors.
_/
export class NoOutputGeneratedError extends AISDKError {
private readonly [symbol] = true; // used in isInstance

constructor({
message = 'No output generated.',
cause,
}: {
message?: string;
cause?: Error;
} = {}) {
super({ name, message, cause });
}

static isInstance(error: unknown): error is NoOutputGeneratedError {
return AISDKError.hasMarker(error, marker);
}
}

================================================
FILE: packages/ai/src/error/no-speech-generated-error.ts
================================================
import { AISDKError } from '@ai-sdk/provider';
import { SpeechModelResponseMetadata } from '../types/speech-model-response-metadata';

/\*_
Error that is thrown when no speech audio was generated.
_/
export class NoSpeechGeneratedError extends AISDKError {
readonly responses: Array<SpeechModelResponseMetadata>;

constructor(options: { responses: Array<SpeechModelResponseMetadata> }) {
super({
name: 'AI_NoSpeechGeneratedError',
message: 'No speech audio generated.',
});

    this.responses = options.responses;

}
}

================================================
FILE: packages/ai/src/error/no-such-tool-error.ts
================================================
import { AISDKError } from '@ai-sdk/provider';

const name = 'AI_NoSuchToolError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

export class NoSuchToolError extends AISDKError {
private readonly [symbol] = true; // used in isInstance

readonly toolName: string;
readonly availableTools: string[] | undefined;

constructor({
toolName,
availableTools = undefined,
message = `Model tried to call unavailable tool '${toolName}'. ${
      availableTools === undefined
        ? 'No tools are available.'
        : `Available tools: ${availableTools.join(', ')}.`
    }`,
}: {
toolName: string;
availableTools?: string[] | undefined;
message?: string;
}) {
super({ name, message });

    this.toolName = toolName;
    this.availableTools = availableTools;

}

static isInstance(error: unknown): error is NoSuchToolError {
return AISDKError.hasMarker(error, marker);
}
}

================================================
FILE: packages/ai/src/error/no-transcript-generated-error.ts
================================================
import { AISDKError } from '@ai-sdk/provider';
import { TranscriptionModelResponseMetadata } from '../types/transcription-model-response-metadata';

/\*_
Error that is thrown when no transcript was generated.
_/
export class NoTranscriptGeneratedError extends AISDKError {
readonly responses: Array<TranscriptionModelResponseMetadata>;

constructor(options: {
responses: Array<TranscriptionModelResponseMetadata>;
}) {
super({
name: 'AI_NoTranscriptGeneratedError',
message: 'No transcript generated.',
});

    this.responses = options.responses;

}
}

================================================
FILE: packages/ai/src/error/tool-call-repair-error.ts
================================================
import { AISDKError, getErrorMessage } from '@ai-sdk/provider';
import { InvalidToolInputError } from './invalid-tool-input-error';
import { NoSuchToolError } from './no-such-tool-error';

const name = 'AI_ToolCallRepairError';
const marker = `vercel.ai.error.${name}`;
const symbol = Symbol.for(marker);

export class ToolCallRepairError extends AISDKError {
private readonly [symbol] = true; // used in isInstance

readonly originalError: NoSuchToolError | InvalidToolInputError;

constructor({
cause,
originalError,
message = `Error repairing tool call: ${getErrorMessage(cause)}`,
}: {
message?: string;
cause: unknown;
originalError: NoSuchToolError | InvalidToolInputError;
}) {
super({ name, message, cause });
this.originalError = originalError;
}

static isInstance(error: unknown): error is ToolCallRepairError {
return AISDKError.hasMarker(error, marker);
}
}

================================================
FILE: packages/ai/src/error/unsupported-model-version-error.ts
================================================
import { AISDKError } from '@ai-sdk/provider';

/\*_
Error that is thrown when a model with an unsupported version is used.
_/
export class UnsupportedModelVersionError extends AISDKError {
readonly version: string;
readonly provider: string;
readonly modelId: string;

constructor(options: { version: string; provider: string; modelId: string }) {
super({
name: 'AI_UnsupportedModelVersionError',
message:
`Unsupported model version ${options.version} for provider "${options.provider}" and model "${options.modelId}". ` +
`AI SDK 5 only supports models that implement specification version "v2".`,
});

    this.version = options.version;
    this.provider = options.provider;
    this.modelId = options.modelId;

}
}

================================================
FILE: packages/ai/src/error/verify-no-object-generated-error.ts
================================================
import { expect } from 'vitest';

import {
FinishReason,
LanguageModelResponseMetadata,
LanguageModelUsage,
} from '../types';
import { NoObjectGeneratedError } from './no-object-generated-error';

export function verifyNoObjectGeneratedError(
error: unknown,
expected: {
message: string;
response: LanguageModelResponseMetadata & {
body?: string;
};
usage: LanguageModelUsage;
finishReason: FinishReason;
},
) {
expect(NoObjectGeneratedError.isInstance(error)).toBeTruthy();
const noObjectGeneratedError = error as NoObjectGeneratedError;
expect(noObjectGeneratedError.message).toEqual(expected.message);
expect(noObjectGeneratedError.response).toEqual(expected.response);
expect(noObjectGeneratedError.usage).toEqual(expected.usage);
expect(noObjectGeneratedError.finishReason).toEqual(expected.finishReason);
}

================================================
FILE: packages/ai/src/generate-image/generate-image-result.ts
================================================
import { GeneratedFile } from '../generate-text';
import {
ImageGenerationWarning,
ImageModelProviderMetadata,
} from '../types/image-model';
import { ImageModelResponseMetadata } from '../types/image-model-response-metadata';

/**
The result of a `generateImage` call.
It contains the images and additional information.
\*/
export interface GenerateImageResult {
/**
The first image that was generated.
\*/
readonly image: GeneratedFile;

/\*_
The images that were generated.
_/
readonly images: Array<GeneratedFile>;

/\*_
Warnings for the call, e.g. unsupported settings.
_/
readonly warnings: Array<ImageGenerationWarning>;

/\*_
Response metadata from the provider. There may be multiple responses if we made multiple calls to the model.
_/
readonly responses: Array<ImageModelResponseMetadata>;

/\*\*

- Provider-specific metadata. They are passed through from the provider to the AI SDK and enable provider-specific
- results that can be fully encapsulated in the provider.
  \*/
  readonly providerMetadata: ImageModelProviderMetadata;
  }

================================================
FILE: packages/ai/src/generate-image/generate-image.test.ts
================================================
import {
ImageModelV3,
ImageModelV3CallWarning,
ImageModelV3ProviderMetadata,
} from '@ai-sdk/provider';
import {
convertBase64ToUint8Array,
convertUint8ArrayToBase64,
} from '@ai-sdk/provider-utils';
import {
afterEach,
beforeEach,
describe,
expect,
it,
test,
vi,
vitest,
} from 'vitest';
import \* as logWarningsModule from '../logger/log-warnings';
import { MockImageModelV3 } from '../test/mock-image-model-v3';
import { generateImage } from './generate-image';

const prompt = 'sunny day at the beach';
const testDate = new Date(2024, 0, 1);

const pngBase64 =
'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=='; // 1x1 transparent PNG
const jpegBase64 =
'/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k='; // 1x1 black JPEG
const gifBase64 = 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs='; // 1x1 transparent GIF

vi.mock('../version', () => {
return {
VERSION: '0.0.0-test',
};
});

const createMockResponse = (options: {
images: string[] | Uint8Array[];
warnings?: ImageModelV3CallWarning[];
timestamp?: Date;
modelId?: string;
providerMetaData?: ImageModelV3ProviderMetadata;
headers?: Record<string, string>;
}) => ({
images: options.images,
warnings: options.warnings ?? [],
providerMetadata: options.providerMetaData ?? {
testProvider: {
images: options.images.map(() => null),
},
},
response: {
timestamp: options.timestamp ?? new Date(),
modelId: options.modelId ?? 'test-model-id',
headers: options.headers ?? {},
},
});

describe('generateImage', () => {
let logWarningsSpy: ReturnType<typeof vitest.spyOn>;

beforeEach(() => {
logWarningsSpy = vitest
.spyOn(logWarningsModule, 'logWarnings')
.mockImplementation(() => {});
});

afterEach(() => {
logWarningsSpy.mockRestore();
});

it('should send args to doGenerate', async () => {
const abortController = new AbortController();
const abortSignal = abortController.signal;

    let capturedArgs!: Parameters<ImageModelV3['doGenerate']>[0];

    await generateImage({
      model: new MockImageModelV3({
        doGenerate: async args => {
          capturedArgs = args;
          return createMockResponse({
            images: [pngBase64],
          });
        },
      }),
      prompt,
      size: '1024x1024',
      aspectRatio: '16:9',
      seed: 12345,
      providerOptions: {
        'mock-provider': {
          style: 'vivid',
        },
      },
      headers: {
        'custom-request-header': 'request-header-value',
      },
      abortSignal,
    });

    expect(capturedArgs).toStrictEqual({
      n: 1,
      prompt,
      size: '1024x1024',
      aspectRatio: '16:9',
      seed: 12345,
      providerOptions: { 'mock-provider': { style: 'vivid' } },
      headers: {
        'custom-request-header': 'request-header-value',
        'user-agent': 'ai/0.0.0-test',
      },
      abortSignal,
    });

});

it('should return warnings', async () => {
const result = await generateImage({
model: new MockImageModelV3({
doGenerate: async () =>
createMockResponse({
images: [pngBase64],
warnings: [
{
type: 'other',
message: 'Setting is not supported',
},
],
}),
}),
prompt,
});

    expect(result.warnings).toStrictEqual([
      {
        type: 'other',
        message: 'Setting is not supported',
      },
    ]);

});

it('should call logWarnings with the correct warnings', async () => {
const expectedWarnings: ImageModelV3CallWarning[] = [
{
type: 'other',
message: 'Setting is not supported',
},
{
type: 'unsupported-setting',
setting: 'size',
details: 'Size parameter not supported',
},
];

    await generateImage({
      model: new MockImageModelV3({
        doGenerate: async () =>
          createMockResponse({
            images: [pngBase64],
            warnings: expectedWarnings,
          }),
      }),
      prompt,
    });

    expect(logWarningsSpy).toHaveBeenCalledOnce();
    expect(logWarningsSpy).toHaveBeenCalledWith({
      warnings: expectedWarnings,
      provider: 'mock-provider',
      model: 'mock-model-id',
    });

});

it('should call logWarnings with aggregated warnings from multiple calls', async () => {
const warning1: ImageModelV3CallWarning = {
type: 'other',
message: 'Warning from call 1',
};
const warning2: ImageModelV3CallWarning = {
type: 'other',
message: 'Warning from call 2',
};
const expectedAggregatedWarnings = [warning1, warning2];

    let callCount = 0;

    await generateImage({
      model: new MockImageModelV3({
        maxImagesPerCall: 1,
        doGenerate: async () => {
          switch (callCount++) {
            case 0:
              return createMockResponse({
                images: [pngBase64],
                warnings: [warning1],
              });
            case 1:
              return createMockResponse({
                images: [jpegBase64],
                warnings: [warning2],
              });
            default:
              throw new Error('Unexpected call');
          }
        },
      }),
      prompt,
      n: 2,
    });

    expect(logWarningsSpy).toHaveBeenCalledOnce();
    expect(logWarningsSpy).toHaveBeenCalledWith({
      warnings: expectedAggregatedWarnings,
      provider: 'mock-provider',
      model: 'mock-model-id',
    });

});

it('should call logWarnings with empty array when no warnings are present', async () => {
await generateImage({
model: new MockImageModelV3({
doGenerate: async () =>
createMockResponse({
images: [pngBase64],
warnings: [], // no warnings
}),
}),
prompt,
});

    expect(logWarningsSpy).toHaveBeenCalledOnce();
    expect(logWarningsSpy).toHaveBeenCalledWith({
      warnings: [],
      provider: 'mock-provider',
      model: 'mock-model-id',
    });

});

describe('base64 image data', () => {
it('should return generated images with correct mime types', async () => {
const result = await generateImage({
model: new MockImageModelV3({
doGenerate: async () =>
createMockResponse({
images: [pngBase64, jpegBase64],
}),
}),
prompt,
});

      expect(
        result.images.map(image => ({
          base64: image.base64,
          uint8Array: image.uint8Array,
          mediaType: image.mediaType,
        })),
      ).toStrictEqual([
        {
          base64: pngBase64,
          uint8Array: convertBase64ToUint8Array(pngBase64),
          mediaType: 'image/png',
        },
        {
          base64: jpegBase64,
          uint8Array: convertBase64ToUint8Array(jpegBase64),
          mediaType: 'image/jpeg',
        },
      ]);
    });

    it('should return the first image with correct mime type', async () => {
      const result = await generateImage({
        model: new MockImageModelV3({
          doGenerate: async () =>
            createMockResponse({
              images: [pngBase64, jpegBase64],
            }),
        }),
        prompt,
      });

      expect({
        base64: result.image.base64,
        uint8Array: result.image.uint8Array,
        mediaType: result.image.mediaType,
      }).toStrictEqual({
        base64: pngBase64,
        uint8Array: convertBase64ToUint8Array(pngBase64),
        mediaType: 'image/png',
      });
    });

});

describe('uint8array image data', () => {
it('should return generated images', async () => {
const uint8ArrayImages = [
convertBase64ToUint8Array(pngBase64),
convertBase64ToUint8Array(jpegBase64),
];

      const result = await generateImage({
        model: new MockImageModelV3({
          doGenerate: async () =>
            createMockResponse({
              images: uint8ArrayImages,
            }),
        }),
        prompt,
      });

      expect(
        result.images.map(image => ({
          base64: image.base64,
          uint8Array: image.uint8Array,
        })),
      ).toStrictEqual([
        {
          base64: convertUint8ArrayToBase64(uint8ArrayImages[0]),
          uint8Array: uint8ArrayImages[0],
        },
        {
          base64: convertUint8ArrayToBase64(uint8ArrayImages[1]),
          uint8Array: uint8ArrayImages[1],
        },
      ]);
    });

});

describe('when several calls are required', () => {
it('should generate images', async () => {
const base64Images = [pngBase64, jpegBase64, gifBase64];

      let callCount = 0;

      const result = await generateImage({
        model: new MockImageModelV3({
          maxImagesPerCall: 2,
          doGenerate: async options => {
            switch (callCount++) {
              case 0:
                expect(options).toStrictEqual({
                  prompt,
                  n: 2,
                  seed: 12345,
                  size: '1024x1024',
                  aspectRatio: '16:9',
                  providerOptions: {
                    'mock-provider': { style: 'vivid' },
                  },
                  headers: {
                    'custom-request-header': 'request-header-value',
                    'user-agent': 'ai/0.0.0-test',
                  },
                  abortSignal: undefined,
                });
                return createMockResponse({
                  images: base64Images.slice(0, 2),
                });
              case 1:
                expect(options).toStrictEqual({
                  prompt,
                  n: 1,
                  seed: 12345,
                  size: '1024x1024',
                  aspectRatio: '16:9',
                  providerOptions: { 'mock-provider': { style: 'vivid' } },
                  headers: {
                    'custom-request-header': 'request-header-value',
                    'user-agent': 'ai/0.0.0-test',
                  },
                  abortSignal: undefined,
                });
                return createMockResponse({
                  images: base64Images.slice(2),
                });
              default:
                throw new Error('Unexpected call');
            }
          },
        }),
        prompt,
        n: 3,
        size: '1024x1024',
        aspectRatio: '16:9',
        seed: 12345,
        providerOptions: { 'mock-provider': { style: 'vivid' } },
        headers: {
          'custom-request-header': 'request-header-value',
        },
      });

      expect(result.images.map(image => image.base64)).toStrictEqual(
        base64Images,
      );
    });

    it('should aggregate warnings', async () => {
      const base64Images = [pngBase64, jpegBase64, gifBase64];

      let callCount = 0;

      const result = await generateImage({
        model: new MockImageModelV3({
          maxImagesPerCall: 2,
          doGenerate: async options => {
            switch (callCount++) {
              case 0:
                expect(options).toStrictEqual({
                  prompt,
                  n: 2,
                  seed: 12345,
                  size: '1024x1024',
                  aspectRatio: '16:9',
                  providerOptions: { 'mock-provider': { style: 'vivid' } },
                  headers: {
                    'custom-request-header': 'request-header-value',
                    'user-agent': 'ai/0.0.0-test',
                  },
                  abortSignal: undefined,
                });
                return createMockResponse({
                  images: base64Images.slice(0, 2),
                  warnings: [{ type: 'other', message: '1' }],
                });
              case 1:
                expect(options).toStrictEqual({
                  prompt,
                  n: 1,
                  seed: 12345,
                  size: '1024x1024',
                  aspectRatio: '16:9',
                  providerOptions: { 'mock-provider': { style: 'vivid' } },
                  headers: {
                    'custom-request-header': 'request-header-value',
                    'user-agent': 'ai/0.0.0-test',
                  },
                  abortSignal: undefined,
                });
                return createMockResponse({
                  images: base64Images.slice(2),
                  warnings: [{ type: 'other', message: '2' }],
                });
              default:
                throw new Error('Unexpected call');
            }
          },
        }),
        prompt,
        n: 3,
        size: '1024x1024',
        aspectRatio: '16:9',
        seed: 12345,
        providerOptions: { 'mock-provider': { style: 'vivid' } },
        headers: {
          'custom-request-header': 'request-header-value',
        },
      });

      expect(result.warnings).toStrictEqual([
        { type: 'other', message: '1' },
        { type: 'other', message: '2' },
      ]);
    });

    test.each([
      ['sync method', () => 2],
      ['async method', async () => 2],
    ])(
      'should generate with maxImagesPerCall = %s',
      async (_, maxImagesPerCall) => {
        const base64Images = [pngBase64, jpegBase64, gifBase64];

        let callCount = 0;
        const maxImagesPerCallMock = vitest.fn(maxImagesPerCall);

        const result = await generateImage({
          model: new MockImageModelV3({
            maxImagesPerCall: maxImagesPerCallMock,
            doGenerate: async options => {
              switch (callCount++) {
                case 0:
                  expect(options).toStrictEqual({
                    prompt,
                    n: 2,
                    seed: 12345,
                    size: '1024x1024',
                    aspectRatio: '16:9',
                    providerOptions: {
                      'mock-provider': { style: 'vivid' },
                    },
                    headers: {
                      'custom-request-header': 'request-header-value',
                      'user-agent': 'ai/0.0.0-test',
                    },
                    abortSignal: undefined,
                  });
                  return createMockResponse({
                    images: base64Images.slice(0, 2),
                  });
                case 1:
                  expect(options).toStrictEqual({
                    prompt,
                    n: 1,
                    seed: 12345,
                    size: '1024x1024',
                    aspectRatio: '16:9',
                    providerOptions: { 'mock-provider': { style: 'vivid' } },
                    headers: {
                      'custom-request-header': 'request-header-value',
                      'user-agent': 'ai/0.0.0-test',
                    },
                    abortSignal: undefined,
                  });
                  return createMockResponse({
                    images: base64Images.slice(2),
                  });
                default:
                  throw new Error('Unexpected call');
              }
            },
          }),
          prompt,
          n: 3,
          size: '1024x1024',
          aspectRatio: '16:9',
          seed: 12345,
          providerOptions: { 'mock-provider': { style: 'vivid' } },
          headers: {
            'custom-request-header': 'request-header-value',
          },
        });

        expect(result.images.map(image => image.base64)).toStrictEqual(
          base64Images,
        );
        expect(maxImagesPerCallMock).toHaveBeenCalledTimes(1);
        expect(maxImagesPerCallMock).toHaveBeenCalledWith({
          modelId: 'mock-model-id',
        });
      },
    );

});

describe('error handling', () => {
it('should throw NoImageGeneratedError when no images are returned', async () => {
await expect(
generateImage({
model: new MockImageModelV3({
doGenerate: async () =>
createMockResponse({
images: [],
timestamp: testDate,
}),
}),
prompt,
}),
).rejects.toMatchObject({
name: 'AI_NoImageGeneratedError',
message: 'No image generated.',
responses: [
{
timestamp: testDate,
modelId: expect.any(String),
},
],
});
});

    it('should include response headers in error when no images generated', async () => {
      await expect(
        generateImage({
          model: new MockImageModelV3({
            doGenerate: async () =>
              createMockResponse({
                images: [],
                timestamp: testDate,
                headers: {
                  'custom-response-header': 'response-header-value',
                  'user-agent': 'ai/0.0.0-test',
                },
              }),
          }),
          prompt,
        }),
      ).rejects.toMatchObject({
        name: 'AI_NoImageGeneratedError',
        message: 'No image generated.',
        responses: [
          {
            timestamp: testDate,
            modelId: expect.any(String),
            headers: {
              'custom-response-header': 'response-header-value',
              'user-agent': 'ai/0.0.0-test',
            },
          },
        ],
      });
    });

});

it('should return response metadata', async () => {
const testHeaders = { 'x-test': 'value' };

    const result = await generateImage({
      model: new MockImageModelV3({
        doGenerate: async () =>
          createMockResponse({
            images: [pngBase64],
            timestamp: testDate,
            modelId: 'test-model',
            headers: testHeaders,
          }),
      }),
      prompt,
    });

    expect(result.responses).toStrictEqual([
      {
        timestamp: testDate,
        modelId: 'test-model',
        headers: testHeaders,
      },
    ]);

});

it('should return provider metadata', async () => {
const result = await generateImage({
model: new MockImageModelV3({
doGenerate: async () =>
createMockResponse({
images: [pngBase64, pngBase64],
timestamp: testDate,
modelId: 'test-model',
providerMetaData: {
testProvider: {
images: [{ revisedPrompt: 'test-revised-prompt' }, null],
},
},
headers: {},
}),
}),
prompt,
});

    expect(result.providerMetadata).toStrictEqual({
      testProvider: {
        images: [{ revisedPrompt: 'test-revised-prompt' }, null],
      },
    });

});
});

================================================
FILE: packages/ai/src/generate-image/generate-image.ts
================================================
import { ImageModelV3, ImageModelV3ProviderMetadata } from '@ai-sdk/provider';
import { ProviderOptions, withUserAgentSuffix } from '@ai-sdk/provider-utils';
import { NoImageGeneratedError } from '../error/no-image-generated-error';
import {
detectMediaType,
imageMediaTypeSignatures,
} from '../util/detect-media-type';
import { prepareRetries } from '../util/prepare-retries';
import { UnsupportedModelVersionError } from '../error/unsupported-model-version-error';
import {
DefaultGeneratedFile,
GeneratedFile,
} from '../generate-text/generated-file';
import { ImageGenerationWarning } from '../types/image-model';
import { ImageModelResponseMetadata } from '../types/image-model-response-metadata';
import { GenerateImageResult } from './generate-image-result';
import { logWarnings } from '../logger/log-warnings';
import { VERSION } from '../version';

/\*\*
Generates images using an image model.

@param model - The image model to use.
@param prompt - The prompt that should be used to generate the image.
@param n - Number of images to generate. Default: 1.
@param size - Size of the images to generate. Must have the format `{width}x{height}`.
@param aspectRatio - Aspect ratio of the images to generate. Must have the format `{width}:{height}`.
@param seed - Seed for the image generation.
@param providerOptions - Additional provider-specific options that are passed through to the provider
as body parameters.
@param maxRetries - Maximum number of retries. Set to 0 to disable retries. Default: 2.
@param abortSignal - An optional abort signal that can be used to cancel the call.
@param headers - Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.

@returns A result object that contains the generated images.
_/
export async function generateImage({
model,
prompt,
n = 1,
maxImagesPerCall,
size,
aspectRatio,
seed,
providerOptions,
maxRetries: maxRetriesArg,
abortSignal,
headers,
}: {
/\*\*
The image model to use.
_/
model: ImageModelV3;

/\*_
The prompt that should be used to generate the image.
_/
prompt: string;

/\*_
Number of images to generate.
_/
n?: number;

/\*_
Number of images to generate.
_/
maxImagesPerCall?: number;

/\*_
Size of the images to generate. Must have the format `{width}x{height}`. If not provided, the default size will be used.
_/
size?: `${number}x${number}`;

/\*_
Aspect ratio of the images to generate. Must have the format `{width}:{height}`. If not provided, the default aspect ratio will be used.
_/
aspectRatio?: `${number}:${number}`;

/\*_
Seed for the image generation. If not provided, the default seed will be used.
_/
seed?: number;

/\*\*
Additional provider-specific options that are passed through to the provider
as body parameters.

The outer record is keyed by the provider name, and the inner
record is keyed by the provider-specific metadata key.

```ts
{
  "openai": {
    "style": "vivid"
  }
}
```

     */

providerOptions?: ProviderOptions;

/\*\*
Maximum number of retries per embedding model call. Set to 0 to disable retries.

@default 2
\*/
maxRetries?: number;

/\*_
Abort signal.
_/
abortSignal?: AbortSignal;

/\*_
Additional headers to include in the request.
Only applicable for HTTP-based providers.
_/
headers?: Record<string, string>;
}): Promise<GenerateImageResult> {
if (model.specificationVersion !== 'v3') {
throw new UnsupportedModelVersionError({
version: model.specificationVersion,
provider: model.provider,
modelId: model.modelId,
});
}

const headersWithUserAgent = withUserAgentSuffix(
headers ?? {},
`ai/${VERSION}`,
);

const { retry } = prepareRetries({
maxRetries: maxRetriesArg,
abortSignal,
});

// default to 1 if the model has not specified limits on
// how many images can be generated in a single call
const maxImagesPerCallWithDefault =
maxImagesPerCall ?? (await invokeModelMaxImagesPerCall(model)) ?? 1;

// parallelize calls to the model:
const callCount = Math.ceil(n / maxImagesPerCallWithDefault);
const callImageCounts = Array.from({ length: callCount }, (\_, i) => {
if (i < callCount - 1) {
return maxImagesPerCallWithDefault;
}

    const remainder = n % maxImagesPerCallWithDefault;
    return remainder === 0 ? maxImagesPerCallWithDefault : remainder;

});

const results = await Promise.all(
callImageCounts.map(async callImageCount =>
retry(() =>
model.doGenerate({
prompt,
n: callImageCount,
abortSignal,
headers: headersWithUserAgent,
size,
aspectRatio,
seed,
providerOptions: providerOptions ?? {},
}),
),
),
);

// collect result images, warnings, and response metadata
const images: Array<DefaultGeneratedFile> = [];
const warnings: Array<ImageGenerationWarning> = [];
const responses: Array<ImageModelResponseMetadata> = [];
const providerMetadata: ImageModelV3ProviderMetadata = {};
for (const result of results) {
images.push(
...result.images.map(
image =>
new DefaultGeneratedFile({
data: image,
mediaType:
detectMediaType({
data: image,
signatures: imageMediaTypeSignatures,
}) ?? 'image/png',
}),
),
);
warnings.push(...result.warnings);

    if (result.providerMetadata) {
      for (const [providerName, metadata] of Object.entries<{
        images: unknown;
      }>(result.providerMetadata)) {
        providerMetadata[providerName] ??= { images: [] };
        providerMetadata[providerName].images.push(
          ...result.providerMetadata[providerName].images,
        );
      }
    }

    responses.push(result.response);

}

logWarnings({ warnings, provider: model.provider, model: model.modelId });

if (!images.length) {
throw new NoImageGeneratedError({ responses });
}

return new DefaultGenerateImageResult({
images,
warnings,
responses,
providerMetadata,
});
}

class DefaultGenerateImageResult implements GenerateImageResult {
readonly images: Array<GeneratedFile>;
readonly warnings: Array<ImageGenerationWarning>;
readonly responses: Array<ImageModelResponseMetadata>;
readonly providerMetadata: ImageModelV3ProviderMetadata;

constructor(options: {
images: Array<GeneratedFile>;
warnings: Array<ImageGenerationWarning>;
responses: Array<ImageModelResponseMetadata>;
providerMetadata: ImageModelV3ProviderMetadata;
}) {
this.images = options.images;
this.warnings = options.warnings;
this.responses = options.responses;
this.providerMetadata = options.providerMetadata;
}

get image() {
return this.images[0];
}
}

async function invokeModelMaxImagesPerCall(model: ImageModelV3) {
const isFunction = model.maxImagesPerCall instanceof Function;

if (!isFunction) {
return model.maxImagesPerCall;
}

return model.maxImagesPerCall({
modelId: model.modelId,
});
}

================================================
FILE: packages/ai/src/generate-image/index.ts
================================================
export { generateImage as experimental_generateImage } from './generate-image';
export type { GenerateImageResult as Experimental_GenerateImageResult } from './generate-image-result';

================================================
FILE: packages/ai/src/generate-object/generate-object-result.ts
================================================
import {
CallWarning,
FinishReason,
LanguageModelRequestMetadata,
LanguageModelResponseMetadata,
ProviderMetadata,
} from '../types';
import { LanguageModelUsage } from '../types/usage';

/**
The result of a `generateObject` call.
\*/
export interface GenerateObjectResult<OBJECT> {
/**
The generated object (typed according to the schema).
\*/
readonly object: OBJECT;

/\*\*

- The reasoning that was used to generate the object.
- Concatenated from all reasoning parts.
  \*/
  readonly reasoning: string | undefined;

/\*_
The reason why the generation finished.
_/
readonly finishReason: FinishReason;

/\*_
The token usage of the generated text.
_/
readonly usage: LanguageModelUsage;

/\*_
Warnings from the model provider (e.g. unsupported settings).
_/
readonly warnings: CallWarning[] | undefined;

/\*_
Additional request information.
_/
readonly request: LanguageModelRequestMetadata;

/**
Additional response information.
\*/
readonly response: LanguageModelResponseMetadata & {
/**
Response body (available only for providers that use HTTP requests).
\*/
body?: unknown;
};

/\*_
Additional provider-specific metadata. They are passed through
from the provider to the AI SDK and enable provider-specific
results that can be fully encapsulated in the provider.
_/
readonly providerMetadata: ProviderMetadata | undefined;

/\*_
Converts the object to a JSON response.
The response will have a status code of 200 and a content type of `application/json; charset=utf-8`.
_/
toJsonResponse(init?: ResponseInit): Response;
}

================================================
FILE: packages/ai/src/generate-object/generate-object.test-d.ts
================================================
import { expectTypeOf } from 'vitest';
import { generateObject } from './generate-object';
import { z } from 'zod/v4';
import { JSONValue } from '@ai-sdk/provider';
import { describe, it } from 'vitest';

describe('generateObject', () => {
it('should support enum types', async () => {
const result = await generateObject({
output: 'enum',
enum: ['a', 'b', 'c'] as const,
model: undefined!,
messages: [],
});

    expectTypeOf<typeof result.object>().toEqualTypeOf<'a' | 'b' | 'c'>;

});

it('should support schema types', async () => {
const result = await generateObject({
schema: z.object({ number: z.number() }),
model: undefined!,
messages: [],
});

    expectTypeOf<typeof result.object>().toEqualTypeOf<{ number: number }>();

});

it('should support no-schema output mode', async () => {
const result = await generateObject({
output: 'no-schema',
model: undefined!,
messages: [],
});

    expectTypeOf<typeof result.object>().toEqualTypeOf<JSONValue>();

});

it('should support array output mode', async () => {
const result = await generateObject({
output: 'array',
schema: z.number(),
model: undefined!,
messages: [],
});

    expectTypeOf<typeof result.object>().toEqualTypeOf<number[]>();

});
});

================================================
FILE: packages/ai/src/generate-object/generate-object.test.ts
================================================
import {
JSONParseError,
LanguageModelV3CallWarning,
TypeValidationError,
} from '@ai-sdk/provider';
import { jsonSchema } from '@ai-sdk/provider-utils';
import { convertReadableStreamToArray } from '@ai-sdk/provider-utils/test';
import assert, { fail } from 'node:assert';
import {
afterEach,
beforeEach,
describe,
expect,
it,
vitest,
vi,
} from 'vitest';
import { z } from 'zod/v4';
import { verifyNoObjectGeneratedError as originalVerifyNoObjectGeneratedError } from '../error/verify-no-object-generated-error';
import \* as logWarningsModule from '../logger/log-warnings';
import { MockLanguageModelV3 } from '../test/mock-language-model-v3';
import { MockTracer } from '../test/mock-tracer';
import { generateObject } from './generate-object';

vi.mock('../version', () => {
return {
VERSION: '0.0.0-test',
};
});

const dummyResponseValues = {
finishReason: 'stop' as const,
usage: {
inputTokens: 10,
outputTokens: 20,
totalTokens: 30,
reasoningTokens: undefined,
cachedInputTokens: undefined,
},
response: { id: 'id-1', timestamp: new Date(123), modelId: 'm-1' },
warnings: [],
};

describe('generateObject', () => {
let logWarningsSpy: ReturnType<typeof vitest.spyOn>;

beforeEach(() => {
logWarningsSpy = vitest
.spyOn(logWarningsModule, 'logWarnings')
.mockImplementation(() => {});
});

afterEach(() => {
logWarningsSpy.mockRestore();
});

describe('output = "object"', () => {
describe('result.object', () => {
it('should generate object', async () => {
const model = new MockLanguageModelV3({
doGenerate: {
...dummyResponseValues,
content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
},
});
const result = await generateObject({
model,
schema: z.object({ content: z.string() }),
prompt: 'prompt',
});

        expect(result.object).toMatchInlineSnapshot(`
        {
          "content": "Hello, world!",
        }
      `);
        expect(model.doGenerateCalls[0].prompt).toMatchInlineSnapshot(`
        [
          {
            "content": [
              {
                "text": "prompt",
                "type": "text",
              },
            ],
            "providerOptions": undefined,
            "role": "user",
          },
        ]
      `);
        expect(model.doGenerateCalls[0].responseFormat).toMatchInlineSnapshot(`
        {
          "description": undefined,
          "name": undefined,
          "schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "additionalProperties": false,
            "properties": {
              "content": {
                "type": "string",
              },
            },
            "required": [
              "content",
            ],
            "type": "object",
          },
          "type": "json",
        }
      `);
      });

      it('should use name and description', async () => {
        const result = await generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async ({ prompt, responseFormat }) => {
              expect(responseFormat).toStrictEqual({
                type: 'json',
                name: 'test-name',
                description: 'test description',
                schema: {
                  $schema: 'http://json-schema.org/draft-07/schema#',
                  additionalProperties: false,
                  properties: { content: { type: 'string' } },
                  required: ['content'],
                  type: 'object',
                },
              });

              expect(prompt).toStrictEqual([
                {
                  role: 'user',
                  content: [{ type: 'text', text: 'prompt' }],
                  providerOptions: undefined,
                },
              ]);

              return {
                ...dummyResponseValues,
                content: [
                  { type: 'text', text: '{ "content": "Hello, world!" }' },
                ],
              };
            },
          }),
          schema: z.object({ content: z.string() }),
          schemaName: 'test-name',
          schemaDescription: 'test description',
          prompt: 'prompt',
        });

        assert.deepStrictEqual(result.object, { content: 'Hello, world!' });
      });
    });

    it('should return warnings', async () => {
      const result = await generateObject({
        model: new MockLanguageModelV3({
          doGenerate: async () => ({
            ...dummyResponseValues,
            content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
            warnings: [
              {
                type: 'other',
                message: 'Setting is not supported',
              },
            ],
          }),
        }),
        schema: z.object({ content: z.string() }),
        prompt: 'prompt',
      });

      expect(result.warnings).toStrictEqual([
        {
          type: 'other',
          message: 'Setting is not supported',
        },
      ]);
    });

    it('should call logWarnings with the correct warnings', async () => {
      const expectedWarnings: LanguageModelV3CallWarning[] = [
        {
          type: 'other',
          message: 'Setting is not supported',
        },
        {
          type: 'unsupported-setting',
          setting: 'temperature',
          details: 'Temperature parameter not supported',
        },
      ];

      await generateObject({
        model: new MockLanguageModelV3({
          doGenerate: async () => ({
            ...dummyResponseValues,
            content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
            warnings: expectedWarnings,
          }),
        }),
        schema: z.object({ content: z.string() }),
        prompt: 'prompt',
      });

      expect(logWarningsSpy).toHaveBeenCalledOnce();
      expect(logWarningsSpy).toHaveBeenCalledWith({
        warnings: expectedWarnings,
        provider: 'mock-provider',
        model: 'mock-model-id',
      });
    });

    it('should call logWarnings with empty array when no warnings are present', async () => {
      await generateObject({
        model: new MockLanguageModelV3({
          doGenerate: async () => ({
            ...dummyResponseValues,
            content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
            warnings: [], // no warnings
          }),
        }),
        schema: z.object({ content: z.string() }),
        prompt: 'prompt',
      });

      expect(logWarningsSpy).toHaveBeenCalledOnce();
      expect(logWarningsSpy).toHaveBeenCalledWith({
        warnings: [],
        provider: 'mock-provider',
        model: 'mock-model-id',
      });
    });

    describe('result.request', () => {
      it('should contain request information', async () => {
        const result = await generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async () => ({
              ...dummyResponseValues,
              content: [
                { type: 'text', text: '{ "content": "Hello, world!" }' },
              ],
              request: {
                body: 'test body',
              },
            }),
          }),
          schema: z.object({ content: z.string() }),
          prompt: 'prompt',
        });

        expect(result.request).toStrictEqual({
          body: 'test body',
        });
      });
    });

    describe('result.response', () => {
      it('should contain response information', async () => {
        const result = await generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async () => ({
              ...dummyResponseValues,
              content: [
                { type: 'text', text: '{ "content": "Hello, world!" }' },
              ],
              response: {
                id: 'test-id-from-model',
                timestamp: new Date(10000),
                modelId: 'test-response-model-id',
                headers: {
                  'custom-response-header': 'response-header-value',
                  'user-agent': 'ai/0.0.0-test',
                },
                body: 'test body',
              },
            }),
          }),
          schema: z.object({ content: z.string() }),
          prompt: 'prompt',
        });

        expect(result.response).toStrictEqual({
          id: 'test-id-from-model',
          timestamp: new Date(10000),
          modelId: 'test-response-model-id',
          headers: {
            'custom-response-header': 'response-header-value',
            'user-agent': 'ai/0.0.0-test',
          },
          body: 'test body',
        });
      });
    });

    describe('zod schema', () => {
      it('should generate object when using zod transform', async () => {
        const model = new MockLanguageModelV3({
          doGenerate: {
            ...dummyResponseValues,
            content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
          },
        });

        const result = await generateObject({
          model,
          schema: z.object({
            content: z
              .string()
              .transform(value => value.length)
              .pipe(z.number()),
          }),
          prompt: 'prompt',
        });

        expect(result.object).toMatchInlineSnapshot(`
        {
          "content": 13,
        }
      `);
        expect(model.doGenerateCalls[0].prompt).toMatchInlineSnapshot(`
        [
          {
            "content": [
              {
                "text": "prompt",
                "type": "text",
              },
            ],
            "providerOptions": undefined,
            "role": "user",
          },
        ]
      `);
        expect(model.doGenerateCalls[0].responseFormat).toMatchInlineSnapshot(`
        {
          "description": undefined,
          "name": undefined,
          "schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "additionalProperties": false,
            "properties": {
              "content": {
                "type": "number",
              },
            },
            "required": [
              "content",
            ],
            "type": "object",
          },
          "type": "json",
        }
      `);
      });

      it('should generate object when using zod prePreprocess', async () => {
        const model = new MockLanguageModelV3({
          doGenerate: {
            ...dummyResponseValues,
            content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
          },
        });

        const result = await generateObject({
          model,
          schema: z.object({
            content: z.preprocess(
              val => (typeof val === 'number' ? String(val) : val),
              z.string(),
            ),
          }),
          prompt: 'prompt',
        });

        expect(result.object).toMatchInlineSnapshot(`
        {
          "content": "Hello, world!",
        }
      `);
        expect(model.doGenerateCalls[0].prompt).toMatchInlineSnapshot(`
        [
          {
            "content": [
              {
                "text": "prompt",
                "type": "text",
              },
            ],
            "providerOptions": undefined,
            "role": "user",
          },
        ]
      `);
        expect(model.doGenerateCalls[0].responseFormat).toMatchInlineSnapshot(`
        {
          "description": undefined,
          "name": undefined,
          "schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "additionalProperties": false,
            "properties": {
              "content": {
                "type": "string",
              },
            },
            "required": [
              "content",
            ],
            "type": "object",
          },
          "type": "json",
        }
      `);
      });
    });

    describe('custom schema', () => {
      it('should generate object', async () => {
        const model = new MockLanguageModelV3({
          doGenerate: {
            ...dummyResponseValues,
            content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
          },
        });

        const result = await generateObject({
          model,
          schema: jsonSchema({
            type: 'object',
            properties: { content: { type: 'string' } },
            required: ['content'],
            additionalProperties: false,
          }),
          prompt: 'prompt',
        });

        expect(result.object).toMatchInlineSnapshot(`
        {
          "content": "Hello, world!",
        }
      `);
        expect(model.doGenerateCalls[0].prompt).toMatchInlineSnapshot(`
        [
          {
            "content": [
              {
                "text": "prompt",
                "type": "text",
              },
            ],
            "providerOptions": undefined,
            "role": "user",
          },
        ]
      `);
        expect(model.doGenerateCalls[0].responseFormat).toMatchInlineSnapshot(`
        {
          "description": undefined,
          "name": undefined,
          "schema": {
            "additionalProperties": false,
            "properties": {
              "content": {
                "type": "string",
              },
            },
            "required": [
              "content",
            ],
            "type": "object",
          },
          "type": "json",
        }
      `);
      });
    });

    describe('result.toJsonResponse', () => {
      it('should return JSON response', async () => {
        const result = await generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async ({}) => ({
              ...dummyResponseValues,
              content: [
                { type: 'text', text: '{ "content": "Hello, world!" }' },
              ],
            }),
          }),
          schema: z.object({ content: z.string() }),
          prompt: 'prompt',
        });

        const response = result.toJsonResponse();

        assert.strictEqual(response.status, 200);
        assert.strictEqual(
          response.headers.get('Content-Type'),
          'application/json; charset=utf-8',
        );

        assert.deepStrictEqual(
          await convertReadableStreamToArray(
            response.body!.pipeThrough(new TextDecoderStream()),
          ),
          ['{"content":"Hello, world!"}'],
        );
      });
    });

    describe('result.providerMetadata', () => {
      it('should contain provider metadata', async () => {
        const result = await generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async ({}) => ({
              ...dummyResponseValues,
              content: [
                { type: 'text', text: '{ "content": "Hello, world!" }' },
              ],
              providerMetadata: {
                exampleProvider: {
                  a: 10,
                  b: 20,
                },
              },
            }),
          }),
          schema: z.object({ content: z.string() }),
          prompt: 'prompt',
        });

        expect(result.providerMetadata).toStrictEqual({
          exampleProvider: {
            a: 10,
            b: 20,
          },
        });
      });
    });

    describe('options.headers', () => {
      it('should pass headers to model', async () => {
        const result = await generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async ({ headers }) => {
              expect(headers).toStrictEqual({
                'custom-request-header': 'request-header-value',
                'user-agent': 'ai/0.0.0-test',
              });

              return {
                ...dummyResponseValues,
                content: [
                  { type: 'text', text: '{ "content": "headers test" }' },
                ],
              };
            },
          }),
          schema: z.object({ content: z.string() }),
          prompt: 'prompt',
          headers: { 'custom-request-header': 'request-header-value' },
        });

        expect(result.object).toStrictEqual({ content: 'headers test' });
      });
    });

    describe('options.repairText', () => {
      it('should be able to repair a JSONParseError', async () => {
        const result = await generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async ({}) => {
              return {
                ...dummyResponseValues,
                content: [
                  {
                    type: 'text',
                    text: '{ "content": "provider metadata test" ',
                  },
                ],
              };
            },
          }),
          schema: z.object({ content: z.string() }),
          prompt: 'prompt',
          experimental_repairText: async ({ text, error }) => {
            expect(error).toBeInstanceOf(JSONParseError);
            expect(text).toStrictEqual(
              '{ "content": "provider metadata test" ',
            );
            return text + '}';
          },
        });

        expect(result.object).toStrictEqual({
          content: 'provider metadata test',
        });
      });

      it('should be able to repair a TypeValidationError', async () => {
        const result = await generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async ({}) => {
              return {
                ...dummyResponseValues,
                content: [
                  {
                    type: 'text',
                    text: '{ "content-a": "provider metadata test" }',
                  },
                ],
              };
            },
          }),
          schema: z.object({ content: z.string() }),
          prompt: 'prompt',
          experimental_repairText: async ({ text, error }) => {
            expect(error).toBeInstanceOf(TypeValidationError);
            expect(text).toStrictEqual(
              '{ "content-a": "provider metadata test" }',
            );
            return `{ "content": "provider metadata test" }`;
          },
        });

        expect(result.object).toStrictEqual({
          content: 'provider metadata test',
        });
      });

      it('should be able to handle repair that returns null', async () => {
        const result = generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async ({}) => {
              return {
                ...dummyResponseValues,
                content: [
                  {
                    type: 'text',
                    text: '{ "content-a": "provider metadata test" }',
                  },
                ],
              };
            },
          }),
          schema: z.object({ content: z.string() }),
          prompt: 'prompt',
          experimental_repairText: async ({ text, error }) => {
            expect(error).toBeInstanceOf(TypeValidationError);
            expect(text).toStrictEqual(
              '{ "content-a": "provider metadata test" }',
            );
            return null;
          },
        });

        expect(result).rejects.toThrow(
          'No object generated: response did not match schema.',
        );
      });
    });

    describe('options.providerOptions', () => {
      it('should pass provider options to model', async () => {
        const result = await generateObject({
          model: new MockLanguageModelV3({
            doGenerate: async ({ providerOptions }) => {
              expect(providerOptions).toStrictEqual({
                aProvider: { someKey: 'someValue' },
              });

              return {
                ...dummyResponseValues,
                content: [
                  {
                    type: 'text',
                    text: '{ "content": "provider metadata test" }',
                  },
                ],
              };
            },
          }),
          schema: z.object({ content: z.string() }),
          prompt: 'prompt',
          providerOptions: {
            aProvider: { someKey: 'someValue' },
          },
        });

        expect(result.object).toStrictEqual({
          content: 'provider metadata test',
        });
      });
    });

    describe('error handling', () => {
      function verifyNoObjectGeneratedError(
        error: unknown,
        { message }: { message: string },
      ) {
        originalVerifyNoObjectGeneratedError(error, {
          message,
          response: {
            id: 'id-1',
            timestamp: new Date(123),
            modelId: 'm-1',
          },
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            reasoningTokens: undefined,
            cachedInputTokens: undefined,
          },
          finishReason: 'stop',
        });
      }

      it('should throw NoObjectGeneratedError when schema validation fails', async () => {
        try {
          await generateObject({
            model: new MockLanguageModelV3({
              doGenerate: async ({}) => ({
                ...dummyResponseValues,
                content: [{ type: 'text', text: '{ "content": 123 }' }],
              }),
            }),
            schema: z.object({ content: z.string() }),
            prompt: 'prompt',
          });

          fail('must throw error');
        } catch (error) {
          verifyNoObjectGeneratedError(error, {
            message: 'No object generated: response did not match schema.',
          });
        }
      });

      it('should throw NoObjectGeneratedError when parsing fails', async () => {
        try {
          await generateObject({
            model: new MockLanguageModelV3({
              doGenerate: async ({}) => ({
                ...dummyResponseValues,
                content: [{ type: 'text', text: '{ broken json' }],
              }),
            }),
            schema: z.object({ content: z.string() }),
            prompt: 'prompt',
          });

          fail('must throw error');
        } catch (error) {
          verifyNoObjectGeneratedError(error, {
            message: 'No object generated: could not parse the response.',
          });
        }
      });

      it('should throw NoObjectGeneratedError when parsing fails with repairResponse', async () => {
        try {
          await generateObject({
            model: new MockLanguageModelV3({
              doGenerate: async ({}) => ({
                ...dummyResponseValues,
                content: [{ type: 'text', text: '{ broken json' }],
              }),
            }),
            schema: z.object({ content: z.string() }),
            prompt: 'prompt',
            experimental_repairText: async ({ text }) => text + '{',
          });

          fail('must throw error');
        } catch (error) {
          verifyNoObjectGeneratedError(error, {
            message: 'No object generated: could not parse the response.',
          });
        }
      });

      it('should throw NoObjectGeneratedError when no text is available', async () => {
        try {
          await generateObject({
            model: new MockLanguageModelV3({
              doGenerate: async ({}) => ({
                ...dummyResponseValues,
                content: [],
              }),
            }),
            schema: z.object({ content: z.string() }),
            prompt: 'prompt',
          });

          fail('must throw error');
        } catch (error) {
          verifyNoObjectGeneratedError(error, {
            message:
              'No object generated: the model did not return a response.',
          });
        }
      });
    });

});

describe('output = "array"', () => {
it('should generate an array with 3 elements', async () => {
const model = new MockLanguageModelV3({
doGenerate: {
...dummyResponseValues,
content: [
{
type: 'text',
text: JSON.stringify({
elements: [
{ content: 'element 1' },
{ content: 'element 2' },
{ content: 'element 3' },
],
}),
},
],
},
});

      const result = await generateObject({
        model,
        schema: z.object({ content: z.string() }),
        output: 'array',
        prompt: 'prompt',
      });

      expect(result.object).toMatchInlineSnapshot(`
      [
        {
          "content": "element 1",
        },
        {
          "content": "element 2",
        },
        {
          "content": "element 3",
        },
      ]
    `);
      expect(model.doGenerateCalls[0].prompt).toMatchInlineSnapshot(`
      [
        {
          "content": [
            {
              "text": "prompt",
              "type": "text",
            },
          ],
          "providerOptions": undefined,
          "role": "user",
        },
      ]
    `);
      expect(model.doGenerateCalls[0].responseFormat).toMatchInlineSnapshot(`
      {
        "description": undefined,
        "name": undefined,
        "schema": {
          "$schema": "http://json-schema.org/draft-07/schema#",
          "additionalProperties": false,
          "properties": {
            "elements": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "content": {
                    "type": "string",
                  },
                },
                "required": [
                  "content",
                ],
                "type": "object",
              },
              "type": "array",
            },
          },
          "required": [
            "elements",
          ],
          "type": "object",
        },
        "type": "json",
      }
    `);
    });

});

describe('output = "enum"', () => {
it('should generate an enum value', async () => {
const model = new MockLanguageModelV3({
doGenerate: {
...dummyResponseValues,
content: [
{
type: 'text',
text: JSON.stringify({ result: 'sunny' }),
},
],
},
});

      const result = await generateObject({
        model,
        output: 'enum',
        enum: ['sunny', 'rainy', 'snowy'],
        prompt: 'prompt',
      });

      expect(result.object).toEqual('sunny');
      expect(model.doGenerateCalls[0].prompt).toMatchInlineSnapshot(`
      [
        {
          "content": [
            {
              "text": "prompt",
              "type": "text",
            },
          ],
          "providerOptions": undefined,
          "role": "user",
        },
      ]
    `);
      expect(model.doGenerateCalls[0].responseFormat).toMatchInlineSnapshot(`
      {
        "description": undefined,
        "name": undefined,
        "schema": {
          "$schema": "http://json-schema.org/draft-07/schema#",
          "additionalProperties": false,
          "properties": {
            "result": {
              "enum": [
                "sunny",
                "rainy",
                "snowy",
              ],
              "type": "string",
            },
          },
          "required": [
            "result",
          ],
          "type": "object",
        },
        "type": "json",
      }
    `);
    });

});

describe('output = "no-schema"', () => {
it('should generate object', async () => {
const model = new MockLanguageModelV3({
doGenerate: {
...dummyResponseValues,
content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
},
});

      const result = await generateObject({
        model,
        output: 'no-schema',
        prompt: 'prompt',
      });

      expect(result.object).toMatchInlineSnapshot(`
      {
        "content": "Hello, world!",
      }
    `);
      expect(model.doGenerateCalls[0].prompt).toMatchInlineSnapshot(`
      [
        {
          "content": [
            {
              "text": "prompt",
              "type": "text",
            },
          ],
          "providerOptions": undefined,
          "role": "user",
        },
      ]
    `);
      expect(model.doGenerateCalls[0].responseFormat).toMatchInlineSnapshot(`
      {
        "description": undefined,
        "name": undefined,
        "schema": undefined,
        "type": "json",
      }
    `);
    });

});

describe('telemetry', () => {
let tracer: MockTracer;

    beforeEach(() => {
      tracer = new MockTracer();
    });

    it('should not record any telemetry data when not explicitly enabled', async () => {
      await generateObject({
        model: new MockLanguageModelV3({
          doGenerate: async () => ({
            ...dummyResponseValues,
            content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
          }),
        }),
        schema: z.object({ content: z.string() }),
        prompt: 'prompt',
      });

      assert.deepStrictEqual(tracer.jsonSpans, []);
    });

    it('should record telemetry data when enabled', async () => {
      await generateObject({
        model: new MockLanguageModelV3({
          doGenerate: async () => ({
            ...dummyResponseValues,
            content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
            response: {
              id: 'test-id-from-model',
              timestamp: new Date(10000),
              modelId: 'test-response-model-id',
            },
            providerMetadata: {
              testProvider: {
                testKey: 'testValue',
              },
            },
          }),
        }),
        schema: z.object({ content: z.string() }),
        schemaName: 'test-name',
        schemaDescription: 'test description',
        prompt: 'prompt',
        topK: 0.1,
        topP: 0.2,
        frequencyPenalty: 0.3,
        presencePenalty: 0.4,
        temperature: 0.5,
        headers: {
          header1: 'value1',
          header2: 'value2',
        },
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'test-function-id',
          metadata: {
            test1: 'value1',
            test2: false,
          },
          tracer,
        },
      });

      expect(tracer.jsonSpans).toMatchSnapshot();
    });

    it('should not record telemetry inputs / outputs when disabled', async () => {
      await generateObject({
        model: new MockLanguageModelV3({
          doGenerate: async () => ({
            ...dummyResponseValues,
            content: [{ type: 'text', text: '{ "content": "Hello, world!" }' }],
            response: {
              id: 'test-id-from-model',
              timestamp: new Date(10000),
              modelId: 'test-response-model-id',
            },
          }),
        }),
        schema: z.object({ content: z.string() }),
        prompt: 'prompt',
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: false,
          recordOutputs: false,
          tracer,
        },
      });

      expect(tracer.jsonSpans).toMatchSnapshot();
    });

});

describe('options.messages', () => {
it('should support models that use "this" context in supportedUrls', async () => {
let supportedUrlsCalled = false;
class MockLanguageModelWithImageSupport extends MockLanguageModelV3 {
constructor() {
super({
supportedUrls: () => {
supportedUrlsCalled = true;
// Reference 'this' to verify context
return this.modelId === 'mock-model-id'
? ({ 'image/_': [/^https:\/\/._$/] } as Record<
string,
RegExp[] >)
: {};
},
doGenerate: async () => ({
...dummyResponseValues,
content: [
{ type: 'text', text: '{ "content": "Hello, world!" }' },
],
}),
});
}
}

      const model = new MockLanguageModelWithImageSupport();

      const result = await generateObject({
        model,
        schema: z.object({ content: z.string() }),
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', image: 'https://example.com/test.jpg' }],
          },
        ],
      });

      expect(result.object).toStrictEqual({ content: 'Hello, world!' });
      expect(supportedUrlsCalled).toBe(true);
    });

});

describe('reasoning', () => {
it('should include reasoning in the result', async () => {
const model = new MockLanguageModelV3({
doGenerate: async () => ({
...dummyResponseValues,
content: [
{ type: 'reasoning', text: 'This is a test reasoning.' },
{ type: 'reasoning', text: 'This is another test reasoning.' },
{ type: 'text', text: '{ "content": "Hello, world!" }' },
],
}),
});

      const result = await generateObject({
        model,
        schema: z.object({ content: z.string() }),
        prompt: 'prompt',
      });

      expect(result.reasoning).toMatchInlineSnapshot(`
        "This is a test reasoning.
        This is another test reasoning."
      `);

      expect(result.object).toMatchInlineSnapshot(`
        {
          "content": "Hello, world!",
        }
      `);
    });

});
});

================================================
FILE: packages/ai/src/generate-object/generate-object.ts
================================================
import { JSONValue } from '@ai-sdk/provider';
import {
createIdGenerator,
FlexibleSchema,
InferSchema,
ProviderOptions,
withUserAgentSuffix,
} from '@ai-sdk/provider-utils';
import { NoObjectGeneratedError } from '../error/no-object-generated-error';
import { extractReasoningContent } from '../generate-text/extract-reasoning-content';
import { extractTextContent } from '../generate-text/extract-text-content';
import { logWarnings } from '../logger/log-warnings';
import { resolveLanguageModel } from '../model/resolve-model';
import { CallSettings } from '../prompt/call-settings';
import { convertToLanguageModelPrompt } from '../prompt/convert-to-language-model-prompt';
import { prepareCallSettings } from '../prompt/prepare-call-settings';
import { Prompt } from '../prompt/prompt';
import { standardizePrompt } from '../prompt/standardize-prompt';
import { wrapGatewayError } from '../prompt/wrap-gateway-error';
import { assembleOperationName } from '../telemetry/assemble-operation-name';
import { getBaseTelemetryAttributes } from '../telemetry/get-base-telemetry-attributes';
import { getTracer } from '../telemetry/get-tracer';
import { recordSpan } from '../telemetry/record-span';
import { selectTelemetryAttributes } from '../telemetry/select-telemetry-attributes';
import { stringifyForTelemetry } from '../telemetry/stringify-for-telemetry';
import { TelemetrySettings } from '../telemetry/telemetry-settings';
import {
CallWarning,
FinishReason,
LanguageModel,
} from '../types/language-model';
import { LanguageModelRequestMetadata } from '../types/language-model-request-metadata';
import { LanguageModelResponseMetadata } from '../types/language-model-response-metadata';
import { ProviderMetadata } from '../types/provider-metadata';
import { LanguageModelUsage } from '../types/usage';
import { DownloadFunction } from '../util/download/download-function';
import { prepareHeaders } from '../util/prepare-headers';
import { prepareRetries } from '../util/prepare-retries';
import { VERSION } from '../version';
import { GenerateObjectResult } from './generate-object-result';
import { getOutputStrategy } from './output-strategy';
import { parseAndValidateObjectResultWithRepair } from './parse-and-validate-object-result';
import { RepairTextFunction } from './repair-text';
import { validateObjectGenerationInput } from './validate-object-generation-input';

const originalGenerateId = createIdGenerator({ prefix: 'aiobj', size: 24 });

/\*\*
Generate a structured, typed object for a given prompt and schema using a language model.

This function does not stream the output. If you want to stream the output, use `streamObject` instead.

@param model - The language model to use.
@param tools - Tools that are accessible to and can be called by the model. The model needs to support calling tools.

@param system - A system message that will be part of the prompt.
@param prompt - A simple text prompt. You can either use `prompt` or `messages` but not both.
@param messages - A list of messages. You can either use `prompt` or `messages` but not both.

@param maxOutputTokens - Maximum number of tokens to generate.
@param temperature - Temperature setting.
The value is passed through to the provider. The range depends on the provider and model.
It is recommended to set either `temperature` or `topP`, but not both.
@param topP - Nucleus sampling.
The value is passed through to the provider. The range depends on the provider and model.
It is recommended to set either `temperature` or `topP`, but not both.
@param topK - Only sample from the top K options for each subsequent token.
Used to remove "long tail" low probability responses.
Recommended for advanced use cases only. You usually only need to use temperature.
@param presencePenalty - Presence penalty setting.
It affects the likelihood of the model to repeat information that is already in the prompt.
The value is passed through to the provider. The range depends on the provider and model.
@param frequencyPenalty - Frequency penalty setting.
It affects the likelihood of the model to repeatedly use the same words or phrases.
The value is passed through to the provider. The range depends on the provider and model.
@param stopSequences - Stop sequences.
If set, the model will stop generating text when one of the stop sequences is generated.
@param seed - The seed (integer) to use for random sampling.
If set and supported by the model, calls will generate deterministic results.

@param maxRetries - Maximum number of retries. Set to 0 to disable retries. Default: 2.
@param abortSignal - An optional abort signal that can be used to cancel the call.
@param headers - Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.

@param schema - The schema of the object that the model should generate.
@param schemaName - Optional name of the output that should be generated.
Used by some providers for additional LLM guidance, e.g.
via tool or schema name.
@param schemaDescription - Optional description of the output that should be generated.
Used by some providers for additional LLM guidance, e.g.
via tool or schema description.

@param output - The type of the output.

- 'object': The output is an object.
- 'array': The output is an array.
- 'enum': The output is an enum.
- 'no-schema': The output is not a schema.

@param experimental_repairText - A function that attempts to repair the raw output of the model
to enable JSON parsing.

@param experimental_telemetry - Optional telemetry configuration (experimental).

@param providerOptions - Additional provider-specific options. They are passed through
to the provider from the AI SDK and enable provider-specific
functionality that can be fully encapsulated in the provider.

@returns
A result object that contains the generated object, the finish reason, the token usage, and additional information.
\*/
export async function generateObject<
SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
OUTPUT extends
| 'object'
| 'array'
| 'enum'
| 'no-schema' = InferSchema<SCHEMA> extends string ? 'enum' : 'object',
RESULT = OUTPUT extends 'array'
? Array<InferSchema<SCHEMA>>
: InferSchema<SCHEMA>,

> (
> options: Omit<CallSettings, 'stopSequences'> &

    Prompt &
    (OUTPUT extends 'enum'
      ? {
          /**

The enum values that the model should use.
_/
enum: Array<RESULT>;
mode?: 'json';
output: 'enum';
}
: OUTPUT extends 'no-schema'
? {}
: {
/\*\*
The schema of the object that the model should generate.
_/
schema: SCHEMA;

            /**

Optional name of the output that should be generated.
Used by some providers for additional LLM guidance, e.g.
via tool or schema name.
\*/
schemaName?: string;

            /**

Optional description of the output that should be generated.
Used by some providers for additional LLM guidance, e.g.
via tool or schema description.
\*/
schemaDescription?: string;

            /**

The mode to use for object generation.

The schema is converted into a JSON schema and used in one of the following ways

- 'auto': The provider will choose the best mode for the model.
- 'tool': A tool with the JSON schema as parameters is provided and the provider is instructed to use it.
- 'json': The JSON schema and an instruction are injected into the prompt. If the provider supports JSON mode, it is enabled. If the provider supports JSON grammars, the grammar is used.

Please note that most providers do not support all modes.

Default and recommended: 'auto' (best mode for the model).
\*/
mode?: 'auto' | 'json' | 'tool';
}) & {
output?: OUTPUT;

      /**

The language model to use.
_/
model: LanguageModel;
/\*\*
A function that attempts to repair the raw output of the model
to enable JSON parsing.
_/
experimental_repairText?: RepairTextFunction;

      /**

Optional telemetry configuration (experimental).
\*/

      experimental_telemetry?: TelemetrySettings;

      /**

Custom download function to use for URLs.

By default, files are downloaded if the model does not support the URL for the given media type.
\*/
experimental_download?: DownloadFunction | undefined;

      /**

Additional provider-specific options. They are passed through
to the provider from the AI SDK and enable provider-specific
functionality that can be fully encapsulated in the provider.
\*/
providerOptions?: ProviderOptions;

      /**
       * Internal. For test use only. May change without notice.
       */
      _internal?: {
        generateId?: () => string;
        currentDate?: () => Date;
      };
    },

): Promise<GenerateObjectResult<RESULT>> {
const {
model: modelArg,
output = 'object',
system,
prompt,
messages,
maxRetries: maxRetriesArg,
abortSignal,
headers,
experimental_repairText: repairText,
experimental_telemetry: telemetry,
experimental_download: download,
providerOptions,
\_internal: {
generateId = originalGenerateId,
currentDate = () => new Date(),
} = {},
...settings
} = options;

const model = resolveLanguageModel(modelArg);

const enumValues = 'enum' in options ? options.enum : undefined;
const {
schema: inputSchema,
schemaDescription,
schemaName,
} = 'schema' in options ? options : {};

validateObjectGenerationInput({
output,
schema: inputSchema,
schemaName,
schemaDescription,
enumValues,
});

const { maxRetries, retry } = prepareRetries({
maxRetries: maxRetriesArg,
abortSignal,
});

const outputStrategy = getOutputStrategy({
output,
schema: inputSchema,
enumValues,
});

const callSettings = prepareCallSettings(settings);

const headersWithUserAgent = withUserAgentSuffix(
headers ?? {},
`ai/${VERSION}`,
);

const baseTelemetryAttributes = getBaseTelemetryAttributes({
model,
telemetry,
headers: headersWithUserAgent,
settings: { ...callSettings, maxRetries },
});

const tracer = getTracer(telemetry);
const jsonSchema = await outputStrategy.jsonSchema();

try {
return await recordSpan({
name: 'ai.generateObject',
attributes: selectTelemetryAttributes({
telemetry,
attributes: {
...assembleOperationName({
operationId: 'ai.generateObject',
telemetry,
}),
...baseTelemetryAttributes,
// specific settings that only make sense on the outer level:
'ai.prompt': {
input: () => JSON.stringify({ system, prompt, messages }),
},
'ai.schema':
jsonSchema != null
? { input: () => JSON.stringify(jsonSchema) }
: undefined,
'ai.schema.name': schemaName,
'ai.schema.description': schemaDescription,
'ai.settings.output': outputStrategy.type,
},
}),
tracer,
fn: async span => {
let result: string;
let finishReason: FinishReason;
let usage: LanguageModelUsage;
let warnings: CallWarning[] | undefined;
let response: LanguageModelResponseMetadata;
let request: LanguageModelRequestMetadata;
let resultProviderMetadata: ProviderMetadata | undefined;
let reasoning: string | undefined;

        const standardizedPrompt = await standardizePrompt({
          system,
          prompt,
          messages,
        } as Prompt);

        const promptMessages = await convertToLanguageModelPrompt({
          prompt: standardizedPrompt,
          supportedUrls: await model.supportedUrls,
          download,
        });

        const generateResult = await retry(() =>
          recordSpan({
            name: 'ai.generateObject.doGenerate',
            attributes: selectTelemetryAttributes({
              telemetry,
              attributes: {
                ...assembleOperationName({
                  operationId: 'ai.generateObject.doGenerate',
                  telemetry,
                }),
                ...baseTelemetryAttributes,
                'ai.prompt.messages': {
                  input: () => stringifyForTelemetry(promptMessages),
                },

                // standardized gen-ai llm span attributes:
                'gen_ai.system': model.provider,
                'gen_ai.request.model': model.modelId,
                'gen_ai.request.frequency_penalty':
                  callSettings.frequencyPenalty,
                'gen_ai.request.max_tokens': callSettings.maxOutputTokens,
                'gen_ai.request.presence_penalty': callSettings.presencePenalty,
                'gen_ai.request.temperature': callSettings.temperature,
                'gen_ai.request.top_k': callSettings.topK,
                'gen_ai.request.top_p': callSettings.topP,
              },
            }),
            tracer,
            fn: async span => {
              const result = await model.doGenerate({
                responseFormat: {
                  type: 'json',
                  schema: jsonSchema,
                  name: schemaName,
                  description: schemaDescription,
                },
                ...prepareCallSettings(settings),
                prompt: promptMessages,
                providerOptions,
                abortSignal,
                headers: headersWithUserAgent,
              });

              const responseData = {
                id: result.response?.id ?? generateId(),
                timestamp: result.response?.timestamp ?? currentDate(),
                modelId: result.response?.modelId ?? model.modelId,
                headers: result.response?.headers,
                body: result.response?.body,
              };

              const text = extractTextContent(result.content);
              const reasoning = extractReasoningContent(result.content);

              if (text === undefined) {
                throw new NoObjectGeneratedError({
                  message:
                    'No object generated: the model did not return a response.',
                  response: responseData,
                  usage: result.usage,
                  finishReason: result.finishReason,
                });
              }

              // Add response information to the span:
              span.setAttributes(
                await selectTelemetryAttributes({
                  telemetry,
                  attributes: {
                    'ai.response.finishReason': result.finishReason,
                    'ai.response.object': { output: () => text },
                    'ai.response.id': responseData.id,
                    'ai.response.model': responseData.modelId,
                    'ai.response.timestamp':
                      responseData.timestamp.toISOString(),
                    'ai.response.providerMetadata': JSON.stringify(
                      result.providerMetadata,
                    ),

                    // TODO rename telemetry attributes to inputTokens and outputTokens
                    'ai.usage.promptTokens': result.usage.inputTokens,
                    'ai.usage.completionTokens': result.usage.outputTokens,

                    // standardized gen-ai llm span attributes:
                    'gen_ai.response.finish_reasons': [result.finishReason],
                    'gen_ai.response.id': responseData.id,
                    'gen_ai.response.model': responseData.modelId,
                    'gen_ai.usage.input_tokens': result.usage.inputTokens,
                    'gen_ai.usage.output_tokens': result.usage.outputTokens,
                  },
                }),
              );

              return {
                ...result,
                objectText: text,
                reasoning,
                responseData,
              };
            },
          }),
        );

        result = generateResult.objectText;
        finishReason = generateResult.finishReason;
        usage = generateResult.usage;
        warnings = generateResult.warnings;
        resultProviderMetadata = generateResult.providerMetadata;
        request = generateResult.request ?? {};
        response = generateResult.responseData;
        reasoning = generateResult.reasoning;

        logWarnings({
          warnings,
          provider: model.provider,
          model: model.modelId,
        });

        const object = await parseAndValidateObjectResultWithRepair(
          result,
          outputStrategy,
          repairText,
          {
            response,
            usage,
            finishReason,
          },
        );

        // Add response information to the span:
        span.setAttributes(
          await selectTelemetryAttributes({
            telemetry,
            attributes: {
              'ai.response.finishReason': finishReason,
              'ai.response.object': {
                output: () => JSON.stringify(object),
              },
              'ai.response.providerMetadata': JSON.stringify(
                resultProviderMetadata,
              ),

              // TODO rename telemetry attributes to inputTokens and outputTokens
              'ai.usage.promptTokens': usage.inputTokens,
              'ai.usage.completionTokens': usage.outputTokens,
            },
          }),
        );

        return new DefaultGenerateObjectResult({
          object,
          reasoning,
          finishReason,
          usage,
          warnings,
          request,
          response,
          providerMetadata: resultProviderMetadata,
        });
      },
    });

} catch (error) {
throw wrapGatewayError(error);
}
}

class DefaultGenerateObjectResult<T> implements GenerateObjectResult<T> {
readonly object: GenerateObjectResult<T>['object'];
readonly finishReason: GenerateObjectResult<T>['finishReason'];
readonly usage: GenerateObjectResult<T>['usage'];
readonly warnings: GenerateObjectResult<T>['warnings'];
readonly providerMetadata: GenerateObjectResult<T>['providerMetadata'];
readonly response: GenerateObjectResult<T>['response'];
readonly request: GenerateObjectResult<T>['request'];
readonly reasoning: GenerateObjectResult<T>['reasoning'];

constructor(options: {
object: GenerateObjectResult<T>['object'];
finishReason: GenerateObjectResult<T>['finishReason'];
usage: GenerateObjectResult<T>['usage'];
warnings: GenerateObjectResult<T>['warnings'];
providerMetadata: GenerateObjectResult<T>['providerMetadata'];
response: GenerateObjectResult<T>['response'];
request: GenerateObjectResult<T>['request'];
reasoning: GenerateObjectResult<T>['reasoning'];
}) {
this.object = options.object;
this.finishReason = options.finishReason;
this.usage = options.usage;
this.warnings = options.warnings;
this.providerMetadata = options.providerMetadata;
this.response = options.response;
this.request = options.request;
this.reasoning = options.reasoning;
}

toJsonResponse(init?: ResponseInit): Response {
return new Response(JSON.stringify(this.object), {
status: init?.status ?? 200,
headers: prepareHeaders(init?.headers, {
'content-type': 'application/json; charset=utf-8',
}),
});
}
}

================================================
FILE: packages/ai/src/generate-object/index.ts
================================================
export { generateObject } from './generate-object';
export type { RepairTextFunction } from './repair-text';
export type { GenerateObjectResult } from './generate-object-result';
export { streamObject } from './stream-object';
export type { StreamObjectOnFinishCallback } from './stream-object';
export type {
ObjectStreamPart,
StreamObjectResult,
} from './stream-object-result';

================================================
FILE: packages/ai/src/generate-object/inject-json-instruction.test.ts
================================================
import { JSONSchema7 } from '@ai-sdk/provider';
import { injectJsonInstruction } from './inject-json-instruction';
import { describe, it, expect } from 'vitest';

const basicSchema: JSONSchema7 = {
type: 'object',
properties: {
name: { type: 'string' },
age: { type: 'number' },
},
required: ['name', 'age'],
};

it('should handle basic case with prompt and schema', () => {
const result = injectJsonInstruction({
prompt: 'Generate a person',
schema: basicSchema,
});
expect(result).toBe(
'Generate a person\n\n' +
'JSON schema:\n' +
'{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"number"}},"required":["name","age"]}\n' +
'You MUST answer with a JSON object that matches the JSON schema above.',
);
});

it('should handle only prompt, no schema', () => {
const result = injectJsonInstruction({
prompt: 'Generate a person',
});
expect(result).toBe('Generate a person\n\nYou MUST answer with JSON.');
});

it('should handle only schema, no prompt', () => {
const result = injectJsonInstruction({
schema: basicSchema,
});
expect(result).toBe(
'JSON schema:\n' +
'{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"number"}},"required":["name","age"]}\n' +
'You MUST answer with a JSON object that matches the JSON schema above.',
);
});

it('should handle no prompt, no schema', () => {
const result = injectJsonInstruction({});
expect(result).toBe('You MUST answer with JSON.');
});

it('should handle custom schemaPrefix and schemaSuffix', () => {
const result = injectJsonInstruction({
prompt: 'Generate a person',
schema: basicSchema,
schemaPrefix: 'Custom prefix:',
schemaSuffix: 'Custom suffix',
});
expect(result).toBe(
'Generate a person\n\n' +
'Custom prefix:\n' +
'{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"number"}},"required":["name","age"]}\n' +
'Custom suffix',
);
});

it('should handle empty string prompt', () => {
const result = injectJsonInstruction({
prompt: '',
schema: basicSchema,
});
expect(result).toBe(
'JSON schema:\n' +
'{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"number"}},"required":["name","age"]}\n' +
'You MUST answer with a JSON object that matches the JSON schema above.',
);
});

it('should handle empty object schema', () => {
const result = injectJsonInstruction({
prompt: 'Generate something',
schema: {},
});
expect(result).toBe(
'Generate something\n\n' +
'JSON schema:\n' +
'{}\n' +
'You MUST answer with a JSON object that matches the JSON schema above.',
);
});

it('should handle complex nested schema', () => {
const complexSchema: JSONSchema7 = {
type: 'object',
properties: {
person: {
type: 'object',
properties: {
name: { type: 'string' },
age: { type: 'number' },
address: {
type: 'object',
properties: {
street: { type: 'string' },
city: { type: 'string' },
},
},
},
},
},
};
const result = injectJsonInstruction({
prompt: 'Generate a complex person',
schema: complexSchema,
});
expect(result).toBe(
'Generate a complex person\n\n' +
'JSON schema:\n' +
'{"type":"object","properties":{"person":{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"number"},"address":{"type":"object","properties":{"street":{"type":"string"},"city":{"type":"string"}}}}}}}\n' +
'You MUST answer with a JSON object that matches the JSON schema above.',
);
});

it('should handle schema with special characters', () => {
const specialSchema: JSONSchema7 = {
type: 'object',
properties: {
'special@property': { type: 'string' },
'emoji😊': { type: 'string' },
},
};
const result = injectJsonInstruction({
schema: specialSchema,
});
expect(result).toBe(
'JSON schema:\n' +
'{"type":"object","properties":{"special@property":{"type":"string"},"emoji😊":{"type":"string"}}}\n' +
'You MUST answer with a JSON object that matches the JSON schema above.',
);
});

it('should handle very long prompt and schema', () => {
const longPrompt = 'A'.repeat(1000);
const longSchema: JSONSchema7 = {
type: 'object',
properties: {},
};
for (let i = 0; i < 100; i++) {
longSchema.properties![`prop${i}`] = { type: 'string' };
}
const result = injectJsonInstruction({
prompt: longPrompt,
schema: longSchema,
});
expect(result).toBe(
longPrompt +
'\n\n' +
'JSON schema:\n' +
JSON.stringify(longSchema) +
'\n' +
'You MUST answer with a JSON object that matches the JSON schema above.',
);
});

it('should handle null values for optional parameters', () => {
const result = injectJsonInstruction({
prompt: null as any,
schema: null as any,
schemaPrefix: null as any,
schemaSuffix: null as any,
});
expect(result).toBe('');
});

it('should handle undefined values for optional parameters', () => {
const result = injectJsonInstruction({
prompt: undefined,
schema: undefined,
schemaPrefix: undefined,
schemaSuffix: undefined,
});
expect(result).toBe('You MUST answer with JSON.');
});

================================================
FILE: packages/ai/src/generate-object/inject-json-instruction.ts
================================================
import { JSONSchema7 } from '@ai-sdk/provider';

const DEFAULT_SCHEMA_PREFIX = 'JSON schema:';
const DEFAULT_SCHEMA_SUFFIX =
'You MUST answer with a JSON object that matches the JSON schema above.';
const DEFAULT_GENERIC_SUFFIX = 'You MUST answer with JSON.';

export function injectJsonInstruction({
prompt,
schema,
schemaPrefix = schema != null ? DEFAULT_SCHEMA_PREFIX : undefined,
schemaSuffix = schema != null
? DEFAULT_SCHEMA_SUFFIX
: DEFAULT_GENERIC_SUFFIX,
}: {
prompt?: string;
schema?: JSONSchema7;
schemaPrefix?: string;
schemaSuffix?: string;
}): string {
return [
prompt != null && prompt.length > 0 ? prompt : undefined,
prompt != null && prompt.length > 0 ? '' : undefined, // add a newline if prompt is not null
schemaPrefix,
schema != null ? JSON.stringify(schema) : undefined,
schemaSuffix,
]
.filter(line => line != null)
.join('\n');
}

================================================
FILE: packages/ai/src/generate-object/output-strategy.ts
================================================
import {
isJSONArray,
isJSONObject,
JSONObject,
JSONSchema7,
JSONValue,
TypeValidationError,
UnsupportedFunctionalityError,
} from '@ai-sdk/provider';
import {
asSchema,
FlexibleSchema,
safeValidateTypes,
Schema,
ValidationResult,
} from '@ai-sdk/provider-utils';
import { NoObjectGeneratedError } from '../error/no-object-generated-error';
import {
FinishReason,
LanguageModelResponseMetadata,
LanguageModelUsage,
} from '../types';
import {
AsyncIterableStream,
createAsyncIterableStream,
} from '../util/async-iterable-stream';
import { DeepPartial } from '../util/deep-partial';
import { ObjectStreamPart } from './stream-object-result';

export interface OutputStrategy<PARTIAL, RESULT, ELEMENT_STREAM> {
readonly type: 'object' | 'array' | 'enum' | 'no-schema';

jsonSchema(): Promise<JSONSchema7 | undefined>;

validatePartialResult({
value,
textDelta,
isFinalDelta,
}: {
value: JSONValue;
textDelta: string;
isFirstDelta: boolean;
isFinalDelta: boolean;
latestObject: PARTIAL | undefined;
}): Promise<
ValidationResult<{
partial: PARTIAL;
textDelta: string;
}>

> ;
> validateFinalResult(

    value: JSONValue | undefined,
    context: {
      text: string;
      response: LanguageModelResponseMetadata;
      usage: LanguageModelUsage;
    },

): Promise<ValidationResult<RESULT>>;

createElementStream(
originalStream: ReadableStream<ObjectStreamPart<PARTIAL>>,
): ELEMENT_STREAM;
}

const noSchemaOutputStrategy: OutputStrategy<JSONValue, JSONValue, never> = {
type: 'no-schema',
jsonSchema: async () => undefined,

async validatePartialResult({ value, textDelta }) {
return { success: true, value: { partial: value, textDelta } };
},

async validateFinalResult(
value: JSONValue | undefined,
context: {
text: string;
response: LanguageModelResponseMetadata;
usage: LanguageModelUsage;
finishReason: FinishReason;
},
): Promise<ValidationResult<JSONValue>> {
return value === undefined
? {
success: false,
error: new NoObjectGeneratedError({
message: 'No object generated: response did not match schema.',
text: context.text,
response: context.response,
usage: context.usage,
finishReason: context.finishReason,
}),
}
: { success: true, value };
},

createElementStream() {
throw new UnsupportedFunctionalityError({
functionality: 'element streams in no-schema mode',
});
},
};

const objectOutputStrategy = <OBJECT>(
schema: Schema<OBJECT>,
): OutputStrategy<DeepPartial<OBJECT>, OBJECT, never> => ({
type: 'object',
jsonSchema: async () => await schema.jsonSchema,

async validatePartialResult({ value, textDelta }) {
return {
success: true,
value: {
// Note: currently no validation of partial results:
partial: value as DeepPartial<OBJECT>,
textDelta,
},
};
},

async validateFinalResult(
value: JSONValue | undefined,
): Promise<ValidationResult<OBJECT>> {
return safeValidateTypes({ value, schema });
},

createElementStream() {
throw new UnsupportedFunctionalityError({
functionality: 'element streams in object mode',
});
},
});

const arrayOutputStrategy = <ELEMENT>(
schema: Schema<ELEMENT>,
): OutputStrategy<ELEMENT[], ELEMENT[], AsyncIterableStream<ELEMENT>> => {
return {
type: 'array',

    // wrap in object that contains array of elements, since most LLMs will not
    // be able to generate an array directly:
    // possible future optimization: use arrays directly when model supports grammar-guided generation
    jsonSchema: async () => {
      // remove $schema from schema.jsonSchema:
      const { $schema, ...itemSchema } = await schema.jsonSchema;

      return {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          elements: { type: 'array', items: itemSchema },
        },
        required: ['elements'],
        additionalProperties: false,
      };
    },

    async validatePartialResult({
      value,
      latestObject,
      isFirstDelta,
      isFinalDelta,
    }) {
      // check that the value is an object that contains an array of elements:
      if (!isJSONObject(value) || !isJSONArray(value.elements)) {
        return {
          success: false,
          error: new TypeValidationError({
            value,
            cause: 'value must be an object that contains an array of elements',
          }),
        };
      }

      const inputArray = value.elements as Array<JSONObject>;
      const resultArray: Array<ELEMENT> = [];

      for (let i = 0; i < inputArray.length; i++) {
        const element = inputArray[i];
        const result = await safeValidateTypes({ value: element, schema });

        // special treatment for last processed element:
        // ignore parse or validation failures, since they indicate that the
        // last element is incomplete and should not be included in the result,
        // unless it is the final delta
        if (i === inputArray.length - 1 && !isFinalDelta) {
          continue;
        }

        if (!result.success) {
          return result;
        }

        resultArray.push(result.value);
      }

      // calculate delta:
      const publishedElementCount = latestObject?.length ?? 0;

      let textDelta = '';

      if (isFirstDelta) {
        textDelta += '[';
      }

      if (publishedElementCount > 0) {
        textDelta += ',';
      }

      textDelta += resultArray
        .slice(publishedElementCount) // only new elements
        .map(element => JSON.stringify(element))
        .join(',');

      if (isFinalDelta) {
        textDelta += ']';
      }

      return {
        success: true,
        value: {
          partial: resultArray,
          textDelta,
        },
      };
    },

    async validateFinalResult(
      value: JSONValue | undefined,
    ): Promise<ValidationResult<Array<ELEMENT>>> {
      // check that the value is an object that contains an array of elements:
      if (!isJSONObject(value) || !isJSONArray(value.elements)) {
        return {
          success: false,
          error: new TypeValidationError({
            value,
            cause: 'value must be an object that contains an array of elements',
          }),
        };
      }

      const inputArray = value.elements as Array<JSONObject>;

      // check that each element in the array is of the correct type:
      for (const element of inputArray) {
        const result = await safeValidateTypes({ value: element, schema });
        if (!result.success) {
          return result;
        }
      }

      return { success: true, value: inputArray as Array<ELEMENT> };
    },

    createElementStream(
      originalStream: ReadableStream<ObjectStreamPart<ELEMENT[]>>,
    ) {
      let publishedElements = 0;

      return createAsyncIterableStream(
        originalStream.pipeThrough(
          new TransformStream<ObjectStreamPart<ELEMENT[]>, ELEMENT>({
            transform(chunk, controller) {
              switch (chunk.type) {
                case 'object': {
                  const array = chunk.object;

                  // publish new elements one by one:
                  for (
                    ;
                    publishedElements < array.length;
                    publishedElements++
                  ) {
                    controller.enqueue(array[publishedElements]);
                  }

                  break;
                }

                case 'text-delta':
                case 'finish':
                case 'error': // suppress error (use onError instead)
                  break;

                default: {
                  const _exhaustiveCheck: never = chunk;
                  throw new Error(
                    `Unsupported chunk type: ${_exhaustiveCheck}`,
                  );
                }
              }
            },
          }),
        ),
      );
    },

};
};

const enumOutputStrategy = <ENUM extends string>(
enumValues: Array<ENUM>,
): OutputStrategy<string, ENUM, never> => {
return {
type: 'enum',

    // wrap in object that contains result, since most LLMs will not
    // be able to generate an enum value directly:
    // possible future optimization: use enums directly when model supports top-level enums
    jsonSchema: async () => ({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        result: { type: 'string', enum: enumValues },
      },
      required: ['result'],
      additionalProperties: false,
    }),

    async validateFinalResult(
      value: JSONValue | undefined,
    ): Promise<ValidationResult<ENUM>> {
      // check that the value is an object that contains an array of elements:
      if (!isJSONObject(value) || typeof value.result !== 'string') {
        return {
          success: false,
          error: new TypeValidationError({
            value,
            cause:
              'value must be an object that contains a string in the "result" property.',
          }),
        };
      }

      const result = value.result as string;

      return enumValues.includes(result as ENUM)
        ? { success: true, value: result as ENUM }
        : {
            success: false,
            error: new TypeValidationError({
              value,
              cause: 'value must be a string in the enum',
            }),
          };
    },

    async validatePartialResult({ value, textDelta }) {
      if (!isJSONObject(value) || typeof value.result !== 'string') {
        return {
          success: false,
          error: new TypeValidationError({
            value,
            cause:
              'value must be an object that contains a string in the "result" property.',
          }),
        };
      }

      const result = value.result as string;
      const possibleEnumValues = enumValues.filter(enumValue =>
        enumValue.startsWith(result),
      );

      if (value.result.length === 0 || possibleEnumValues.length === 0) {
        return {
          success: false,
          error: new TypeValidationError({
            value,
            cause: 'value must be a string in the enum',
          }),
        };
      }

      return {
        success: true,
        value: {
          partial:
            possibleEnumValues.length > 1 ? result : possibleEnumValues[0],
          textDelta,
        },
      };
    },

    createElementStream() {
      // no streaming in enum mode
      throw new UnsupportedFunctionalityError({
        functionality: 'element streams in enum mode',
      });
    },

};
};

export function getOutputStrategy<SCHEMA>({
output,
schema,
enumValues,
}: {
output: 'object' | 'array' | 'enum' | 'no-schema';
schema?: FlexibleSchema<SCHEMA>;
enumValues?: Array<SCHEMA>;
}): OutputStrategy<any, any, any> {
switch (output) {
case 'object':
return objectOutputStrategy(asSchema(schema!));
case 'array':
return arrayOutputStrategy(asSchema(schema!));
case 'enum':
return enumOutputStrategy(enumValues! as Array<string>);
case 'no-schema':
return noSchemaOutputStrategy;
default: {
const \_exhaustiveCheck: never = output;
throw new Error(`Unsupported output: ${_exhaustiveCheck}`);
}
}
}

================================================
FILE: packages/ai/src/generate-object/parse-and-validate-object-result.ts
================================================
import { JSONParseError, TypeValidationError } from '@ai-sdk/provider';
import { safeParseJSON } from '@ai-sdk/provider-utils';
import { NoObjectGeneratedError } from '../error/no-object-generated-error';
import type {
FinishReason,
LanguageModelResponseMetadata,
LanguageModelUsage,
} from '../types';
import type { OutputStrategy } from './output-strategy';
import { RepairTextFunction } from './repair-text';

/\*\*

- Parses and validates a result string by parsing it as JSON and validating against the output strategy.
-
- @param result - The result string to parse and validate
- @param outputStrategy - The output strategy containing validation logic
- @param context - Additional context for error reporting
- @returns The validated result
- @throws NoObjectGeneratedError if parsing or validation fails
  \*/
  async function parseAndValidateObjectResult<RESULT>(
  result: string,
  outputStrategy: OutputStrategy<any, RESULT, any>,
  context: {
  response: LanguageModelResponseMetadata;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
  },
  ): Promise<RESULT> {
  const parseResult = await safeParseJSON({ text: result });

if (!parseResult.success) {
throw new NoObjectGeneratedError({
message: 'No object generated: could not parse the response.',
cause: parseResult.error,
text: result,
response: context.response,
usage: context.usage,
finishReason: context.finishReason,
});
}

const validationResult = await outputStrategy.validateFinalResult(
parseResult.value,
{
text: result,
response: context.response,
usage: context.usage,
},
);

if (!validationResult.success) {
throw new NoObjectGeneratedError({
message: 'No object generated: response did not match schema.',
cause: validationResult.error,
text: result,
response: context.response,
usage: context.usage,
finishReason: context.finishReason,
});
}

return validationResult.value;
}

/\*\*

- Parses and validates a result string by parsing it as JSON and validating against the output strategy.
- If the result cannot be parsed, it attempts to repair the result using the repairText function.
-
- @param result - The result string to parse and validate
- @param outputStrategy - The output strategy containing validation logic
- @param repairText - A function that attempts to repair the result string
- @param context - Additional context for error reporting
- @returns The validated result
- @throws NoObjectGeneratedError if parsing or validation fails
  \*/
  export async function parseAndValidateObjectResultWithRepair<RESULT>(
  result: string,
  outputStrategy: OutputStrategy<any, RESULT, any>,
  repairText: RepairTextFunction | undefined,
  context: {
  response: LanguageModelResponseMetadata;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
  },
  ): Promise<RESULT> {
  try {
  return await parseAndValidateObjectResult(result, outputStrategy, context);
  } catch (error) {
  if (
  repairText != null &&
  NoObjectGeneratedError.isInstance(error) &&
  (JSONParseError.isInstance(error.cause) ||
  TypeValidationError.isInstance(error.cause))
  ) {
  const repairedText = await repairText({
  text: result,
  error: error.cause,
  });
  if (repairedText === null) {
  throw error;
  }
  return await parseAndValidateObjectResult(
  repairedText,
  outputStrategy,
  context,
  );
  }
  throw error;
  }
  }

================================================
FILE: packages/ai/src/generate-object/repair-text.ts
================================================
import { JSONParseError, TypeValidationError } from '@ai-sdk/provider';

/\*\*
A function that attempts to repair the raw output of the model
to enable JSON parsing.

Should return the repaired text or null if the text cannot be repaired.
\*/
export type RepairTextFunction = (options: {
text: string;
error: JSONParseError | TypeValidationError;
}) => Promise<string | null>;

================================================
FILE: packages/ai/src/generate-object/stream-object-result.ts
================================================
import { ServerResponse } from 'http';
import { AsyncIterableStream } from '../util/async-iterable-stream';
import {
CallWarning,
FinishReason,
LanguageModelRequestMetadata,
LanguageModelResponseMetadata,
ProviderMetadata,
} from '../types';
import { LanguageModelUsage } from '../types/usage';

/**
The result of a `streamObject` call that contains the partial object stream and additional information.
\*/
export interface StreamObjectResult<PARTIAL, RESULT, ELEMENT_STREAM> {
/**
Warnings from the model provider (e.g. unsupported settings)
\*/
readonly warnings: Promise<CallWarning[] | undefined>;

/\*_
The token usage of the generated response. Resolved when the response is finished.
_/
readonly usage: Promise<LanguageModelUsage>;

/\*_
Additional provider-specific metadata. They are passed through
from the provider to the AI SDK and enable provider-specific
results that can be fully encapsulated in the provider.
_/
readonly providerMetadata: Promise<ProviderMetadata | undefined>;

/\*_
Additional request information from the last step.
_/
readonly request: Promise<LanguageModelRequestMetadata>;

/\*_
Additional response information.
_/
readonly response: Promise<LanguageModelResponseMetadata>;

/\*\*
The reason why the generation finished. Taken from the last step.

Resolved when the response is finished.
\*/
readonly finishReason: Promise<FinishReason>;

/\*_
The generated object (typed according to the schema). Resolved when the response is finished.
_/
readonly object: Promise<RESULT>;

/\*\*
Stream of partial objects. It gets more complete as the stream progresses.

Note that the partial object is not validated.
If you want to be certain that the actual content matches your schema, you need to implement your own validation for partial results.
\*/
readonly partialObjectStream: AsyncIterableStream<PARTIAL>;

/\*\*

- Stream over complete array elements. Only available if the output strategy is set to `array`.
  \*/
  readonly elementStream: ELEMENT_STREAM;

/\*_
Text stream of the JSON representation of the generated object. It contains text chunks.
When the stream is finished, the object is valid JSON that can be parsed.
_/
readonly textStream: AsyncIterableStream<string>;

/\*_
Stream of different types of events, including partial objects, errors, and finish events.
Only errors that stop the stream, such as network errors, are thrown.
_/
readonly fullStream: AsyncIterableStream<ObjectStreamPart<PARTIAL>>;

/\*\*
Writes text delta output to a Node.js response-like object.
It sets a `Content-Type` header to `text/plain; charset=utf-8` and
writes each text delta as a separate chunk.

@param response A Node.js response-like object (ServerResponse).
@param init Optional headers, status code, and status text.
\*/
pipeTextStreamToResponse(response: ServerResponse, init?: ResponseInit): void;

/\*\*
Creates a simple text stream response.
The response has a `Content-Type` header set to `text/plain; charset=utf-8`.
Each text delta is encoded as UTF-8 and sent as a separate chunk.
Non-text-delta events are ignored.

@param init Optional headers, status code, and status text.
\*/
toTextStreamResponse(init?: ResponseInit): Response;
}

export type ObjectStreamPart<PARTIAL> =
| {
type: 'object';
object: PARTIAL;
}
| {
type: 'text-delta';
textDelta: string;
}
| {
type: 'error';
error: unknown;
}
| {
type: 'finish';
finishReason: FinishReason;
usage: LanguageModelUsage;
response: LanguageModelResponseMetadata;
providerMetadata?: ProviderMetadata;
};

================================================
FILE: packages/ai/src/generate-object/stream-object.test-d.ts
================================================
import { JSONValue } from '@ai-sdk/provider';
import { expectTypeOf } from 'vitest';
import { z } from 'zod/v4';
import { AsyncIterableStream } from '../util/async-iterable-stream';
import { FinishReason } from '../types';
import { streamObject } from './stream-object';
import { describe, it } from 'vitest';

describe('streamObject', () => {
it('should have finishReason property with correct type', () => {
const result = streamObject({
schema: z.object({ number: z.number() }),
model: undefined!,
prompt: 'test',
});

    expectTypeOf<typeof result.finishReason>().toEqualTypeOf<
      Promise<FinishReason>
    >();

});

it('should support enum types', async () => {
const result = await streamObject({
output: 'enum',
enum: ['a', 'b', 'c'] as const,
model: undefined!,
prompt: 'test',
});

    expectTypeOf<typeof result.object>().toEqualTypeOf<
      Promise<'a' | 'b' | 'c'>
    >;

    for await (const text of result.partialObjectStream) {
      expectTypeOf(text).toEqualTypeOf<string>();
    }

});

it('should support schema types', async () => {
const result = streamObject({
schema: z.object({ number: z.number() }),
model: undefined!,
prompt: 'test',
});

    expectTypeOf<typeof result.object>().toEqualTypeOf<
      Promise<{ number: number }>
    >();

});

it('should support no-schema output mode', async () => {
const result = streamObject({
output: 'no-schema',
model: undefined!,
prompt: 'test',
});

    expectTypeOf<typeof result.object>().toEqualTypeOf<Promise<JSONValue>>();

});

it('should support array output mode', async () => {
const result = streamObject({
output: 'array',
schema: z.number(),
model: undefined!,
prompt: 'test',
});

    expectTypeOf<typeof result.partialObjectStream>().toEqualTypeOf<
      AsyncIterableStream<number[]>
    >();
    expectTypeOf<typeof result.object>().toEqualTypeOf<Promise<number[]>>();

});
});

================================================
FILE: packages/ai/src/generate-object/stream-object.ts
================================================
import {
JSONValue,
LanguageModelV3CallWarning,
LanguageModelV3FinishReason,
LanguageModelV3StreamPart,
LanguageModelV3Usage,
SharedV3ProviderMetadata,
} from '@ai-sdk/provider';
import {
createIdGenerator,
FlexibleSchema,
ProviderOptions,
type InferSchema,
} from '@ai-sdk/provider-utils';
import { ServerResponse } from 'http';
import { logWarnings } from '../logger/log-warnings';
import { resolveLanguageModel } from '../model/resolve-model';
import { CallSettings } from '../prompt/call-settings';
import { convertToLanguageModelPrompt } from '../prompt/convert-to-language-model-prompt';
import { prepareCallSettings } from '../prompt/prepare-call-settings';
import { Prompt } from '../prompt/prompt';
import { standardizePrompt } from '../prompt/standardize-prompt';
import { wrapGatewayError } from '../prompt/wrap-gateway-error';
import { assembleOperationName } from '../telemetry/assemble-operation-name';
import { getBaseTelemetryAttributes } from '../telemetry/get-base-telemetry-attributes';
import { getTracer } from '../telemetry/get-tracer';
import { recordSpan } from '../telemetry/record-span';
import { selectTelemetryAttributes } from '../telemetry/select-telemetry-attributes';
import { stringifyForTelemetry } from '../telemetry/stringify-for-telemetry';
import { TelemetrySettings } from '../telemetry/telemetry-settings';
import { createTextStreamResponse } from '../text-stream/create-text-stream-response';
import { pipeTextStreamToResponse } from '../text-stream/pipe-text-stream-to-response';
import {
CallWarning,
FinishReason,
LanguageModel,
} from '../types/language-model';
import { LanguageModelRequestMetadata } from '../types/language-model-request-metadata';
import { LanguageModelResponseMetadata } from '../types/language-model-response-metadata';
import { ProviderMetadata } from '../types/provider-metadata';
import { LanguageModelUsage } from '../types/usage';
import { DeepPartial, isDeepEqualData, parsePartialJson } from '../util';
import {
AsyncIterableStream,
createAsyncIterableStream,
} from '../util/async-iterable-stream';
import { createStitchableStream } from '../util/create-stitchable-stream';
import { DelayedPromise } from '../util/delayed-promise';
import { DownloadFunction } from '../util/download/download-function';
import { now as originalNow } from '../util/now';
import { prepareRetries } from '../util/prepare-retries';
import { getOutputStrategy, OutputStrategy } from './output-strategy';
import { parseAndValidateObjectResultWithRepair } from './parse-and-validate-object-result';
import { RepairTextFunction } from './repair-text';
import { ObjectStreamPart, StreamObjectResult } from './stream-object-result';
import { validateObjectGenerationInput } from './validate-object-generation-input';

const originalGenerateId = createIdGenerator({ prefix: 'aiobj', size: 24 });

/\*\*
Callback that is set using the `onError` option.

@param event - The event that is passed to the callback.
\*/
export type StreamObjectOnErrorCallback = (event: {
error: unknown;
}) => Promise<void> | void;

/\*\*
Callback that is set using the `onFinish` option.

@param event - The event that is passed to the callback.
_/
export type StreamObjectOnFinishCallback<RESULT> = (event: {
/\*\*
The token usage of the generated response.
_/
usage: LanguageModelUsage;

/\*_
The generated object. Can be undefined if the final object does not match the schema.
_/
object: RESULT | undefined;

/\*_
Optional error object. This is e.g. a TypeValidationError when the final object does not match the schema.
_/
error: unknown | undefined;

/\*_
Response metadata.
_/
response: LanguageModelResponseMetadata;

/\*_
Warnings from the model provider (e.g. unsupported settings).
_/
warnings?: CallWarning[];

/\*_
Additional provider-specific metadata. They are passed through
to the provider from the AI SDK and enable provider-specific
functionality that can be fully encapsulated in the provider.
_/
providerMetadata: ProviderMetadata | undefined;
}) => Promise<void> | void;

/\*\*
Generate a structured, typed object for a given prompt and schema using a language model.

This function streams the output. If you do not want to stream the output, use `generateObject` instead.

@param model - The language model to use.
@param tools - Tools that are accessible to and can be called by the model. The model needs to support calling tools.

@param system - A system message that will be part of the prompt.
@param prompt - A simple text prompt. You can either use `prompt` or `messages` but not both.
@param messages - A list of messages. You can either use `prompt` or `messages` but not both.

@param maxOutputTokens - Maximum number of tokens to generate.
@param temperature - Temperature setting.
The value is passed through to the provider. The range depends on the provider and model.
It is recommended to set either `temperature` or `topP`, but not both.
@param topP - Nucleus sampling.
The value is passed through to the provider. The range depends on the provider and model.
It is recommended to set either `temperature` or `topP`, but not both.
@param topK - Only sample from the top K options for each subsequent token.
Used to remove "long tail" low probability responses.
Recommended for advanced use cases only. You usually only need to use temperature.
@param presencePenalty - Presence penalty setting.
It affects the likelihood of the model to repeat information that is already in the prompt.
The value is passed through to the provider. The range depends on the provider and model.
@param frequencyPenalty - Frequency penalty setting.
It affects the likelihood of the model to repeatedly use the same words or phrases.
The value is passed through to the provider. The range depends on the provider and model.
@param stopSequences - Stop sequences.
If set, the model will stop generating text when one of the stop sequences is generated.
@param seed - The seed (integer) to use for random sampling.
If set and supported by the model, calls will generate deterministic results.

@param maxRetries - Maximum number of retries. Set to 0 to disable retries. Default: 2.
@param abortSignal - An optional abort signal that can be used to cancel the call.
@param headers - Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.

@param schema - The schema of the object that the model should generate.
@param schemaName - Optional name of the output that should be generated.
Used by some providers for additional LLM guidance, e.g.
via tool or schema name.
@param schemaDescription - Optional description of the output that should be generated.
Used by some providers for additional LLM guidance, e.g.
via tool or schema description.

@param output - The type of the output.

- 'object': The output is an object.
- 'array': The output is an array.
- 'enum': The output is an enum.
- 'no-schema': The output is not a schema.

@param experimental_telemetry - Optional telemetry configuration (experimental).

@param providerOptions - Additional provider-specific options. They are passed through
to the provider from the AI SDK and enable provider-specific
functionality that can be fully encapsulated in the provider.

@returns
A result object for accessing the partial object stream and additional information.
\*/
export function streamObject<
SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
OUTPUT extends
| 'object'
| 'array'
| 'enum'
| 'no-schema' = InferSchema<SCHEMA> extends string ? 'enum' : 'object',
RESULT = OUTPUT extends 'array'
? Array<InferSchema<SCHEMA>>
: InferSchema<SCHEMA>,

> (
> options: Omit<CallSettings, 'stopSequences'> &

    Prompt &
    (OUTPUT extends 'enum'
      ? {
          /**

The enum values that the model should use.
_/
enum: Array<RESULT>;
mode?: 'json';
output: 'enum';
}
: OUTPUT extends 'no-schema'
? {}
: {
/\*\*
The schema of the object that the model should generate.
_/
schema: SCHEMA;

            /**

Optional name of the output that should be generated.
Used by some providers for additional LLM guidance, e.g.
via tool or schema name.
\*/
schemaName?: string;

            /**

Optional description of the output that should be generated.
Used by some providers for additional LLM guidance, e.g.
via tool or schema description.
\*/
schemaDescription?: string;

            /**

The mode to use for object generation.

The schema is converted into a JSON schema and used in one of the following ways

- 'auto': The provider will choose the best mode for the model.
- 'tool': A tool with the JSON schema as parameters is provided and the provider is instructed to use it.
- 'json': The JSON schema and an instruction are injected into the prompt. If the provider supports JSON mode, it is enabled. If the provider supports JSON grammars, the grammar is used.

Please note that most providers do not support all modes.

Default and recommended: 'auto' (best mode for the model).
\*/
mode?: 'auto' | 'json' | 'tool';
}) & {
output?: OUTPUT;

      /**

The language model to use.
\*/
model: LanguageModel;

      /**

A function that attempts to repair the raw output of the model
to enable JSON parsing.
\*/
experimental_repairText?: RepairTextFunction;

      /**

Optional telemetry configuration (experimental).
\*/

      experimental_telemetry?: TelemetrySettings;

      /**

Custom download function to use for URLs.

By default, files are downloaded if the model does not support the URL for the given media type.
\*/
experimental_download?: DownloadFunction | undefined;

      /**

Additional provider-specific options. They are passed through
to the provider from the AI SDK and enable provider-specific
functionality that can be fully encapsulated in the provider.
\*/
providerOptions?: ProviderOptions;

      /**

Callback that is invoked when an error occurs during streaming.
You can use it to log errors.
The stream processing will pause until the callback promise is resolved.
\*/
onError?: StreamObjectOnErrorCallback;

      /**

Callback that is called when the LLM response and the final object validation are finished.
\*/
onFinish?: StreamObjectOnFinishCallback<RESULT>;

      /**
       * Internal. For test use only. May change without notice.
       */
      _internal?: {
        generateId?: () => string;
        currentDate?: () => Date;
        now?: () => number;
      };
    },

): StreamObjectResult<
OUTPUT extends 'enum'
? string
: OUTPUT extends 'array'
? RESULT
: DeepPartial<RESULT>,
OUTPUT extends 'array' ? RESULT : RESULT,
OUTPUT extends 'array'
? RESULT extends Array<infer U>
? AsyncIterableStream<U>
: never
: never

> {
> const {

    model,
    output = 'object',
    system,
    prompt,
    messages,
    maxRetries,
    abortSignal,
    headers,
    experimental_repairText: repairText,
    experimental_telemetry: telemetry,
    experimental_download: download,
    providerOptions,
    onError = ({ error }: { error: unknown }) => {
      console.error(error);
    },
    onFinish,
    _internal: {
      generateId = originalGenerateId,
      currentDate = () => new Date(),
      now = originalNow,
    } = {},
    ...settings

} = options;

const enumValues =
'enum' in options && options.enum ? options.enum : undefined;

const {
schema: inputSchema,
schemaDescription,
schemaName,
} = 'schema' in options ? options : {};

validateObjectGenerationInput({
output,
schema: inputSchema,
schemaName,
schemaDescription,
enumValues,
});

const outputStrategy = getOutputStrategy({
output,
schema: inputSchema,
enumValues,
});

return new DefaultStreamObjectResult({
model,
telemetry,
headers,
settings,
maxRetries,
abortSignal,
outputStrategy,
system,
prompt,
messages,
schemaName,
schemaDescription,
providerOptions,
repairText,
onError,
onFinish,
download,
generateId,
currentDate,
now,
});
}

class DefaultStreamObjectResult<PARTIAL, RESULT, ELEMENT_STREAM>
implements StreamObjectResult<PARTIAL, RESULT, ELEMENT_STREAM>
{
private readonly \_object = new DelayedPromise<RESULT>();
private readonly \_usage = new DelayedPromise<LanguageModelUsage>();
private readonly \_providerMetadata = new DelayedPromise<
ProviderMetadata | undefined

> ();
> private readonly \_warnings = new DelayedPromise<CallWarning[] | undefined>();
> private readonly \_request =

    new DelayedPromise<LanguageModelRequestMetadata>();

private readonly \_response =
new DelayedPromise<LanguageModelResponseMetadata>();
private readonly \_finishReason = new DelayedPromise<FinishReason>();

private readonly baseStream: ReadableStream<ObjectStreamPart<PARTIAL>>;

private readonly outputStrategy: OutputStrategy<
PARTIAL,
RESULT,
ELEMENT_STREAM

> ;

constructor({
model: modelArg,
headers,
telemetry,
settings,
maxRetries: maxRetriesArg,
abortSignal,
outputStrategy,
system,
prompt,
messages,
schemaName,
schemaDescription,
providerOptions,
repairText,
onError,
onFinish,
download,
generateId,
currentDate,
now,
}: {
model: LanguageModel;
telemetry: TelemetrySettings | undefined;
headers: Record<string, string | undefined> | undefined;
settings: Omit<CallSettings, 'abortSignal' | 'headers'>;
maxRetries: number | undefined;
abortSignal: AbortSignal | undefined;
outputStrategy: OutputStrategy<PARTIAL, RESULT, ELEMENT_STREAM>;
system: Prompt['system'];
prompt: Prompt['prompt'];
messages: Prompt['messages'];
schemaName: string | undefined;
schemaDescription: string | undefined;
providerOptions: ProviderOptions | undefined;
repairText: RepairTextFunction | undefined;
onError: StreamObjectOnErrorCallback;
onFinish: StreamObjectOnFinishCallback<RESULT> | undefined;
download: DownloadFunction | undefined;
generateId: () => string;
currentDate: () => Date;
now: () => number;
}) {
const model = resolveLanguageModel(modelArg);

    const { maxRetries, retry } = prepareRetries({
      maxRetries: maxRetriesArg,
      abortSignal,
    });

    const callSettings = prepareCallSettings(settings);

    const baseTelemetryAttributes = getBaseTelemetryAttributes({
      model,
      telemetry,
      headers,
      settings: { ...callSettings, maxRetries },
    });

    const tracer = getTracer(telemetry);
    const self = this;

    const stitchableStream =
      createStitchableStream<ObjectStreamPart<PARTIAL>>();

    const eventProcessor = new TransformStream<
      ObjectStreamPart<PARTIAL>,
      ObjectStreamPart<PARTIAL>
    >({
      transform(chunk, controller) {
        controller.enqueue(chunk);

        if (chunk.type === 'error') {
          onError({ error: wrapGatewayError(chunk.error) });
        }
      },
    });

    this.baseStream = stitchableStream.stream.pipeThrough(eventProcessor);

    recordSpan({
      name: 'ai.streamObject',
      attributes: selectTelemetryAttributes({
        telemetry,
        attributes: {
          ...assembleOperationName({
            operationId: 'ai.streamObject',
            telemetry,
          }),
          ...baseTelemetryAttributes,
          // specific settings that only make sense on the outer level:
          'ai.prompt': {
            input: () => JSON.stringify({ system, prompt, messages }),
          },
          'ai.schema': {
            input: async () =>
              JSON.stringify(await outputStrategy.jsonSchema()),
          },
          'ai.schema.name': schemaName,
          'ai.schema.description': schemaDescription,
          'ai.settings.output': outputStrategy.type,
        },
      }),
      tracer,
      endWhenDone: false,
      fn: async rootSpan => {
        const standardizedPrompt = await standardizePrompt({
          system,
          prompt,
          messages,
        } as Prompt);

        const callOptions = {
          responseFormat: {
            type: 'json' as const,
            schema: await outputStrategy.jsonSchema(),
            name: schemaName,
            description: schemaDescription,
          },
          ...prepareCallSettings(settings),
          prompt: await convertToLanguageModelPrompt({
            prompt: standardizedPrompt,
            supportedUrls: await model.supportedUrls,
            download,
          }),
          providerOptions,
          abortSignal,
          headers,
          includeRawChunks: false,
        };

        const transformer: Transformer<
          LanguageModelV3StreamPart,
          ObjectStreamInputPart
        > = {
          transform: (chunk, controller) => {
            switch (chunk.type) {
              case 'text-delta':
                controller.enqueue(chunk.delta);
                break;
              case 'response-metadata':
              case 'finish':
              case 'error':
              case 'stream-start':
                controller.enqueue(chunk);
                break;
            }
          },
        };

        const {
          result: { stream, response, request },
          doStreamSpan,
          startTimestampMs,
        } = await retry(() =>
          recordSpan({
            name: 'ai.streamObject.doStream',
            attributes: selectTelemetryAttributes({
              telemetry,
              attributes: {
                ...assembleOperationName({
                  operationId: 'ai.streamObject.doStream',
                  telemetry,
                }),
                ...baseTelemetryAttributes,
                'ai.prompt.messages': {
                  input: () => stringifyForTelemetry(callOptions.prompt),
                },

                // standardized gen-ai llm span attributes:
                'gen_ai.system': model.provider,
                'gen_ai.request.model': model.modelId,
                'gen_ai.request.frequency_penalty':
                  callSettings.frequencyPenalty,
                'gen_ai.request.max_tokens': callSettings.maxOutputTokens,
                'gen_ai.request.presence_penalty': callSettings.presencePenalty,
                'gen_ai.request.temperature': callSettings.temperature,
                'gen_ai.request.top_k': callSettings.topK,
                'gen_ai.request.top_p': callSettings.topP,
              },
            }),
            tracer,
            endWhenDone: false,
            fn: async doStreamSpan => ({
              startTimestampMs: now(),
              doStreamSpan,
              result: await model.doStream(callOptions),
            }),
          }),
        );

        self._request.resolve(request ?? {});

        // store information for onFinish callback:
        let warnings: LanguageModelV3CallWarning[] | undefined;
        let usage: LanguageModelUsage = {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        };
        let finishReason: LanguageModelV3FinishReason | undefined;
        let providerMetadata: ProviderMetadata | undefined;
        let object: RESULT | undefined;
        let error: unknown | undefined;

        // pipe chunks through a transformation stream that extracts metadata:
        let accumulatedText = '';
        let textDelta = '';
        let fullResponse: {
          id: string;
          timestamp: Date;
          modelId: string;
        } = {
          id: generateId(),
          timestamp: currentDate(),
          modelId: model.modelId,
        };

        // Keep track of raw parse result before type validation, since e.g. Zod might
        // change the object by mapping properties.
        let latestObjectJson: JSONValue | undefined = undefined;
        let latestObject: PARTIAL | undefined = undefined;
        let isFirstChunk = true;
        let isFirstDelta = true;

        const transformedStream = stream
          .pipeThrough(new TransformStream(transformer))
          .pipeThrough(
            new TransformStream<
              string | ObjectStreamInputPart,
              ObjectStreamPart<PARTIAL>
            >({
              async transform(chunk, controller): Promise<void> {
                if (
                  typeof chunk === 'object' &&
                  chunk.type === 'stream-start'
                ) {
                  warnings = chunk.warnings;
                  return; // stream start chunks are sent immediately and do not count as first chunk
                }

                // Telemetry event for first chunk:
                if (isFirstChunk) {
                  const msToFirstChunk = now() - startTimestampMs;

                  isFirstChunk = false;

                  doStreamSpan.addEvent('ai.stream.firstChunk', {
                    'ai.stream.msToFirstChunk': msToFirstChunk,
                  });

                  doStreamSpan.setAttributes({
                    'ai.stream.msToFirstChunk': msToFirstChunk,
                  });
                }

                // process partial text chunks
                if (typeof chunk === 'string') {
                  accumulatedText += chunk;
                  textDelta += chunk;

                  const { value: currentObjectJson, state: parseState } =
                    await parsePartialJson(accumulatedText);

                  if (
                    currentObjectJson !== undefined &&
                    !isDeepEqualData(latestObjectJson, currentObjectJson)
                  ) {
                    const validationResult =
                      await outputStrategy.validatePartialResult({
                        value: currentObjectJson,
                        textDelta,
                        latestObject,
                        isFirstDelta,
                        isFinalDelta: parseState === 'successful-parse',
                      });

                    if (
                      validationResult.success &&
                      !isDeepEqualData(
                        latestObject,
                        validationResult.value.partial,
                      )
                    ) {
                      // inside inner check to correctly parse the final element in array mode:
                      latestObjectJson = currentObjectJson;
                      latestObject = validationResult.value.partial;

                      controller.enqueue({
                        type: 'object',
                        object: latestObject,
                      });

                      controller.enqueue({
                        type: 'text-delta',
                        textDelta: validationResult.value.textDelta,
                      });

                      textDelta = '';
                      isFirstDelta = false;
                    }
                  }

                  return;
                }

                switch (chunk.type) {
                  case 'response-metadata': {
                    fullResponse = {
                      id: chunk.id ?? fullResponse.id,
                      timestamp: chunk.timestamp ?? fullResponse.timestamp,
                      modelId: chunk.modelId ?? fullResponse.modelId,
                    };
                    break;
                  }

                  case 'finish': {
                    // send final text delta:
                    if (textDelta !== '') {
                      controller.enqueue({ type: 'text-delta', textDelta });
                    }

                    // store finish reason for telemetry:
                    finishReason = chunk.finishReason;

                    // store usage and metadata for promises and onFinish callback:
                    usage = chunk.usage;
                    providerMetadata = chunk.providerMetadata;

                    controller.enqueue({
                      ...chunk,
                      usage,
                      response: fullResponse,
                    });

                    // log warnings:
                    logWarnings({
                      warnings: warnings ?? [],
                      provider: model.provider,
                      model: model.modelId,
                    });

                    // resolve promises that can be resolved now:
                    self._usage.resolve(usage);
                    self._providerMetadata.resolve(providerMetadata);
                    self._warnings.resolve(warnings);
                    self._response.resolve({
                      ...fullResponse,
                      headers: response?.headers,
                    });
                    self._finishReason.resolve(finishReason ?? 'unknown');

                    try {
                      object = await parseAndValidateObjectResultWithRepair(
                        accumulatedText,
                        outputStrategy,
                        repairText,
                        {
                          response: fullResponse,
                          usage,
                          finishReason,
                        },
                      );
                      self._object.resolve(object);
                    } catch (e) {
                      error = e;
                      self._object.reject(e);
                    }
                    break;
                  }

                  default: {
                    controller.enqueue(chunk);
                    break;
                  }
                }
              },

              // invoke onFinish callback and resolve toolResults promise when the stream is about to close:
              async flush(controller) {
                try {
                  const finalUsage = usage ?? {
                    promptTokens: NaN,
                    completionTokens: NaN,
                    totalTokens: NaN,
                  };

                  doStreamSpan.setAttributes(
                    await selectTelemetryAttributes({
                      telemetry,
                      attributes: {
                        'ai.response.finishReason': finishReason,
                        'ai.response.object': {
                          output: () => JSON.stringify(object),
                        },
                        'ai.response.id': fullResponse.id,
                        'ai.response.model': fullResponse.modelId,
                        'ai.response.timestamp':
                          fullResponse.timestamp.toISOString(),
                        'ai.response.providerMetadata':
                          JSON.stringify(providerMetadata),

                        'ai.usage.inputTokens': finalUsage.inputTokens,
                        'ai.usage.outputTokens': finalUsage.outputTokens,
                        'ai.usage.totalTokens': finalUsage.totalTokens,
                        'ai.usage.reasoningTokens': finalUsage.reasoningTokens,
                        'ai.usage.cachedInputTokens':
                          finalUsage.cachedInputTokens,

                        // standardized gen-ai llm span attributes:
                        'gen_ai.response.finish_reasons': [finishReason],
                        'gen_ai.response.id': fullResponse.id,
                        'gen_ai.response.model': fullResponse.modelId,
                        'gen_ai.usage.input_tokens': finalUsage.inputTokens,
                        'gen_ai.usage.output_tokens': finalUsage.outputTokens,
                      },
                    }),
                  );

                  // finish doStreamSpan before other operations for correct timing:
                  doStreamSpan.end();

                  // Add response information to the root span:
                  rootSpan.setAttributes(
                    await selectTelemetryAttributes({
                      telemetry,
                      attributes: {
                        'ai.usage.inputTokens': finalUsage.inputTokens,
                        'ai.usage.outputTokens': finalUsage.outputTokens,
                        'ai.usage.totalTokens': finalUsage.totalTokens,
                        'ai.usage.reasoningTokens': finalUsage.reasoningTokens,
                        'ai.usage.cachedInputTokens':
                          finalUsage.cachedInputTokens,
                        'ai.response.object': {
                          output: () => JSON.stringify(object),
                        },
                        'ai.response.providerMetadata':
                          JSON.stringify(providerMetadata),
                      },
                    }),
                  );

                  // call onFinish callback:
                  await onFinish?.({
                    usage: finalUsage,
                    object,
                    error,
                    response: {
                      ...fullResponse,
                      headers: response?.headers,
                    },
                    warnings,
                    providerMetadata,
                  });
                } catch (error) {
                  controller.enqueue({ type: 'error', error });
                } finally {
                  rootSpan.end();
                }
              },
            }),
          );

        stitchableStream.addStream(transformedStream);
      },
    })
      .catch(error => {
        // add an empty stream with an error to break the stream:
        stitchableStream.addStream(
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'error', error });
              controller.close();
            },
          }),
        );
      })
      .finally(() => {
        stitchableStream.close();
      });

    this.outputStrategy = outputStrategy;

}

get object() {
return this.\_object.promise;
}

get usage() {
return this.\_usage.promise;
}

get providerMetadata() {
return this.\_providerMetadata.promise;
}

get warnings() {
return this.\_warnings.promise;
}

get request() {
return this.\_request.promise;
}

get response() {
return this.\_response.promise;
}

get finishReason() {
return this.\_finishReason.promise;
}

get partialObjectStream(): AsyncIterableStream<PARTIAL> {
return createAsyncIterableStream(
this.baseStream.pipeThrough(
new TransformStream<ObjectStreamPart<PARTIAL>, PARTIAL>({
transform(chunk, controller) {
switch (chunk.type) {
case 'object':
controller.enqueue(chunk.object);
break;

              case 'text-delta':
              case 'finish':
              case 'error': // suppress error (use onError instead)
                break;

              default: {
                const _exhaustiveCheck: never = chunk;
                throw new Error(`Unsupported chunk type: ${_exhaustiveCheck}`);
              }
            }
          },
        }),
      ),
    );

}

get elementStream(): ELEMENT_STREAM {
return this.outputStrategy.createElementStream(this.baseStream);
}

get textStream(): AsyncIterableStream<string> {
return createAsyncIterableStream(
this.baseStream.pipeThrough(
new TransformStream<ObjectStreamPart<PARTIAL>, string>({
transform(chunk, controller) {
switch (chunk.type) {
case 'text-delta':
controller.enqueue(chunk.textDelta);
break;

              case 'object':
              case 'finish':
              case 'error': // suppress error (use onError instead)
                break;

              default: {
                const _exhaustiveCheck: never = chunk;
                throw new Error(`Unsupported chunk type: ${_exhaustiveCheck}`);
              }
            }
          },
        }),
      ),
    );

}

get fullStream(): AsyncIterableStream<ObjectStreamPart<PARTIAL>> {
return createAsyncIterableStream(this.baseStream);
}

pipeTextStreamToResponse(response: ServerResponse, init?: ResponseInit) {
pipeTextStreamToResponse({
response,
textStream: this.textStream,
...init,
});
}

toTextStreamResponse(init?: ResponseInit): Response {
return createTextStreamResponse({
textStream: this.textStream,
...init,
});
}
}

export type ObjectStreamInputPart =
| string
| {
type: 'stream-start';
warnings: LanguageModelV3CallWarning[];
}
| {
type: 'error';
error: unknown;
}
| {
type: 'response-metadata';
id?: string;
timestamp?: Date;
modelId?: string;
}
| {
type: 'finish';
finishReason: LanguageModelV3FinishReason;
usage: LanguageModelV3Usage;
providerMetadata?: SharedV3ProviderMetadata;
};

================================================
FILE: packages/ai/src/generate-object/validate-object-generation-input.ts
================================================
import { FlexibleSchema } from '@ai-sdk/provider-utils';
import { InvalidArgumentError } from '../error/invalid-argument-error';

export function validateObjectGenerationInput({
output,
schema,
schemaName,
schemaDescription,
enumValues,
}: {
output?: 'object' | 'array' | 'enum' | 'no-schema';
schema?: FlexibleSchema<unknown>;
schemaName?: string;
schemaDescription?: string;
enumValues?: Array<unknown>;
}) {
if (
output != null &&
output !== 'object' &&
output !== 'array' &&
output !== 'enum' &&
output !== 'no-schema'
) {
throw new InvalidArgumentError({
parameter: 'output',
value: output,
message: 'Invalid output type.',
});
}

if (output === 'no-schema') {
if (schema != null) {
throw new InvalidArgumentError({
parameter: 'schema',
value: schema,
message: 'Schema is not supported for no-schema output.',
});
}

    if (schemaDescription != null) {
      throw new InvalidArgumentError({
        parameter: 'schemaDescription',
        value: schemaDescription,
        message: 'Schema description is not supported for no-schema output.',
      });
    }

    if (schemaName != null) {
      throw new InvalidArgumentError({
        parameter: 'schemaName',
        value: schemaName,
        message: 'Schema name is not supported for no-schema output.',
      });
    }

    if (enumValues != null) {
      throw new InvalidArgumentError({
        parameter: 'enumValues',
        value: enumValues,
        message: 'Enum values are not supported for no-schema output.',
      });
    }

}

if (output === 'object') {
if (schema == null) {
throw new InvalidArgumentError({
parameter: 'schema',
value: schema,
message: 'Schema is required for object output.',
});
}

    if (enumValues != null) {
      throw new InvalidArgumentError({
        parameter: 'enumValues',
        value: enumValues,
        message: 'Enum values are not supported for object output.',
      });
    }

}

if (output === 'array') {
if (schema == null) {
throw new InvalidArgumentError({
parameter: 'schema',
value: schema,
message: 'Element schema is required for array output.',
});
}

    if (enumValues != null) {
      throw new InvalidArgumentError({
        parameter: 'enumValues',
        value: enumValues,
        message: 'Enum values are not supported for array output.',
      });
    }

}

if (output === 'enum') {
if (schema != null) {
throw new InvalidArgumentError({
parameter: 'schema',
value: schema,
message: 'Schema is not supported for enum output.',
});
}

    if (schemaDescription != null) {
      throw new InvalidArgumentError({
        parameter: 'schemaDescription',
        value: schemaDescription,
        message: 'Schema description is not supported for enum output.',
      });
    }

    if (schemaName != null) {
      throw new InvalidArgumentError({
        parameter: 'schemaName',
        value: schemaName,
        message: 'Schema name is not supported for enum output.',
      });
    }

    if (enumValues == null) {
      throw new InvalidArgumentError({
        parameter: 'enumValues',
        value: enumValues,
        message: 'Enum values are required for enum output.',
      });
    }

    for (const value of enumValues) {
      if (typeof value !== 'string') {
        throw new InvalidArgumentError({
          parameter: 'enumValues',
          value,
          message: 'Enum values must be strings.',
        });
      }
    }

}
}

================================================
FILE: packages/ai/src/generate-object/**snapshots**/generate-object.test.ts.snap
================================================
// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html

exports[`generateObject > telemetry > should not record telemetry inputs / outputs when disabled 1`] = `[
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.generateObject",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.response.finishReason": "stop",
      "ai.settings.maxRetries": 2,
      "ai.settings.output": "object",
      "ai.usage.completionTokens": 20,
      "ai.usage.promptTokens": 10,
      "operation.name": "ai.generateObject",
    },
    "events": [],
    "name": "ai.generateObject",
  },
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.generateObject.doGenerate",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.response.finishReason": "stop",
      "ai.response.id": "test-id-from-model",
      "ai.response.model": "test-response-model-id",
      "ai.response.timestamp": "1970-01-01T00:00:10.000Z",
      "ai.settings.maxRetries": 2,
      "ai.usage.completionTokens": 20,
      "ai.usage.promptTokens": 10,
      "gen_ai.request.model": "mock-model-id",
      "gen_ai.response.finish_reasons": [
        "stop",
      ],
      "gen_ai.response.id": "test-id-from-model",
      "gen_ai.response.model": "test-response-model-id",
      "gen_ai.system": "mock-provider",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 20,
      "operation.name": "ai.generateObject.doGenerate",
    },
    "events": [],
    "name": "ai.generateObject.doGenerate",
  },
]`;

exports[`generateObject > telemetry > should record telemetry data when enabled 1`] = `[
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.generateObject",
      "ai.prompt": "{"prompt":"prompt"}",
      "ai.request.headers.header1": "value1",
      "ai.request.headers.header2": "value2",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.response.finishReason": "stop",
      "ai.response.object": "{"content":"Hello, world!"}",
      "ai.response.providerMetadata": "{"testProvider":{"testKey":"testValue"}}",
      "ai.schema": "{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"content":{"type":"string"}},"required":["content"],"additionalProperties":false}",
      "ai.schema.description": "test description",
      "ai.schema.name": "test-name",
      "ai.settings.frequencyPenalty": 0.3,
      "ai.settings.maxRetries": 2,
      "ai.settings.output": "object",
      "ai.settings.presencePenalty": 0.4,
      "ai.settings.temperature": 0.5,
      "ai.settings.topK": 0.1,
      "ai.settings.topP": 0.2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.completionTokens": 20,
      "ai.usage.promptTokens": 10,
      "operation.name": "ai.generateObject test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.generateObject",
  },
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.generateObject.doGenerate",
      "ai.prompt.messages": "[{"role":"user","content":[{"type":"text","text":"prompt"}]}]",
      "ai.request.headers.header1": "value1",
      "ai.request.headers.header2": "value2",
      "ai.request.headers.user-agent": "ai/0.0.0-test",
      "ai.response.finishReason": "stop",
      "ai.response.id": "test-id-from-model",
      "ai.response.model": "test-response-model-id",
      "ai.response.object": "{ "content": "Hello, world!" }",
      "ai.response.providerMetadata": "{"testProvider":{"testKey":"testValue"}}",
      "ai.response.timestamp": "1970-01-01T00:00:10.000Z",
      "ai.settings.frequencyPenalty": 0.3,
      "ai.settings.maxRetries": 2,
      "ai.settings.presencePenalty": 0.4,
      "ai.settings.temperature": 0.5,
      "ai.settings.topK": 0.1,
      "ai.settings.topP": 0.2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.completionTokens": 20,
      "ai.usage.promptTokens": 10,
      "gen_ai.request.frequency_penalty": 0.3,
      "gen_ai.request.model": "mock-model-id",
      "gen_ai.request.presence_penalty": 0.4,
      "gen_ai.request.temperature": 0.5,
      "gen_ai.request.top_k": 0.1,
      "gen_ai.request.top_p": 0.2,
      "gen_ai.response.finish_reasons": [
        "stop",
      ],
      "gen_ai.response.id": "test-id-from-model",
      "gen_ai.response.model": "test-response-model-id",
      "gen_ai.system": "mock-provider",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 20,
      "operation.name": "ai.generateObject.doGenerate test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.generateObject.doGenerate",
  },
]`;

================================================
FILE: packages/ai/src/generate-object/**snapshots**/stream-object.test.ts.snap
================================================
// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html

exports[`streamObject > output = "object" > options.onFinish > should be called when a valid object is generated 1`] = `{
  "error": undefined,
  "object": {
    "content": "Hello, world!",
  },
  "providerMetadata": {
    "testProvider": {
      "testKey": "testValue",
    },
  },
  "response": {
    "headers": undefined,
    "id": "id-0",
    "modelId": "mock-model-id",
    "timestamp": 1970-01-01T00:00:00.000Z,
  },
  "usage": {
    "cachedInputTokens": undefined,
    "inputTokens": 3,
    "outputTokens": 10,
    "reasoningTokens": undefined,
    "totalTokens": 13,
  },
  "warnings": undefined,
}`;

exports[`streamObject > output = "object" > options.onFinish > should be called when object doesn't match the schema 1`] = `{
  "error": [AI_NoObjectGeneratedError: No object generated: response did not match schema.],
  "object": undefined,
  "providerMetadata": undefined,
  "response": {
    "headers": undefined,
    "id": "id-0",
    "modelId": "mock-model-id",
    "timestamp": 1970-01-01T00:00:00.000Z,
  },
  "usage": {
    "cachedInputTokens": undefined,
    "inputTokens": 3,
    "outputTokens": 10,
    "reasoningTokens": undefined,
    "totalTokens": 13,
  },
  "warnings": undefined,
}`;

exports[`streamObject > output = "object" > result.fullStream > should send full stream data 1`] = `[
  {
    "object": {},
    "type": "object",
  },
  {
    "textDelta": "{ ",
    "type": "text-delta",
  },
  {
    "object": {
      "content": "Hello, ",
    },
    "type": "object",
  },
  {
    "textDelta": ""content": "Hello, ",
    "type": "text-delta",
  },
  {
    "object": {
      "content": "Hello, world",
    },
    "type": "object",
  },
  {
    "textDelta": "world",
    "type": "text-delta",
  },
  {
    "object": {
      "content": "Hello, world!",
    },
    "type": "object",
  },
  {
    "textDelta": "!"",
    "type": "text-delta",
  },
  {
    "textDelta": " }",
    "type": "text-delta",
  },
  {
    "finishReason": "stop",
    "providerMetadata": {
      "testProvider": {
        "testKey": "testValue",
      },
    },
    "response": {
      "id": "id-0",
      "modelId": "mock-model-id",
      "timestamp": 1970-01-01T00:00:00.000Z,
    },
    "type": "finish",
    "usage": {
      "cachedInputTokens": undefined,
      "inputTokens": 3,
      "outputTokens": 10,
      "reasoningTokens": undefined,
      "totalTokens": 13,
    },
  },
]`;

exports[`streamObject > telemetry > should not record any telemetry data when not explicitly enabled 1`] = `[]`;

exports[`streamObject > telemetry > should not record telemetry inputs / outputs when disabled 1`] = `[
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.streamObject",
      "ai.settings.maxRetries": 2,
      "ai.settings.output": "object",
      "ai.usage.inputTokens": 3,
      "ai.usage.outputTokens": 10,
      "ai.usage.totalTokens": 13,
      "operation.name": "ai.streamObject",
    },
    "events": [],
    "name": "ai.streamObject",
  },
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.streamObject.doStream",
      "ai.response.finishReason": "stop",
      "ai.response.id": "id-0",
      "ai.response.model": "mock-model-id",
      "ai.response.timestamp": "1970-01-01T00:00:00.000Z",
      "ai.settings.maxRetries": 2,
      "ai.stream.msToFirstChunk": 0,
      "ai.usage.inputTokens": 3,
      "ai.usage.outputTokens": 10,
      "ai.usage.totalTokens": 13,
      "gen_ai.request.model": "mock-model-id",
      "gen_ai.response.finish_reasons": [
        "stop",
      ],
      "gen_ai.response.id": "id-0",
      "gen_ai.response.model": "mock-model-id",
      "gen_ai.system": "mock-provider",
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 10,
      "operation.name": "ai.streamObject.doStream",
    },
    "events": [
      {
        "attributes": {
          "ai.stream.msToFirstChunk": 0,
        },
        "name": "ai.stream.firstChunk",
      },
    ],
    "name": "ai.streamObject.doStream",
  },
]`;

exports[`streamObject > telemetry > should record telemetry data when enabled 1`] = `[
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.streamObject",
      "ai.prompt": "{"prompt":"prompt"}",
      "ai.request.headers.header1": "value1",
      "ai.request.headers.header2": "value2",
      "ai.response.object": "{"content":"Hello, world!"}",
      "ai.response.providerMetadata": "{"testProvider":{"testKey":"testValue"}}",
      "ai.schema": "{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"content":{"type":"string"}},"required":["content"],"additionalProperties":false}",
      "ai.schema.description": "test description",
      "ai.schema.name": "test-name",
      "ai.settings.frequencyPenalty": 0.3,
      "ai.settings.maxRetries": 2,
      "ai.settings.output": "object",
      "ai.settings.presencePenalty": 0.4,
      "ai.settings.temperature": 0.5,
      "ai.settings.topK": 0.1,
      "ai.settings.topP": 0.2,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.inputTokens": 3,
      "ai.usage.outputTokens": 10,
      "ai.usage.totalTokens": 13,
      "operation.name": "ai.streamObject test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [],
    "name": "ai.streamObject",
  },
  {
    "attributes": {
      "ai.model.id": "mock-model-id",
      "ai.model.provider": "mock-provider",
      "ai.operationId": "ai.streamObject.doStream",
      "ai.prompt.messages": "[{"role":"user","content":[{"type":"text","text":"prompt"}]}]",
      "ai.request.headers.header1": "value1",
      "ai.request.headers.header2": "value2",
      "ai.response.finishReason": "stop",
      "ai.response.id": "id-0",
      "ai.response.model": "mock-model-id",
      "ai.response.object": "{"content":"Hello, world!"}",
      "ai.response.providerMetadata": "{"testProvider":{"testKey":"testValue"}}",
      "ai.response.timestamp": "1970-01-01T00:00:00.000Z",
      "ai.settings.frequencyPenalty": 0.3,
      "ai.settings.maxRetries": 2,
      "ai.settings.presencePenalty": 0.4,
      "ai.settings.temperature": 0.5,
      "ai.settings.topK": 0.1,
      "ai.settings.topP": 0.2,
      "ai.stream.msToFirstChunk": 0,
      "ai.telemetry.functionId": "test-function-id",
      "ai.telemetry.metadata.test1": "value1",
      "ai.telemetry.metadata.test2": false,
      "ai.usage.inputTokens": 3,
      "ai.usage.outputTokens": 10,
      "ai.usage.totalTokens": 13,
      "gen_ai.request.frequency_penalty": 0.3,
      "gen_ai.request.model": "mock-model-id",
      "gen_ai.request.presence_penalty": 0.4,
      "gen_ai.request.temperature": 0.5,
      "gen_ai.request.top_k": 0.1,
      "gen_ai.request.top_p": 0.2,
      "gen_ai.response.finish_reasons": [
        "stop",
      ],
      "gen_ai.response.id": "id-0",
      "gen_ai.response.model": "mock-model-id",
      "gen_ai.system": "mock-provider",
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 10,
      "operation.name": "ai.streamObject.doStream test-function-id",
      "resource.name": "test-function-id",
    },
    "events": [
      {
        "attributes": {
          "ai.stream.msToFirstChunk": 0,
        },
        "name": "ai.stream.firstChunk",
      },
    ],
    "name": "ai.streamObject.doStream",
  },
]`;

================================================
FILE: packages/ai/src/generate-speech/generate-speech-result.ts
================================================
import { JSONObject } from '@ai-sdk/provider';
import { SpeechModelResponseMetadata } from '../types/speech-model-response-metadata';
import { SpeechWarning } from '../types';
import { GeneratedAudioFile } from './generated-audio-file';

/**
The result of a `generateSpeech` call.
It contains the audio data and additional information.
\*/
export interface SpeechResult {
/**

- The audio data as a base64 encoded string or binary data.
  \*/
  readonly audio: GeneratedAudioFile;

/\*_
Warnings for the call, e.g. unsupported settings.
_/
readonly warnings: Array<SpeechWarning>;

/\*_
Response metadata from the provider. There may be multiple responses if we made multiple calls to the model.
_/
readonly responses: Array<SpeechModelResponseMetadata>;

/\*_
Provider metadata from the provider.
_/
readonly providerMetadata: Record<string, JSONObject>;
}

================================================
FILE: packages/ai/src/generate-speech/generate-speech.test.ts
================================================
import {
JSONObject,
SpeechModelV3,
SpeechModelV3CallWarning,
} from '@ai-sdk/provider';
import {
afterEach,
beforeEach,
describe,
expect,
it,
vitest,
vi,
} from 'vitest';
import \* as logWarningsModule from '../logger/log-warnings';
import { MockSpeechModelV3 } from '../test/mock-speech-model-v3';
import { generateSpeech } from './generate-speech';
import {
DefaultGeneratedAudioFile,
GeneratedAudioFile,
} from './generated-audio-file';

const audio = new Uint8Array([1, 2, 3, 4]); // Sample audio data
const testDate = new Date(2024, 0, 1);
const mockFile = new DefaultGeneratedAudioFile({
data: audio,
mediaType: 'audio/mp3',
});

const sampleText = 'This is a sample text to convert to speech.';

vi.mock('../version', () => {
return {
VERSION: '0.0.0-test',
};
});

const createMockResponse = (options: {
audio: GeneratedAudioFile;
warnings?: SpeechModelV3CallWarning[];
timestamp?: Date;
modelId?: string;
headers?: Record<string, string>;
providerMetadata?: Record<string, JSONObject>;
}) => ({
audio: options.audio.uint8Array,
warnings: options.warnings ?? [],
response: {
timestamp: options.timestamp ?? new Date(),
modelId: options.modelId ?? 'test-model-id',
headers: options.headers ?? {},
},
providerMetadata: options.providerMetadata ?? {},
});

describe('generateSpeech', () => {
let logWarningsSpy: ReturnType<typeof vitest.spyOn>;

beforeEach(() => {
logWarningsSpy = vitest
.spyOn(logWarningsModule, 'logWarnings')
.mockImplementation(() => {});
});

afterEach(() => {
logWarningsSpy.mockRestore();
});

it('should send args to doGenerate', async () => {
const abortController = new AbortController();
const abortSignal = abortController.signal;

    let capturedArgs!: Parameters<SpeechModelV3['doGenerate']>[0];

    await generateSpeech({
      model: new MockSpeechModelV3({
        doGenerate: async args => {
          capturedArgs = args;
          return createMockResponse({
            audio: mockFile,
          });
        },
      }),
      text: sampleText,
      voice: 'test-voice',
      headers: {
        'custom-request-header': 'request-header-value',
      },
      abortSignal,
    });

    expect(capturedArgs).toStrictEqual({
      text: sampleText,
      voice: 'test-voice',
      headers: {
        'custom-request-header': 'request-header-value',
        'user-agent': 'ai/0.0.0-test',
      },
      abortSignal,
      providerOptions: {},
      outputFormat: undefined,
      instructions: undefined,
      speed: undefined,
      language: undefined,
    });

});

it('should return warnings', async () => {
const result = await generateSpeech({
model: new MockSpeechModelV3({
doGenerate: async () =>
createMockResponse({
audio: mockFile,
warnings: [
{
type: 'other',
message: 'Setting is not supported',
},
],
providerMetadata: {
'test-provider': {
'test-key': 'test-value',
},
},
}),
}),
text: sampleText,
});

    expect(result.warnings).toStrictEqual([
      {
        type: 'other',
        message: 'Setting is not supported',
      },
    ]);

});

it('should call logWarnings with the correct warnings', async () => {
const expectedWarnings: SpeechModelV3CallWarning[] = [
{
type: 'other',
message: 'Setting is not supported',
},
{
type: 'unsupported-setting',
setting: 'voice',
details: 'Voice parameter not supported',
},
];

    await generateSpeech({
      model: new MockSpeechModelV3({
        doGenerate: async () =>
          createMockResponse({
            audio: mockFile,
            warnings: expectedWarnings,
          }),
      }),
      text: sampleText,
    });

    expect(logWarningsSpy).toHaveBeenCalledOnce();
    expect(logWarningsSpy).toHaveBeenCalledWith({
      warnings: expectedWarnings,
      provider: 'mock-provider',
      model: 'mock-model-id',
    });

});

it('should call logWarnings with empty array when no warnings are present', async () => {
await generateSpeech({
model: new MockSpeechModelV3({
doGenerate: async () =>
createMockResponse({
audio: mockFile,
warnings: [], // no warnings
}),
}),
text: sampleText,
});

    expect(logWarningsSpy).toHaveBeenCalledOnce();
    expect(logWarningsSpy).toHaveBeenCalledWith({
      warnings: [],
      provider: 'mock-provider',
      model: 'mock-model-id',
    });

});

it('should return the audio data', async () => {
const result = await generateSpeech({
model: new MockSpeechModelV3({
doGenerate: async () =>
createMockResponse({
audio: mockFile,
}),
}),
text: sampleText,
});

    expect(result).toEqual({
      audio: mockFile,
      warnings: [],
      responses: [
        {
          timestamp: expect.any(Date),
          modelId: 'test-model-id',
          headers: {},
        },
      ],
      providerMetadata: {},
    });

});

describe('error handling', () => {
it('should throw NoSpeechGeneratedError when no audio is returned', async () => {
await expect(
generateSpeech({
model: new MockSpeechModelV3({
doGenerate: async () =>
createMockResponse({
audio: new DefaultGeneratedAudioFile({
data: new Uint8Array(),
mediaType: 'audio/mp3',
}),
timestamp: testDate,
}),
}),
text: sampleText,
}),
).rejects.toMatchObject({
name: 'AI_NoSpeechGeneratedError',
message: 'No speech audio generated.',
responses: [
{
timestamp: testDate,
modelId: expect.any(String),
},
],
});
});

    it('should include response headers in error when no audio generated', async () => {
      await expect(
        generateSpeech({
          model: new MockSpeechModelV3({
            doGenerate: async () =>
              createMockResponse({
                audio: new DefaultGeneratedAudioFile({
                  data: new Uint8Array(),
                  mediaType: 'audio/mp3',
                }),
                timestamp: testDate,
                headers: {
                  'custom-response-header': 'response-header-value',
                  'user-agent': 'ai/0.0.0-test',
                },
              }),
          }),
          text: sampleText,
        }),
      ).rejects.toMatchObject({
        name: 'AI_NoSpeechGeneratedError',
        message: 'No speech audio generated.',
        responses: [
          {
            timestamp: testDate,
            modelId: expect.any(String),
            headers: {
              'custom-response-header': 'response-header-value',
              'user-agent': 'ai/0.0.0-test',
            },
          },
        ],
      });
    });

});

it('should return response metadata', async () => {
const testHeaders = { 'x-test': 'value' };

    const result = await generateSpeech({
      model: new MockSpeechModelV3({
        doGenerate: async () =>
          createMockResponse({
            audio: mockFile,
            timestamp: testDate,
            modelId: 'test-model',
            headers: testHeaders,
          }),
      }),
      text: sampleText,
    });

    expect(result.responses).toStrictEqual([
      {
        timestamp: testDate,
        modelId: 'test-model',
        headers: testHeaders,
      },
    ]);

});
});

================================================
FILE: packages/ai/src/generate-speech/generate-speech.ts
================================================
import { JSONObject } from '@ai-sdk/provider';
import { ProviderOptions, withUserAgentSuffix } from '@ai-sdk/provider-utils';
import { NoSpeechGeneratedError } from '../error/no-speech-generated-error';
import { logWarnings } from '../logger/log-warnings';
import { SpeechWarning, SpeechModel } from '../types/speech-model';
import { SpeechModelResponseMetadata } from '../types/speech-model-response-metadata';
import {
audioMediaTypeSignatures,
detectMediaType,
} from '../util/detect-media-type';
import { prepareRetries } from '../util/prepare-retries';
import { SpeechResult } from './generate-speech-result';
import {
DefaultGeneratedAudioFile,
GeneratedAudioFile,
} from './generated-audio-file';
import { VERSION } from '../version';
import { resolveSpeechModel } from '../model/resolve-model';
/\*\*
Generates speech audio using a speech model.

@param model - The speech model to use.
@param text - The text to convert to speech.
@param voice - The voice to use for speech generation.
@param outputFormat - The output format to use for speech generation e.g. "mp3", "wav", etc.
@param instructions - Instructions for the speech generation e.g. "Speak in a slow and steady tone".
@param speed - The speed of the speech generation.
@param providerOptions - Additional provider-specific options that are passed through to the provider
as body parameters.
@param maxRetries - Maximum number of retries. Set to 0 to disable retries. Default: 2.
@param abortSignal - An optional abort signal that can be used to cancel the call.
@param headers - Additional HTTP headers to be sent with the request. Only applicable for HTTP-based providers.

@returns A result object that contains the generated audio data.
_/
export async function generateSpeech({
model,
text,
voice,
outputFormat,
instructions,
speed,
language,
providerOptions = {},
maxRetries: maxRetriesArg,
abortSignal,
headers,
}: {
/\*\*
The speech model to use.
_/
model: SpeechModel;

/\*_
The text to convert to speech.
_/
text: string;

/\*_
The voice to use for speech generation.
_/
voice?: string;

/\*\*

- The desired output format for the audio e.g. "mp3", "wav", etc.
  \*/
  outputFormat?: 'mp3' | 'wav' | (string & {});

/\*_
Instructions for the speech generation e.g. "Speak in a slow and steady tone".
_/
instructions?: string;

/\*_
The speed of the speech generation.
_/
speed?: number;

/\*_
The language for speech generation. This should be an ISO 639-1 language code (e.g. "en", "es", "fr")
or "auto" for automatic language detection. Provider support varies.
_/
language?: string;

/\*\*
Additional provider-specific options that are passed through to the provider
as body parameters.

The outer record is keyed by the provider name, and the inner
record is keyed by the provider-specific metadata key.

```ts
{
  "openai": {}
}
```

     */

providerOptions?: ProviderOptions;

/\*\*
Maximum number of retries per speech model call. Set to 0 to disable retries.

@default 2
\*/
maxRetries?: number;

/\*_
Abort signal.
_/
abortSignal?: AbortSignal;

/\*_
Additional headers to include in the request.
Only applicable for HTTP-based providers.
_/
headers?: Record<string, string>;
}): Promise<SpeechResult> {
const resolvedModel = resolveSpeechModel(model);
if (!resolvedModel) {
throw new Error('Model could not be resolved');
}

const headersWithUserAgent = withUserAgentSuffix(
headers ?? {},
`ai/${VERSION}`,
);

const { retry } = prepareRetries({
maxRetries: maxRetriesArg,
abortSignal,
});

const result = await retry(() =>
resolvedModel.doGenerate({
text,
voice,
outputFormat,
instructions,
speed,
language,
abortSignal,
headers: headersWithUserAgent,
providerOptions,
}),
);

if (!result.audio || result.audio.length === 0) {
throw new NoSpeechGeneratedError({ responses: [result.response] });
}

logWarnings({
warnings: result.warnings,
provider: resolvedModel.provider,
model: resolvedModel.modelId,
});

return new DefaultSpeechResult({
audio: new DefaultGeneratedAudioFile({
data: result.audio,
mediaType:
detectMediaType({
data: result.audio,
signatures: audioMediaTypeSignatures,
}) ?? 'audio/mp3',
}),
warnings: result.warnings,
responses: [result.response],
providerMetadata: result.providerMetadata,
});
}

class DefaultSpeechResult implements SpeechResult {
readonly audio: GeneratedAudioFile;
readonly warnings: Array<SpeechWarning>;
readonly responses: Array<SpeechModelResponseMetadata>;
readonly providerMetadata: Record<string, JSONObject>;

constructor(options: {
audio: GeneratedAudioFile;
warnings: Array<SpeechWarning>;
responses: Array<SpeechModelResponseMetadata>;
providerMetadata: Record<string, JSONObject> | undefined;
}) {
this.audio = options.audio;
this.warnings = options.warnings;
this.responses = options.responses;
this.providerMetadata = options.providerMetadata ?? {};
}
}

================================================
FILE: packages/ai/src/generate-speech/generated-audio-file.ts
================================================
import {
GeneratedFile,
DefaultGeneratedFile,
} from '../generate-text/generated-file';

/\*\*

- A generated audio file.
  \*/
  export interface GeneratedAudioFile extends GeneratedFile {
  /\*\*
  - Audio format of the file (e.g., 'mp3', 'wav', etc.)
    \*/
    readonly format: string;
    }

export class DefaultGeneratedAudioFile
extends DefaultGeneratedFile
implements GeneratedAudioFile
{
readonly format: string;

constructor({
data,
mediaType,
}: {
data: string | Uint8Array;
mediaType: string;
}) {
super({ data, mediaType });
let format = 'mp3';

    // If format is not provided, try to determine it from the media type
    if (mediaType) {
      const mediaTypeParts = mediaType.split('/');

      if (mediaTypeParts.length === 2) {
        // Handle special cases for audio formats
        if (mediaType !== 'audio/mpeg') {
          format = mediaTypeParts[1];
        }
      }
    }

    if (!format) {
      // TODO this should be an AI SDK error
      throw new Error(
        'Audio format must be provided or determinable from media type',
      );
    }

    this.format = format;

}
}

export class DefaultGeneratedAudioFileWithType extends DefaultGeneratedAudioFile {
readonly type = 'audio';

constructor(options: {
data: string | Uint8Array;
mediaType: string;
format: string;
}) {
super(options);
}
}

================================================
FILE: packages/ai/src/generate-speech/index.ts
================================================
export { generateSpeech as experimental_generateSpeech } from './generate-speech';
export type { SpeechResult as Experimental_SpeechResult } from './generate-speech-result';
export type { GeneratedAudioFile } from './generated-audio-file';

================================================
FILE: packages/ai/src/generate-text/collect-tool-approvals.test.ts
================================================
import { describe, expect, it } from 'vitest';
import { collectToolApprovals } from './collect-tool-approvals';

describe('collectToolApprovals', () => {
it('should not return any tool approvals when the last message is not a tool message', () => {
const result = collectToolApprovals({
messages: [{ role: 'user', content: 'Hello, world!' }],
});

    expect(result).toMatchInlineSnapshot(`
      {
        "approvedToolApprovals": [],
        "deniedToolApprovals": [],
      }
    `);

});

it('should ignore approval request without response', () => {
const result = collectToolApprovals({
messages: [
{
role: 'assistant',
content: [
{
type: 'tool-call',
toolCallId: 'call-1',
toolName: 'tool1',
input: { value: 'test-input' },
},
{
type: 'tool-approval-request',
approvalId: 'approval-id-1',
toolCallId: 'call-1',
},
],
},
{
role: 'tool',
content: [],
},
],
});

    expect(result).toMatchInlineSnapshot(`
      {
        "approvedToolApprovals": [],
        "deniedToolApprovals": [],
      }
    `);

});

it('should return approved approval with approved response', () => {
const result = collectToolApprovals({
messages: [
{
role: 'assistant',
content: [
{
type: 'tool-call',
