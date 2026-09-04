import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AnalysisOutput,
  ArmId,
  Category,
  FailureSummary,
  PairedSummary,
  SensitivitySummary,
  Summary,
} from "./analyze";

const COLORS: Record<string, string> = {
  native: "#111827",
  glm5: "#dc2626",
  hermes: "#7c3aed",
  morphXml: "#059669",
  yamlXml: "#d97706",
  qwen3Coder: "#2563eb",
  sijawaraDetailed: "#db2777",
  sijawaraConcise: "#f472b6",
  uiTars: "#0891b2",
};
const COMPACT_LABELS: Record<string, string> = {
  native: "Native",
  glm5: "GLM-5.2",
  hermes: "Hermes",
  morphXml: "Morph",
  yamlXml: "YAML",
  qwen3Coder: "Qwen",
  sijawaraDetailed: "Sija-D",
  sijawaraConcise: "Sija-C",
  uiTars: "UI-TARS",
};
const EFFICIENCY_LABEL_OFFSETS: Record<
  string,
  { deltaX: number; deltaY: number }
> = {
  native: { deltaX: 14, deltaY: -10 },
  glm5: { deltaX: 14, deltaY: 10 },
  hermes: { deltaX: 14, deltaY: 26 },
  morphXml: { deltaX: 14, deltaY: -10 },
  yamlXml: { deltaX: 14, deltaY: 10 },
  qwen3Coder: { deltaX: 14, deltaY: -18 },
  sijawaraDetailed: { deltaX: 14, deltaY: 16 },
  sijawaraConcise: { deltaX: 14, deltaY: -12 },
  uiTars: { deltaX: 14, deltaY: 14 },
};
const UNKNOWN_ARM_COLORS = [
  "#475569",
  "#a16207",
  "#4f46e5",
  "#be123c",
  "#15803d",
] as const;
const CSV_ESCAPE_PATTERN = /[",\n]/;
function armColor(arm: ArmId): string {
  const configured = COLORS[arm];
  if (configured) {
    return configured;
  }
  let hash = 0;
  for (let index = 0; index < arm.length; index += 1) {
    hash = (hash * 31 + arm.charCodeAt(index)) % 2_147_483_647;
  }
  return UNKNOWN_ARM_COLORS[hash % UNKNOWN_ARM_COLORS.length];
}

function compactArmLabel(arm: ArmId): string {
  return COMPACT_LABELS[arm] ?? arm;
}

function efficiencyLabelOffset(arm: ArmId): { deltaX: number; deltaY: number } {
  return (
    EFFICIENCY_LABEL_OFFSETS[arm] ?? {
      deltaX: 14,
      deltaY: 14,
    }
  );
}

function csv(rows: readonly object[]): string {
  if (rows.length === 0) {
    return "";
  }
  const columns = Object.keys(rows[0]);
  const cell = (value: string | number | boolean | null | undefined) => {
    const text = value === null || value === undefined ? "" : String(value);
    return CSV_ESCAPE_PATTERN.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  };
  return `${columns.join(",")}\n${rows
    .map((row) => Object.values(row).map(cell).join(","))
    .join("\n")}\n`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function svgFrame(
  width: number,
  height: number,
  title: string,
  content: string
) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title">
  <title id="chart-title">${escapeXml(title)}</title>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <style>text{font-family:Inter,Arial,sans-serif;fill:#111827}.title{font-size:24px;font-weight:700}.label{font-size:14px}.small{font-size:12px;fill:#4b5563}.value{font-size:13px;font-weight:700}.grid{stroke:#e5e7eb;stroke-width:1}</style>
  <text x="40" y="38" class="title">${escapeXml(title)}</text>
  ${content}
</svg>\n`;
}

function accuracySvg(summaries: Array<Summary & { arm: ArmId }>): string {
  const width = 1040;
  const left = 190;
  const top = 75;
  const chartWidth = 780;
  const rowHeight = 58;
  const height = Math.max(240, top + summaries.length * rowHeight + 45);
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const x = left + (tick / 100) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top - 10}" x2="${x}" y2="${height - 45}" class="grid"/>`
    );
    lines.push(
      `<text x="${x}" y="${height - 22}" text-anchor="middle" class="small">${tick}%</text>`
    );
  }
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    const accuracy = summary.accuracy ?? 0;
    const lower = summary.lower95 ?? 0;
    const upper = summary.upper95 ?? 0;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${accuracy * chartWidth}" height="25" rx="5" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<line x1="${left + lower * chartWidth}" y1="${y + 17.5}" x2="${left + upper * chartWidth}" y2="${y + 17.5}" stroke="#111827" stroke-width="2"/>`
    );
    lines.push(
      `<line x1="${left + lower * chartWidth}" y1="${y + 11}" x2="${left + lower * chartWidth}" y2="${y + 24}" stroke="#111827"/>`
    );
    lines.push(
      `<line x1="${left + upper * chartWidth}" y1="${y + 11}" x2="${left + upper * chartWidth}" y2="${y + 24}" stroke="#111827"/>`
    );
    lines.push(
      `<text x="${left + accuracy * chartWidth + 8}" y="${y + 23}" class="value">${(accuracy * 100).toFixed(1)}%</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Strict BFCL accuracy by protocol (95% Wilson CI)",
    lines.join("\n")
  );
}

function semanticVsStrictSvg(
  summaries: Array<Summary & { arm: ArmId }>
): string {
  const width = 1040;
  const left = 190;
  const top = 80;
  const chartWidth = 780;
  const rowHeight = 65;
  const height = Math.max(250, top + summaries.length * rowHeight + 60);
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const x = left + (tick / 100) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top - 10}" x2="${x}" y2="${height - 60}" class="grid"/>`
    );
    lines.push(
      `<text x="${x}" y="${height - 34}" text-anchor="middle" class="small">${tick}%</text>`
    );
  }
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    const semantic = summary.bfclAccuracy ?? 0;
    const strict = summary.accuracy ?? 0;
    lines.push(
      `<text x="${left - 14}" y="${y + 28}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${semantic * chartWidth}" height="18" rx="4" fill="${armColor(summary.arm)}" opacity="0.3"/>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 28}" width="${strict * chartWidth}" height="18" rx="4" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<text x="${left + semantic * chartWidth + 7}" y="${y + 19}" class="small">semantic ${(semantic * 100).toFixed(1)}%</text>`
    );
    lines.push(
      `<text x="${left + strict * chartWidth + 7}" y="${y + 43}" class="value">strict ${(strict * 100).toFixed(1)}%</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "BFCL semantic accuracy vs protocol-strict accuracy",
    lines.join("\n")
  );
}

function sijawaraSensitivitySvg(rows: SensitivitySummary[]): string {
  const width = 1040;
  const height = 420;
  const left = 210;
  const top = 95;
  const chartWidth = 760;
  const rowHeight = 115;
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const x = left + (tick / 100) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top - 15}" x2="${x}" y2="${height - 70}" class="grid"/>`
    );
    lines.push(
      `<text x="${x}" y="${height - 45}" text-anchor="middle" class="small">${tick}%</text>`
    );
  }
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    lines.push(
      `<text x="${left - 14}" y="${y + 42}" text-anchor="end" class="label">${escapeXml(compactArmLabel(row.arm))}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${row.originalAccuracy * chartWidth}" height="28" rx="5" fill="${armColor(row.arm)}" opacity="0.35"/>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 43}" width="${row.trimmedAccuracy * chartWidth}" height="28" rx="5" fill="${armColor(row.arm)}"/>`
    );
    lines.push(
      `<text x="${left + row.originalAccuracy * chartWidth + 8}" y="${y + 25}" class="small">observed ${(row.originalAccuracy * 100).toFixed(1)}%</text>`
    );
    lines.push(
      `<text x="${left + row.trimmedAccuracy * chartWidth + 8}" y="${y + 64}" class="value">trim sensitivity ${(row.trimmedAccuracy * 100).toFixed(1)}% (+${row.recovered})</text>`
    );
  });
  lines.push(
    `<text x="${left}" y="${height - 16}" class="small">Diagnostic counterfactual: recursively trim decoded string arguments, then re-run the official BFCL checker.</text>`
  );
  return svgFrame(
    width,
    height,
    "Sijawara whitespace sensitivity (not an observed benchmark score)",
    lines.join("\n")
  );
}

