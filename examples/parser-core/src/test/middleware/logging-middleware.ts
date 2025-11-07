import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

const INV = "\x1b[7m"; // ANSI SGR: reverse video
const RESET = "\x1b[0m";
const isBrowser =
  typeof window !== "undefined" && typeof document !== "undefined";

function invLog(...args: unknown[]) {
  if (isBrowser) {
    try {
      const text = args
        .map((a) => {
          if (typeof a === "string") {
            return a;
          }
          if (a instanceof Error) {
            return a.message;
          }
          return JSON.stringify(a, null, 2);
        })
        .join(" ");
      // Simulate inverted style in browser consoles via CSS
      console.log(
        `%c${text}`,
        "background: #000; color: #fff; padding: 0 2px;"
      );
    } catch {
      console.log(
        `%c${String(args)}`,
        "background: #000; color: #fff; padding: 0 2px;"
      );
    }
  } else {
    // Node/TTY: use ANSI escape codes to invert
    console.log(INV, ...args, RESET);
  }
}

export const loggingMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate, params }) => {
    invLog("doGenerate called");
    invLog(`params: ${JSON.stringify(params, null, 2)}`);

    const result = await doGenerate();

    invLog("doGenerate finished");
    invLog(`generated text: ${result.content}`);

    return result;
  },
  wrapStream: async ({ doStream, params }) => {
    invLog("doStream called");
    invLog(`params: ${JSON.stringify(params, null, 2)}`);

    const { stream, ...rest } = await doStream();

    let generatedText = "";
    const textBlocks = new Map<string, string>();

    const transformStream = new TransformStream<
      LanguageModelV3StreamPart,
      LanguageModelV3StreamPart
    >({
      transform(chunk, controller) {
        switch (chunk.type) {
          case "text-start": {
            textBlocks.set(chunk.id, "");
            break;
          }
          case "text-delta": {
            const existing = textBlocks.get(chunk.id) || "";
            textBlocks.set(chunk.id, existing + chunk.delta);
            generatedText += chunk.delta;
            break;
          }
          case "text-end": {
            invLog(
              `Text block ${chunk.id} completed:`,
              textBlocks.get(chunk.id)
            );
            break;
          }
          default: {
            // Handle any unexpected chunk types
            break;
          }
        }

        controller.enqueue(chunk);
      },

      flush() {
        invLog("doStream finished");
        invLog(`generated text: ${generatedText}`);
      },
    });

    return {
      stream: stream.pipeThrough(transformStream),
      ...rest,
    };
  },
};
