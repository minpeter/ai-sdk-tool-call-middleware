import {
  evaluate,
  getBenchmarkByName,
  loadLocalDataset,
} from "@ai-sdk-tool/eval";
import path from "path";
import fs from "fs";
import type { LanguageModel } from "ai";

// Narrow provider interface used by the adapter
type ProviderLike = Partial<{
  call: (input: unknown) => Promise<unknown> | unknown;
  generate: (input: unknown) => Promise<unknown> | unknown;
  request: (input: unknown) => Promise<unknown> | unknown;
  createChatCompletion: (input: unknown) => Promise<unknown> | unknown;
  chat: { completions?: { create?: (input: unknown) => Promise<unknown> } };
}>;

type BfclExample = Record<string, unknown> & { function?: unknown[] };

async function main() {
  let model: LanguageModel;
  try {
    const modNs = (await import("@ai-sdk/openai")) as unknown;
    // Prefer direct `openai` export, fall back to default.openai
    const modObj = modNs as Record<string, unknown>;
    let rawOpenai: ((m: string) => ProviderLike) | undefined;
    if (modObj && typeof modObj === "object") {
      if (
        "openai" in modObj &&
        typeof (modObj as Record<string, unknown>)["openai"] === "function"
      ) {
        rawOpenai = (modObj as Record<string, unknown>)[
          "openai"
        ] as unknown as (m: string) => ProviderLike;
      } else if (
        "default" in modObj &&
        modObj["default"] &&
        typeof (modObj["default"] as Record<string, unknown>)["openai"] ===
          "function"
      ) {
        rawOpenai = (modObj["default"] as Record<string, unknown>)[
          "openai"
        ] as unknown as (m: string) => ProviderLike;
      }
    }
    if (!rawOpenai) {
      throw new Error(
        "@ai-sdk/openai does not export an 'openai' factory function"
      );
    }
    const provider = rawOpenai("gpt-4.1") as ProviderLike;
    console.log("Using @ai-sdk/openai real model: gpt-4.1");

    const typedProvider = provider as ProviderLike;

    // Adapter to satisfy legacy benchmarks that call model.call(input)
    const adapter: { call: (input: unknown) => Promise<unknown> } = {
      async call(input: unknown) {
        // If provider already supports call(), use it
        if (typeof typedProvider.call === "function") {
          return typedProvider.call!(input);
        }

        // Prefer generate/chat/createChatCompletion when available
        try {
          if (typeof typedProvider.generate === "function") {
            return await typedProvider.generate!(input);
          }
          if (
            typedProvider.chat &&
            typeof typedProvider.chat.completions?.create === "function"
          ) {
            return await typedProvider.chat.completions!.create!(input);
          }
          if (typeof typedProvider.createChatCompletion === "function") {
            return await typedProvider.createChatCompletion!(input);
          }
        } catch {
          // ignore and fall through to generic invocation
        }

        if (typeof typedProvider.request === "function") {
          return typedProvider.request!(input);
        }

        // Fallback: call OpenAI REST Chat Completions directly using OPENAI_API_KEY
        const key = process.env.OPENAI_API_KEY;
        if (!key) {
          throw new Error(
            "Provider model does not expose a known call/generate API and OPENAI_API_KEY is not set"
          );
        }

        const payload: Record<string, unknown> = { model: "gpt-4.1" };
        if (input && typeof input === "object") {
          const obj = input as Record<string, unknown>;
          if (obj.messages) payload.messages = obj.messages;
          if (obj.functions) payload.functions = obj.functions;
          if (obj.max_tokens) payload.max_tokens = obj.max_tokens;
          if (obj.temperature) payload.temperature = obj.temperature;
        } else {
          payload.messages = [{ role: "user", content: String(input) }];
        }

        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`OpenAI API error: ${resp.status} ${txt}`);
        }
        const json = await resp.json();
        return json;
      },
    };

    model = adapter as unknown as LanguageModel;
  } catch (err) {
    throw new Error(
      "Failed to load @ai-sdk/openai. Install it (npm install @ai-sdk/openai) and ensure provider credentials (for example OPENAI_API_KEY) are set in your environment. Original error: " +
        String(err)
    );
  }

  const bfcl = getBenchmarkByName("bfcl");
  if (!bfcl) {
    throw new Error(
      "bfcl benchmark not found — make sure '@ai-sdk-tool/eval' exports 'bfcl' or that getBenchmarkByName is configured."
    );
  }

  console.log(
    "Starting BFCL evaluation (this may call out to the network if RUN_WITH_REAL_MODEL=1)..."
  );
  // use legacy matrix shape (compiled dist currently expects `models`)
  const datasetPath = path.join(
    process.cwd(),
    "..",
    "..",
    "packages",
    "eval",
    "data",
    "bfcl",
    "BFCL_v3_simple.jsonl"
  );
  // Call the bfcl benchmark directly with explicit config (datasetPath)
  // load dataset into memory and pass it directly into the dist benchmark (dist expects config.dataset)
  let ds: BfclExample[] | null = null;
  try {
    ds = (await loadLocalDataset(datasetPath as string)) as BfclExample[];
  } catch {
    ds = null;
  }
  if (!ds || !Array.isArray(ds) || ds.length === 0) {
    throw new Error(
      "Failed to load BFCL dataset from package path: " + datasetPath
    );
  }
  const paPath = path.join(
    process.cwd(),
    "..",
    "..",
    "packages",
    "eval",
    "data",
    "bfcl",
    "BFCL_v3_simple_possible_answers.jsonl"
  );
  // read possible answers into memory similarly
  const paRaw = await fs.promises.readFile(paPath, "utf-8");
  const paRows = paRaw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  const possibleAnswers: Record<string, unknown[]> = {};
  for (const r of paRows) {
    try {
      const obj = JSON.parse(r) as Record<string, unknown>;
      const gt = obj.ground_truth as unknown;
      if (obj && typeof obj === "object" && Array.isArray(gt)) {
        const id = String(obj.id ?? "");
        possibleAnswers[id] = gt as unknown[];
      }
    } catch {
      // ignore malformed lines
    }
  }
  // Sanitize function definitions and names for OpenAI functions schema
  // - replace parameter.type 'dict' with 'object'
  // - sanitize function names: replace '.' with '_' (OpenAI expects alphanum/_/-)
  const nameMap = new Map<string, string>();
  const sanitizedDs = ds.map(ex => {
    const copy = { ...ex } as Record<string, unknown>;
    if (Array.isArray(copy.function)) {
      copy.function = (copy.function as unknown[]).map(f => {
        const frec = f as Record<string, unknown>;
        const fcopy: Record<string, unknown> = { ...frec };
        const origName = String(fcopy.name ?? "");
        const sanitized = origName.replace(/[^a-zA-Z0-9_-]/g, "_");
        nameMap.set(origName, sanitized);
        fcopy.name = sanitized;
        const params = fcopy.parameters as Record<string, unknown> | undefined;
        if (params && params.type === "dict") {
          params.type = "object" as unknown as string;
          fcopy.parameters = params;
        }
        return fcopy;
      });
    }
    return copy as BfclExample;
  });

  // Sanitize possibleAnswers keys to use sanitized function names as well
  const sanitizedPossibleAnswers: Record<string, unknown[]> = {};
  for (const [id, arr] of Object.entries(possibleAnswers)) {
    sanitizedPossibleAnswers[id] = arr.map(item => {
      if (item && typeof item === "object") {
        const transformed: Record<string, unknown> = {};
        for (const k of Object.keys(item as Record<string, unknown>)) {
          const mapped = nameMap.get(k) ?? k.replace(/[^a-zA-Z0-9_-]/g, "_");
          transformed[mapped] = (item as Record<string, unknown>)[k];
        }
        return transformed;
      }
      return item;
    });
  }

  const res = await bfcl.run(model, {
    dataset: sanitizedDs,
    possibleAnswers: sanitizedPossibleAnswers,
  });
  const evalPkg = await import("@ai-sdk-tool/eval");
  const reporter = evalPkg.getReporter("console");
  if (reporter && typeof reporter.result === "function") {
    (reporter as { result: (r: unknown) => void }).result(res);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