function availabilitySvg(summaries: Array<Summary & { arm: ArmId }>): string {
  const width = 1040;
  const left = 190;
  const top = 75;
  const chartWidth = 780;
  const rowHeight = 58;
  const height = Math.max(240, top + summaries.length * rowHeight + 45);
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const x = left + (tick / 100) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top - 10}" x2="${x}" y2="${height - 45}" class="grid"/>`
    );
  }
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${summary.availability * chartWidth}" height="25" rx="5" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<text x="${left + summary.availability * chartWidth - 8}" y="${y + 23}" text-anchor="end" class="value" fill="#ffffff">${(summary.availability * 100).toFixed(1)}%</text>`
    );
    lines.push(
      `<text x="${left + chartWidth + 10}" y="${y + 23}" class="small">${summary.transportErrors} provider errors</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Provider availability after configured retries",
    lines.join("\n")
  );
}

function latencySvg(summaries: Array<Summary & { arm: ArmId }>): string {
  // Keep room to the right of the longest p95 bar for its value label.
  const width = 1220;
  const left = 190;
  const top = 75;
  const chartWidth = 780;
  const rowHeight = 58;
  const height = Math.max(240, top + summaries.length * rowHeight + 45);
  const maxMs = Math.max(
    ...summaries.map((summary) => summary.latencyP95Ms ?? 0)
  );
  const scale = maxMs === 0 ? 0 : chartWidth / maxMs;
  const lines: string[] = [];
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    const p50 = summary.latencyP50Ms ?? 0;
    const p95 = summary.latencyP95Ms ?? 0;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${p95 * scale}" height="25" rx="5" fill="${armColor(summary.arm)}" opacity="0.25"/>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${p50 * scale}" height="25" rx="5" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<text x="${left + p95 * scale + 8}" y="${y + 23}" class="value">p50 ${(p50 / 1000).toFixed(1)}s / p95 ${(p95 / 1000).toFixed(1)}s</text>`
    );
  });
  lines.push(
    `<text x="${left}" y="${height - 22}" class="small">Solid = p50, translucent extension = p95</text>`
  );
  return svgFrame(
    width,
    height,
    "End-to-end latency by protocol",
    lines.join("\n")
  );
}

