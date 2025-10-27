import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import {
  type ModelMessage,
  stepCountIs,
  streamText,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

const file_write = {
  description:
    "Write a text file to the local workspace. Always provide the FULL contents.",
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "Relative path within the current workspace (e.g., 'src/main.ts', 'README.md')."
      ),
    content: z
      .string()
      .describe(
        "Full UTF-8 file contents to write (overwrites existing file)."
      ),
  }),
  execute: async ({
    path: filePath,
    content,
  }: {
    path: string;
    content: string;
  }) => {
    const workspaceRoot = process.cwd();
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspaceRoot, filePath);

    // Ensure writes stay inside the workspace root
    const normalizedRoot = path.resolve(workspaceRoot) + path.sep;
    const normalizedTarget =
      path.resolve(resolved) + (resolved.endsWith(path.sep) ? path.sep : "");
    if (!normalizedTarget.startsWith(normalizedRoot)) {
      throw new Error("Refusing to write outside of the workspace root.");
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, { encoding: "utf8" });
    return {
      success: true,
      path: resolved,
      bytes: Buffer.byteLength(content, "utf8"),
      message: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${resolved}`,
    };
  },
};

async function main() {
  const rl = readline.createInterface({ input, output });
  console.log("FileWrite Agent — type 'exit' to quit.\n");

  const messages: ModelMessage[] = [
    {
      role: "system",
      content:
        "You are a helpful code assistant. When the user asks to create or modify files, use the file_write tool. Always write complete file contents. Keep explanations concise.",
    },
  ];

  while (true) {
    const user = (await rl.question("You > ")).trim();
    if (user.toLowerCase() === "exit" || user.toLowerCase() === "quit") break;
    if (user.length === 0) continue;
    messages.push({ role: "user", content: user });

    const result = streamText({
      model: wrapLanguageModel({
        model: friendli("LGAI-EXAONE/EXAONE-4.0.1-32B"),
        middleware: [
          morphXmlToolMiddleware,
          // loggingMiddleware
        ],
      }),
      temperature: 0.0,
      messages,
      // Allow a few tool-call iterations per turn
      stopWhen: stepCountIs(6),
      tools: { file_write },
    });

    let assistantText = "";
    process.stdout.write("Assistant > ");
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        assistantText += part.text;
        process.stdout.write(part.text);
      } else if (part.type === "tool-result") {
        // Log tool events succinctly
        console.log(
          `\n[tool-result] ${part.toolName} -> ${typeof part.output === "string" ? part.output : JSON.stringify(part.output)}\n`
        );
        process.stdout.write("Assistant > ");
      }
    }
    process.stdout.write("\n\n");

    if (assistantText.trim().length > 0) {
      messages.push({ role: "assistant", content: assistantText });
    }
  }

  rl.close();
  console.log("Goodbye!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
