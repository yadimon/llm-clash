import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "llm-clash-published-npx-"));

try {
  const result = spawnSync("npx", ["--yes", "@yadimon/llm-clash", "--help"], {
    cwd: tempDir,
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    process.exit(result.status ?? 1);
  }

  if (!result.stdout.includes("Usage: llm-clash")) {
    process.stderr.write("Published npx smoke did not print the expected help output.\n");
    process.stdout.write(result.stdout);
    process.exit(1);
  }

  process.stdout.write(result.stdout);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