function tokensSvg(summaries: Array<Summary & { arm: ArmId }>): string {
  const width = 1040;
  const left = 190;
  const top = 75;
  const chartWidth = 780;
  const rowHeight = 58;
  const height = Math.max(240, top + summaries.length * rowHeight + 45);
  const maxTokens = Math.max(
    ...summaries.map(
      (summary) =>
        (summary.inputTokensMean ?? 0) + (summary.outputTokensMean ?? 0)
    )
  );
  const scale = maxTokens === 0 ? 0 : chartWidth / maxTokens;
  const lines: string[] = [];
  summaries.forEach((summary, index) => {
    const y = top + index * rowHeight;
    const input = summary.inputTokensMean ?? 0;
    const output = summary.outputTokensMean ?? 0;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(summary.arm)}</text>`
    );
    lines.push(
      `<rect x="${left}" y="${y + 5}" width="${input * scale}" height="25" rx="5" fill="${armColor(summary.arm)}"/>`
    );
    lines.push(
      `<rect x="${left + input * scale}" y="${y + 5}" width="${output * scale}" height="25" fill="#fbbf24"/>`
    );
    lines.push(
      `<text x="${left + (input + output) * scale + 8}" y="${y + 23}" class="value">${input.toFixed(0)} in + ${output.toFixed(0)} out</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Mean token use per request",
    lines.join("\n")
  );
}

