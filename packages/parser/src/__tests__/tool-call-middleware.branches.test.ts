import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { jsonProtocol } from "../core/protocols/json-protocol";
import { toolChoiceStream } from "../stream-handler";
import { createToolMiddleware } from "../tool-call-middleware";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

vi.mock("../v6/stream-handler", async () => {
  const actual = await vi.importActual<typeof import("../stream-handler")>(
    "../v6/stream-handler"
  );
  return {
    ...actual,
    toolChoiceStream: vi.fn(),
  };
});

describe("createToolMiddleware branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("wrapGenerate returns tool-call content when toolChoice active", async () => {
    const mw = createToolMiddleware({
      protocol: jsonProtocol,
      toolSystemPromptTemplate: () => "",
    });
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"n","arguments":{}}' }],
    });
    if (!mw.wrapGenerate) {
      throw new Error("wrapGenerate is not defined");
    }
    const result = await mw.wrapGenerate({
      doGenerate,
      params: {
        prompt: [],
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "required" } },
        },
      },
    } as any);
    expect(result.content[0]).toMatchObject({
      type: "tool-call",
      toolName: "n",
      input: "{}",
    });
  });

  it("wrapStream delegates to toolChoiceStream when toolChoice 'required' is active", async () => {
    const mw = createToolMiddleware({
      protocol: jsonProtocol,
      toolSystemPromptTemplate: () => "",
    });

    const doGenerate = vi.fn();
    const expected = {
      stream: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      request: { r: 1 },
      response: { s: 2 },
    } as any;

    (toolChoiceStream as unknown as Mock).mockResolvedValueOnce(expected);

    if (!mw.wrapStream) {
      throw new Error("wrapStream is not defined");
    }
    const result = await mw.wrapStream({
      doStream: vi.fn(),
      doGenerate,
      params: {
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "required" } },
        },
      },
    } as any);

    expect(toolChoiceStream).toHaveBeenCalledTimes(1);
    expect(toolChoiceStream).toHaveBeenCalledWith(
      expect.objectContaining({ doGenerate })
    );
    expect(result).toBe(expected);
  });

  it("wrapStream delegates to toolChoiceStream when toolChoice 'tool' is active", async () => {
    const mw = createToolMiddleware({
      protocol: jsonProtocol,
      toolSystemPromptTemplate: () => "",
    });

    const doGenerate = vi.fn();
    const expected = {
      stream: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      request: { r: 3 },
      response: { s: 4 },
    } as any;

    (toolChoiceStream as unknown as Mock).mockResolvedValueOnce(expected);

    const result = await mw.wrapStream?.({
      doStream: vi.fn(),
      doGenerate,
      params: {
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "tool", toolName: "x" } },
        },
      },
    } as any);

    expect(toolChoiceStream).toHaveBeenCalledTimes(1);
    expect(toolChoiceStream).toHaveBeenCalledWith(
      expect.objectContaining({ doGenerate })
    );
    expect(result).toBe(expected);
  });
});
