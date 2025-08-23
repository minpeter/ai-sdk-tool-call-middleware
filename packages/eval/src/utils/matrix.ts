import type { LanguageModel } from "ai";

export function expandMatrix(
  models: LanguageModel[],
  configs?: Array<Record<string, unknown>>
) {
  const combos: Array<{
    model: LanguageModel;
    config?: Record<string, unknown>;
  }> = [];
  if (!configs || configs.length === 0) {
    for (const m of models) combos.push({ model: m });
    return combos;
  }

  for (const m of models) {
    for (const c of configs) combos.push({ model: m, config: c });
  }
  return combos;
}
