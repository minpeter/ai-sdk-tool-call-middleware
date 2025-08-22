export type ModelConfig = { name: string; config?: Record<string, unknown> };

export function expandMatrix(
  models: ModelConfig[],
  configs?: Array<Record<string, unknown>>
) {
  const combos: Array<{
    model: ModelConfig;
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
