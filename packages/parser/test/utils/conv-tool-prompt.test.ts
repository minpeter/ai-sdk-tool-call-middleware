import { describe, test, expect } from 'vitest';
import { convertToolPrompt } from '../../src/utils/conv-tool-prompt';
import type { LanguageModelV2ToolDefinition, LanguageModelV2PromptContent } from '@ai-sdk/provider';

// Define some example tools for use in tests
const exampleTools: LanguageModelV2ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather in a given location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'The city and state, e.g. San Francisco, CA' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Unit for temperature' },
        },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_price',
      description: 'Get the current stock price for a symbol',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'The stock symbol' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'no_params_tool',
      description: 'A tool with no parameters.',
      parameters: { type: 'object', properties: {} }, // Explicitly empty
    },
  },
  {
    type: 'function',
    function: {
      name: 'tool_with_no_description_or_params',
      // No description
      // No parameters
    },
  },
  {
    type: 'function',
    function: {
      name: 'tool_with_nested_params',
      description: 'A tool with nested parameters.',
      parameters: {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
            required: ['id'],
          },
          data: { type: 'string' },
        },
      },
    },
  },
];

// Define tags
const TEST_TAGS = {
  toolCallTag: '<TOOL_CALL>',
  toolCallEndTag: '</TOOL_CALL>',
  toolResponseTag: '<TOOL_RESPONSE>',
  toolResponseEndTag: '</TOOL_RESPONSE>',
};

// Define toolSystemPromptTemplate variations
const defaultToolSystemPromptTemplate = (toolsString: string) =>
  `SYSTEM: You have access to the following tools:\n${toolsString}\n` +
  `To use a tool, respond with a JSON object inside ${TEST_TAGS.toolCallTag} and ${TEST_TAGS.toolCallEndTag} tags. ` +
  `For a tool response, use ${TEST_TAGS.toolResponseTag} and ${TEST_TAGS.toolResponseEndTag} tags.`;

const simpleToolSystemPromptTemplate = (toolsString: string) =>
  `Tools available:\n${toolsString}`;

const noToolsTemplate = (toolsString: string) =>
  toolsString ? `Available tools: ${toolsString}` : 'No tools available.';


