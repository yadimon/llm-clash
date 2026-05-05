import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const expectedVersion = packageJson.version;

const result = spawnSync("node", ["dist/cli/run.js", "--version"], {
  encoding: "utf8",
  shell: process.platform === "win32"
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}

const actualVersion = result.stdout.trim();
if (actualVersion !== expectedVersion) {
  process.stderr.write(
    `CLI version mismatch: expected ${expectedVersion}, got ${actualVersion || "<empty>"}.\n`
  );
  process.exit(1);
}

console.log(`CLI version matches package.json: ${actualVersion}`);
