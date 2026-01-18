/**
 * `changeset version` updates the version and adds a changelog file in
 * the example apps, but we don't want to do that. So this script reverts
 * any "version" field changes and deletes the `CHANGELOG.md` file.
 *
 * Source: https://github.com/TooTallNate/nx.js/blob/main/.github/scripts/cleanup-examples.mjs
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function cleanup(app, url) {
  const appPath = join(fileURLToPath(url), app);

  console.log("Cleaning up", appPath);

  if (statSync(appPath).isDirectory()) {
    const packageJsonPath = join(appPath, "package.json");
    if (!existsSync(packageJsonPath)) {
      return;
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageJson.version = "0.0.0";
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    try {
      const changelogPath = join(appPath, "CHANGELOG.md");
      console.log("Deleting", changelogPath);
      unlinkSync(changelogPath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }
}

// examples
const examplesUrl = new URL("../../examples", import.meta.url);
for (const app of readdirSync(fileURLToPath(examplesUrl))) {
  cleanup(app, examplesUrl);
}