describe('convertToolPrompt', () => {
  // 1. Basic Tool Prompt Generation
  describe('Basic Tool Prompt Generation', () => {
    test('should generate prompt with tools for a string input prompt', () => {
      const params = {
        prompt: 'What is the weather in London?',
        tools: [exampleTools[0]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result.length).toBe(2); // System + User
      expect(result[0].type).toBe('system');
      expect(result[0].content).toContain('SYSTEM: You have access to the following tools:');
      expect(result[0].content).toContain('get_weather');
      expect(result[0].content).toContain('Get the current weather in a given location');
      expect(result[0].content).toContain('"location": { "type": "string", "description": "The city and state, e.g. San Francisco, CA" }');
      expect(result[0].content).toContain(`${TEST_TAGS.toolCallTag}`);
      expect(result[1].type).toBe('user');
      expect(result[1].content).toBe(params.prompt);
    });

    test('should generate prompt with tools for a single user message object', () => {
      const userPrompt: LanguageModelV2PromptContent = { type: 'user', content: 'Stock price for GOOG?' };
      const params = {
        prompt: [userPrompt],
        tools: [exampleTools[1]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result.length).toBe(2);
      expect(result[0].type).toBe('system');
      expect(result[0].content).toContain('get_stock_price');
      expect(result[1]).toEqual(userPrompt);
    });
  });

  // 2. Formatting of Tool Definitions
  describe('Formatting of Tool Definitions', () => {
    test('should correctly format tool with name, description, and complex parameters', () => {
      const params = {
        prompt: 'Weather?',
        tools: [exampleTools[0]], // get_weather
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      const systemContent = result.find(m => m.type === 'system')?.content as string;
      expect(systemContent).toBeDefined();
      expect(systemContent).toMatch(/name: get_weather/);
      expect(systemContent).toMatch(/description: Get the current weather in a given location/);
      const paramsString = systemContent.substring(systemContent.indexOf('parameters: {'), systemContent.lastIndexOf('}') + 1);
      const parsedParams = JSON.parse(paramsString.replace('parameters: ', '')); // Basic way to extract and parse
      expect(parsedParams).toEqual(exampleTools[0].function.parameters);
    });

    test('should correctly format tool with no parameters', () => {
      const params = {
        prompt: 'Run no_params_tool',
        tools: [exampleTools[2]], // no_params_tool
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      const systemContent = result.find(m => m.type === 'system')?.content as string;
      expect(systemContent).toBeDefined();
      expect(systemContent).toMatch(/name: no_params_tool/);
      expect(systemContent).toMatch(/description: A tool with no parameters./);
      // Check how empty parameters are represented, e.g., "parameters: {}" or similar
      expect(systemContent).toMatch(/parameters: \{\s*type: 'object',\s*properties: \{\s*\}\s*\}/m);
    });
    
    test('should correctly format tool with no description or parameters', () => {
      const params = {
        prompt: 'Run tool_with_no_description_or_params',
        tools: [exampleTools[3]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      const systemContent = result.find(m => m.type === 'system')?.content as string;
      expect(systemContent).toBeDefined();
      expect(systemContent).toMatch(/name: tool_with_no_description_or_params/);
      // Ensure description is omitted or handled gracefully
      expect(systemContent).not.toMatch(/description:/);
      // Ensure parameters are omitted or handled gracefully (e.g. "parameters: {}" or not present)
      expect(systemContent).not.toMatch(/parameters: \{\s*type: 'object'/); // No parameters defined
    });
    
    test('should correctly format tool with nested parameters', () => {
      const params = {
        prompt: 'Run tool_with_nested_params',
        tools: [exampleTools[4]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      const systemContent = result.find(m => m.type === 'system')?.content as string;
      expect(systemContent).toBeDefined();
      expect(systemContent).toMatch(/name: tool_with_nested_params/);
      const paramsString = systemContent.substring(systemContent.indexOf('parameters: {'), systemContent.lastIndexOf('}') + 1);
      const parsedParams = JSON.parse(paramsString.replace('parameters: ', ''));
      expect(parsedParams).toEqual(exampleTools[4].function.parameters);
    });
  });

  // 3. toolSystemPromptTemplate Variations
  describe('toolSystemPromptTemplate Variations', () => {
    test('should use simple template correctly', () => {
      const params = {
        prompt: 'Hello',
        tools: [exampleTools[0]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: simpleToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result[0].type).toBe('system');
      expect(result[0].content).toContain('Tools available:');
      expect(result[0].content).toContain('get_weather');
      expect(result[0].content).not.toContain('SYSTEM: You have access');
    });
  });

  // 4. Prompt Types
  describe('Prompt Types', () => {
    test('input prompt is a string - system message prepended', () => {
      const params = {
        prompt: 'User query',
        tools: [exampleTools[0]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result.length).toBe(2);
      expect(result[0].type).toBe('system');
      expect(result[1].type).toBe('user');
      expect(result[1].content).toBe('User query');
    });

    test('input prompt array with no system message - new system message added', () => {
      const userPrompt: LanguageModelV2PromptContent = { type: 'user', content: 'User query' };
      const assistantPrompt: LanguageModelV2PromptContent = { type: 'assistant', content: 'Assistant response' };
      const params = {
        prompt: [userPrompt, assistantPrompt],
        tools: [exampleTools[0]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result.length).toBe(3);
      expect(result[0].type).toBe('system');
      expect(result[0].content).toContain('get_weather');
      expect(result[1]).toEqual(userPrompt);
      expect(result[2]).toEqual(assistantPrompt);
    });

    test('input prompt array with existing system message - tools appended to first system message', () => {
      const systemPrompt: LanguageModelV2PromptContent = { type: 'system', content: 'Initial system context.' };
      const userPrompt: LanguageModelV2PromptContent = { type: 'user', content: 'User query' };
      const params = {
        prompt: [systemPrompt, userPrompt],
        tools: [exampleTools[0]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result.length).toBe(2);
      expect(result[0].type).toBe('system');
      expect(result[0].content).toContain('Initial system context.');
      expect(result[0].content).toContain('SYSTEM: You have access to the following tools:');
      expect(result[0].content).toContain('get_weather');
      expect(result[1]).toEqual(userPrompt);
    });
    
    test('input prompt array with multiple system messages - tools appended to first system message', () => {
      const systemPrompt1: LanguageModelV2PromptContent = { type: 'system', content: 'First system message.' };
      const userPrompt: LanguageModelV2PromptContent = { type: 'user', content: 'User query' };
      const systemPrompt2: LanguageModelV2PromptContent = { type: 'system', content: 'Second system message (should be ignored for tool append).' };
      const params = {
        prompt: [systemPrompt1, userPrompt, systemPrompt2],
        tools: [exampleTools[0]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result.length).toBe(3);
      expect(result[0].type).toBe('system');
      expect(result[0].content).toContain('First system message.');
      expect(result[0].content).toContain('SYSTEM: You have access to the following tools:'); // Tools appended to first
      expect(result[1]).toEqual(userPrompt);
      expect(result[2]).toEqual(systemPrompt2); // Second system message remains as is
    });
  });

  // 5. No Tools Provided
  describe('No Tools Provided', () => {
    test('should handle empty tools array with default template', () => {
      const params = {
        prompt: 'Hello',
        tools: [],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result[0].type).toBe('system');
      // Default template will still produce its structure, but toolsString will be empty
      expect(result[0].content).toBe(
        `SYSTEM: You have access to the following tools:\n\n` + // Empty toolsString
        `To use a tool, respond with a JSON object inside ${TEST_TAGS.toolCallTag} and ${TEST_TAGS.toolCallEndTag} tags. ` +
        `For a tool response, use ${TEST_TAGS.toolResponseTag} and ${TEST_TAGS.toolResponseEndTag} tags.`
      );
    });

    test('should handle undefined tools with custom template for no tools', () => {
      const params = {
        prompt: 'Hello',
        tools: undefined, // Undefined tools
        ...TEST_TAGS,
        toolSystemPromptTemplate: noToolsTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result[0].type).toBe('system');
      expect(result[0].content).toBe('No tools available.');
    });
  });

  // 6. Handling of Tags (Implicit via template)
  describe('Handling of Tags', () => {
    test('tags should be correctly used by the default template', () => {
        const params = {
            prompt: 'Test tags',
            tools: [exampleTools[0]],
            ...TEST_TAGS,
            toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
        };
        const result = convertToolPrompt(params);
        const systemContent = result.find(m => m.type === 'system')?.content as string;
        expect(systemContent).toContain(`To use a tool, respond with a JSON object inside ${TEST_TAGS.toolCallTag} and ${TEST_TAGS.toolCallEndTag} tags.`);
        expect(systemContent).toContain(`For a tool response, use ${TEST_TAGS.toolResponseTag} and ${TEST_TAGS.toolResponseEndTag} tags.`);
    });
  });

  // 7. Empty Initial Prompt
  describe('Empty Initial Prompt', () => {
    test('should generate only system prompt if initial prompt is empty array and tools are present', () => {
      const params = {
        prompt: [],
        tools: [exampleTools[0]],
        ...TEST_TAGS,
        toolSystemPromptTemplate: defaultToolSystemPromptTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result.length).toBe(1);
      expect(result[0].type).toBe('system');
      expect(result[0].content).toContain('get_weather');
    });

    test('should generate system prompt (e.g. "No tools") if initial prompt and tools are empty/undefined', () => {
      const params = {
        prompt: [],
        tools: undefined,
        ...TEST_TAGS,
        toolSystemPromptTemplate: noToolsTemplate,
      };
      const result = convertToolPrompt(params);
      expect(result.length).toBe(1);
      expect(result[0].type).toBe('system');
      expect(result[0].content).toBe('No tools available.');
    });
  });
});
