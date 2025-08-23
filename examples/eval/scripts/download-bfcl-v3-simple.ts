import fs from "fs/promises";
import path from "path";

const OUT_DIR = path.resolve(process.cwd(), "./data/bfcl");

const files = [
  {
    url: "https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v3_simple.json",
    out: "BFCL_v3_simple.json",
  },
  {
    url: "https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/bfcl_eval/data/possible_answer/BFCL_v3_simple.json",
    out: "BFCL_v3_simple_possible_answers.json",
  },
];

async function download(url: string) {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `Failed to download ${url}: ${res.status} ${res.statusText}`
    );
  return await res.text();
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const f of files) {
    try {
      console.log("Downloading", f.url);
      const txt = await download(f.url);
      const outPath = path.join(OUT_DIR, f.out);
      await fs.writeFile(outPath, txt, "utf8");
      console.log("Saved", outPath);
    } catch (e) {
      console.error("Error fetching", f.url, e);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