function efficiencySvg(summaries: Array<Summary & { arm: ArmId }>): string {
  const width = 1040;
  const height = 650;
  const left = 100;
  const top = 80;
  const chartWidth = 850;
  const chartHeight = 480;
  const totals = summaries.map(
    (summary) =>
      (summary.inputTokensMean ?? 0) + (summary.outputTokensMean ?? 0)
  );
  const maxTokens = Math.max(1, ...totals) * 1.12;
  const lines: string[] = [];
  for (let tick = 0; tick <= 100; tick += 20) {
    const y = top + chartHeight - (tick / 100) * chartHeight;
    lines.push(
      `<line x1="${left}" y1="${y}" x2="${left + chartWidth}" y2="${y}" class="grid"/>`
    );
    lines.push(
      `<text x="${left - 12}" y="${y + 4}" text-anchor="end" class="small">${tick}%</text>`
    );
  }
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = (maxTokens * tick) / 4;
    const x = left + (tick / 4) * chartWidth;
    lines.push(
      `<line x1="${x}" y1="${top}" x2="${x}" y2="${top + chartHeight}" class="grid"/>`
    );
    lines.push(
      `<text x="${x}" y="${top + chartHeight + 24}" text-anchor="middle" class="small">${value.toFixed(0)}</text>`
    );
  }
  summaries.forEach((summary, index) => {
    const total = totals[index];
    const accuracy = summary.accuracy ?? 0;
    const x = left + (total / maxTokens) * chartWidth;
    const y = top + chartHeight - accuracy * chartHeight;
    const labelOffset = efficiencyLabelOffset(summary.arm);
    lines.push(
      `<circle cx="${x}" cy="${y}" r="10" fill="${armColor(summary.arm)}" stroke="#ffffff" stroke-width="2"/>`
    );
    lines.push(
      `<text x="${x + labelOffset.deltaX}" y="${y + labelOffset.deltaY}" class="label">${escapeXml(compactArmLabel(summary.arm))}</text>`
    );
  });
  lines.push(
    `<text x="${left + chartWidth / 2}" y="${height - 25}" text-anchor="middle" class="label">Mean input + output tokens per request (lower is better)</text>`
  );
  return svgFrame(
    width,
    height,
    "Quality-efficiency frontier",
    lines.join("\n")
  );
}

