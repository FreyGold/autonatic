import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import esbuild from "esbuild";

const outputDir = "/tmp/nemotron-note-crafter-tests";
const outputFile = path.join(outputDir, "regression.test.cjs");

await rm(outputDir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: ["tests/regression.test.ts"],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: "inline",
  alias: {
    obsidian: path.resolve("tests/obsidian-mock.ts"),
  },
  external: ["electron"],
});

const result = spawnSync(process.execPath, [outputFile], {
  stdio: "inherit",
});

await rm(outputDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
