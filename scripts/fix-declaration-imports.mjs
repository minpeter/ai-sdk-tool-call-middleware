import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const declarationPattern =
  /(?:^|\s)(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/gm;

function withExtension(source, extension) {
  return source.replace(declarationPattern, (match, quote, specifier) => {
    if (extname(specifier)) {
      return match;
    }
    return match.replace(
      `${quote}${specifier}${quote}`,
      `${quote}${specifier}${extension}${quote}`
    );
  });
}

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? declarationFiles(path) : [path];
    })
  );
  return files.flat().filter((path) => path.endsWith(".d.ts"));
}

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

for (const path of await declarationFiles(distDirectory)) {
  const source = await readFile(path, "utf8");
  await writeFile(path, withExtension(source, ".js"));
}