function pairedVsNativeSvg(paired: PairedSummary[]): string {
  const width = 1120;
  const center = 560;
  const top = 85;
  const halfWidth = 390;
  const rowHeight = 62;
  const height = Math.max(240, top + paired.length * rowHeight + 65);
  const maxCount = Math.max(
    1,
    ...paired.flatMap((row) => [row.conversionLoss, row.recovery])
  );
  const scale = halfWidth / maxCount;
  const lines: string[] = [
    `<text x="40" y="62" class="small">End-to-end strict outcome; provider and parser failures count as incorrect</text>`,
    `<line x1="${center}" y1="${top - 20}" x2="${center}" y2="${height - 65}" stroke="#111827" stroke-width="2"/>`,
    `<text x="${center - halfWidth / 2}" y="${top - 30}" text-anchor="middle" class="small">Native correct → protocol wrong</text>`,
    `<text x="${center + halfWidth / 2}" y="${top - 30}" text-anchor="middle" class="small">Native wrong → protocol correct</text>`,
  ];
  paired.forEach((row, index) => {
    const y = top + index * rowHeight;
    const lossWidth = row.conversionLoss * scale;
    const recoveryWidth = row.recovery * scale;
    lines.push(
      `<text x="${center - halfWidth - 15}" y="${y + 24}" text-anchor="end" class="label">${escapeXml(compactArmLabel(row.arm))}</text>`
    );
    lines.push(
      `<rect x="${center - lossWidth}" y="${y + 5}" width="${lossWidth}" height="25" fill="#ef4444"/>`
    );
    lines.push(
      `<rect x="${center}" y="${y + 5}" width="${recoveryWidth}" height="25" fill="#22c55e"/>`
    );
    lines.push(
      `<text x="${center - lossWidth - 7}" y="${y + 23}" text-anchor="end" class="value">−${row.conversionLoss}</text>`
    );
    lines.push(
      `<text x="${center + recoveryWidth + 7}" y="${y + 23}" class="value">+${row.recovery}</text>`
    );
    lines.push(
      `<text x="${center + halfWidth + 12}" y="${y + 23}" class="small">net ${row.netVsNative >= 0 ? "+" : ""}${row.netVsNative}</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Paired outcome changes vs native",
    lines.join("\n")
  );
}

function heatColor(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  const red = Math.round(239 + (34 - 239) * clamped);
  const green = Math.round(68 + (197 - 68) * clamped);
  const blue = Math.round(68 + (94 - 68) * clamped);
  return `rgb(${red},${green},${blue})`;
}

function heatmapSvg(
  matrix: Map<string, Summary>,
  categories: readonly Category[],
  arms: readonly ArmId[]
): string {
  const cellWidth = 140;
  const cellHeight = 42;
  const left = 250;
  const top = 120;
  // The previous content-derived width clipped the descriptive chart title.
  const width = Math.max(680, left + cellWidth * arms.length + 40);
  const height = top + cellHeight * categories.length + 45;
  const lines: string[] = [];
  arms.forEach((arm, index) => {
    const x = left + index * cellWidth + cellWidth / 2;
    lines.push(
      `<text x="${x}" y="${top - 15}" text-anchor="middle" class="small">${escapeXml(compactArmLabel(arm))}</text>`
    );
  });
  categories.forEach((category, rowIndex) => {
    const y = top + rowIndex * cellHeight;
    lines.push(
      `<text x="${left - 12}" y="${y + 27}" text-anchor="end" class="label">${escapeXml(category)}</text>`
    );
    arms.forEach((arm, columnIndex) => {
      const summary = matrix.get(`${category}\u0000${arm}`);
      const accuracy = summary?.accuracy ?? 0;
      const x = left + columnIndex * cellWidth;
      lines.push(
        `<rect x="${x + 1}" y="${y + 1}" width="${cellWidth - 2}" height="${cellHeight - 2}" rx="4" fill="${heatColor(accuracy)}"/>`
      );
      lines.push(
        `<text x="${x + cellWidth / 2}" y="${y + 27}" text-anchor="middle" class="value" fill="#111827">${summary?.accuracy === null || summary === undefined ? "N/A" : `${(accuracy * 100).toFixed(0)}%`}</text>`
      );
    });
  });
  return svgFrame(
    width,
    height,
    "Accuracy heatmap: protocol x BFCL category",
    lines.join("\n")
  );
}

function failureSvg(failures: FailureSummary[]): string {
  const width = 1160;
  const left = 190;
  const top = 85;
  const chartWidth = 880;
  const rowHeight = 58;
  const height = Math.max(300, top + failures.length * rowHeight + 100);
  const keys: Array<keyof Omit<FailureSummary, "arm">> = [
    "missingCall",
    "wrongValue",
    "wrongType",
    "wrongFunction",
    "wrongCount",
    "unexpectedCall",
    "textLeak",
    "malformed",
    "provider",
    "otherSemantic",
  ];
  const colors = [
    "#ef4444",
    "#f97316",
    "#eab308",
    "#84cc16",
    "#14b8a6",
    "#06b6d4",
    "#8b5cf6",
    "#d946ef",
    "#64748b",
    "#cbd5e1",
  ];
  const maxFailures = Math.max(
    1,
    ...failures.map((failure) =>
      keys.reduce((sum, key) => sum + failure[key], 0)
    )
  );
  const lines: string[] = [];
  failures.forEach((failure, rowIndex) => {
    const y = top + rowIndex * rowHeight;
    let x = left;
    lines.push(
      `<text x="${left - 14}" y="${y + 22}" text-anchor="end" class="label">${escapeXml(failure.arm)}</text>`
    );
    keys.forEach((key, index) => {
      const value = failure[key];
      const widthForValue = (value / maxFailures) * chartWidth;
      if (value > 0) {
        lines.push(
          `<rect x="${x}" y="${y + 5}" width="${widthForValue}" height="25" fill="${colors[index]}"/>`
        );
        if (widthForValue > 24) {
          lines.push(
            `<text x="${x + widthForValue / 2}" y="${y + 22}" text-anchor="middle" class="small">${value}</text>`
          );
        }
      }
      x += widthForValue;
    });
  });
  keys.forEach((key, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const x = 190 + column * 180;
    const y = height - 55 + row * 22;
    lines.push(
      `<rect x="${x}" y="${y - 11}" width="13" height="13" fill="${colors[index]}"/><text x="${x + 19}" y="${y}" class="small">${key}</text>`
    );
  });
  return svgFrame(
    width,
    height,
    "Failure taxonomy by protocol",
    lines.join("\n")
  );
}

export function writeAnalysisOutputs(options: AnalysisOutput): void {
  mkdirSync(join(options.outDir, "charts"), { recursive: true });
  const summary = {
    arms: options.armSummaries,
    categories: options.categorySummaries,
    failureTaxonomy: options.failureSummaries,
    generatedAt: new Date().toISOString(),
    methodology: {
      conditionalAccuracy:
        "provider-successful rows only; availability and endToEndAccuracy are reported separately",
      pairedPrimary:
        "two-sided exact McNemar on matched end-to-end strict outcomes; provider and parser failures count as incorrect",
      pairedSecondary:
        "conditional strict and BFCL semantic McNemar on pairs where both transports succeeded",
    },
    pairedVsNative: options.paired,
    sensitivity: options.sensitivity,
    source: options.source,
    totalRows: options.totalRows,
  };
  writeFileSync(
    join(options.outDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  writeFileSync(
    join(options.outDir, "protocol-summary.csv"),
    csv(options.armSummaries)
  );
  writeFileSync(
    join(options.outDir, "category-summary.csv"),
    csv(options.categorySummaries)
  );
  writeFileSync(
    join(options.outDir, "failure-summary.csv"),
    csv(options.failureSummaries)
  );
  writeFileSync(
    join(options.outDir, "paired-vs-native.csv"),
    csv(options.paired)
  );
  writeFileSync(
    join(options.outDir, "charts", "accuracy.svg"),
    accuracySvg(
      [...options.armSummaries].sort(
        (left, right) => (right.accuracy ?? -1) - (left.accuracy ?? -1)
      )
    )
  );
  writeFileSync(
    join(options.outDir, "charts", "semantic-vs-strict.svg"),
    semanticVsStrictSvg(options.armSummaries)
  );
  writeFileSync(
    join(options.outDir, "charts", "availability.svg"),
    availabilitySvg(options.armSummaries)
  );
  writeFileSync(
    join(options.outDir, "charts", "latency.svg"),
    latencySvg(options.armSummaries)
  );
  writeFileSync(
    join(options.outDir, "charts", "tokens.svg"),
    tokensSvg(options.armSummaries)
  );
  writeFileSync(
    join(options.outDir, "charts", "efficiency.svg"),
    efficiencySvg(options.armSummaries)
  );
  writeFileSync(
    join(options.outDir, "charts", "paired-vs-native.svg"),
    pairedVsNativeSvg(options.paired)
  );
  writeFileSync(
    join(options.outDir, "charts", "category-heatmap.svg"),
    heatmapSvg(
      options.categoryArmMatrix,
      options.categories,
      options.observedArms
    )
  );
  writeFileSync(
    join(options.outDir, "charts", "failures.svg"),
    failureSvg(options.failureSummaries)
  );
  if (options.sensitivity) {
    writeFileSync(
      join(options.outDir, "sijawara-trim-sensitivity.json"),
      `${JSON.stringify(options.sensitivity, null, 2)}\n`
    );
    writeFileSync(
      join(options.outDir, "charts", "sijawara-trim-sensitivity.svg"),
      sijawaraSensitivitySvg(options.sensitivity)
    );
  }
}
