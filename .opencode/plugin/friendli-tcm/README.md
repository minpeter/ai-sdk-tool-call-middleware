# Friendli TCM OpenCode Plugin

OpenCode plugin providing access to [Friendli AI](https://friendli.ai)'s GLM-4.6 model with support for both native and XML-based tool calling.

## Features

- Dual Tool Calling Modes
  - **Native**: Uses Friendli API's built-in tool calling
  - **XML**: Uses `morphXmlToolMiddleware` for XML-based tool calling optimized for GLM models
- High Performance: GLM-4.6 offers superior coding and reasoning performance
- 128K Context Window: Handle large codebases and complex tasks

## Installation

1. **Clone or copy this plugin directory**:
   ```bash
   mkdir -p .opencode/plugin
   cp -r friendli-tcm .opencode/plugin/
   ```

2. **Install dependencies**:
   ```bash
   cd .opencode/plugin/friendli-tcm
   pnpm install
   ```

3. **Set up your Friendli API token**:
   ```bash
   export FRIENDLI_TOKEN="your-friendli-token-here"
   ```

## Configuration

The OpenCode configuration is in `.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugin/friendli-tcm"],
  "provider": {
    "tcm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "TCM Friendli",
      "options": {
        "baseURL": "https://api.friendli.ai/serverless/v1",
        "apiKey": "{env:FRIENDLI_TOKEN}"
      },
      "models": {
        "glm-native": {
          "id": "zai-org/GLM-4.6",
          "name": "GLM-4.6 (Native Tool Calling)",
          "reasoning": true,
          "limit": {
            "context": 128000,
            "output": 8192
          }
        },
        "glm-xml": {
          "id": "zai-org/GLM-4.6",
          "name": "GLM-4.6 (XML Tool Calling)",
          "reasoning": true,
          "limit": {
            "context": 128000,
            "output": 8192
          }
        }
      }
    }
  }
}
```

## Usage

### In OpenCode

```bash
opencode

# Use native tool calling
> /model tcm/glm-native
> Write a function to calculate fibonacci numbers

# Use XML tool calling
> /model tcm/glm-xml
```

### Standalone Usage (Outside OpenCode)

See `examples/` directory for standalone usage with `@friendliai/ai-provider`.

## Plugin Features

The plugin automatically adds these parameters to Friendli API requests:

- Removes `thinking` parameter (not supported by Friendli)
- Adds `parse_reasoning: true` for reasoning content parsing
- Adds `include_reasoning: true` to include reasoning in response
- Adds `chat_template_kwargs: { enable_thinking: true }` to enable reasoning

## Model Information

| Model | Context Window | Max Output | Tool Calling |
|-------|----------------|------------|--------------|
| tcm/glm-native | 128K tokens | 8K tokens | Native |
| tcm/glm-xml | 128K tokens | 8K tokens | XML Middleware |

## Troubleshooting

### "FRIENDLI_TOKEN not set" Error

```bash
export FRIENDLI_TOKEN="your-token"
```

### "reasoning part not found" Error

Make sure the plugin is loaded. Check `.opencode/opencode.json` has:
```json
"plugin": ["./plugin/friendli-tcm"]
```

## License

Apache-2.0
