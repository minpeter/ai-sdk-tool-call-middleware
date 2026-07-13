import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootDirectory = new URL("..", import.meta.url);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "ai-sdk-tool-parser-consumer-")
);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, cwd = temporaryDirectory) {
  const resolvedCommand = command === "pnpm" ? pnpmCommand : command;
  execFileSync(resolvedCommand, args, {
    cwd,
    env: { ...process.env, DO_NOT_TRACK: "1" },
    stdio: "inherit",
  });
}

try {
  run(
    "pnpm",
    ["pack", "--pack-destination", temporaryDirectory],
    rootDirectory
  );

  const tarballName = (await readdir(temporaryDirectory)).find((name) =>
    name.endsWith(".tgz")
  );
  if (!tarballName) {
    throw new Error("pnpm pack did not produce a tarball");
  }

  const packageJson = {
    name: "package-consumer-fixture",
    private: true,
    type: "module",
    dependencies: {
      "@ai-sdk-tool/parser": `file:./${tarballName}`,
      "@ai-sdk/provider": "4.0.2",
      "@ai-sdk/provider-utils": "5.0.6",
    },
    devDependencies: {
      "@types/json-schema": "7.0.15",
      "@types/node": "26.1.1",
      typescript: "7.0.2",
    },
  };
  await writeFile(
    join(temporaryDirectory, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );

  const source = `
import * as parser from "@ai-sdk-tool/parser";
import * as community from "@ai-sdk-tool/parser/community";
import * as rjson from "@ai-sdk-tool/parser/rjson";
import * as rxml from "@ai-sdk-tool/parser/rxml";
import * as schemaCoerce from "@ai-sdk-tool/parser/schema-coerce";

export const entrypointSizes = [parser, community, rjson, rxml, schemaCoerce]
  .map((entrypoint) => Object.keys(entrypoint).length);
`;
  await writeFile(join(temporaryDirectory, "consumer.ts"), source);

  const sharedCompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    target: "ES2022",
    types: ["node"],
  };
  await writeFile(
    join(temporaryDirectory, "tsconfig.nodenext.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          ...sharedCompilerOptions,
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        files: ["consumer.ts"],
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(temporaryDirectory, "tsconfig.bundler.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          ...sharedCompilerOptions,
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        files: ["consumer.ts"],
      },
      null,
      2
    )}\n`
  );

  const runtimeSource = `
const entrypoints = [
  "@ai-sdk-tool/parser",
  "@ai-sdk-tool/parser/community",
  "@ai-sdk-tool/parser/rjson",
  "@ai-sdk-tool/parser/rxml",
  "@ai-sdk-tool/parser/schema-coerce",
];

for (const entrypoint of entrypoints) {
  const exports = await import(entrypoint);
  if (Object.keys(exports).length === 0) {
    throw new Error(\`No exports found for \${entrypoint}\`);
  }
}
`;
  await writeFile(join(temporaryDirectory, "runtime.mjs"), runtimeSource);

  const commonJsSource = `
void (async () => {
  const exports = await import("@ai-sdk-tool/parser");
  if (Object.keys(exports).length === 0) {
    throw new Error("Dynamic import returned no exports");
  }

  try {
    require("@ai-sdk-tool/parser");
  } catch {
    return;
  }
  throw new Error("CommonJS require unexpectedly succeeded");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
  await writeFile(join(temporaryDirectory, "commonjs.cjs"), commonJsSource);

  run("pnpm", ["install", "--ignore-scripts"]);
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.nodenext.json"]);
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.bundler.json"]);
  run("node", ["runtime.mjs"]);
  run("node", ["commonjs.cjs"]);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
