import { spawnSync } from "node:child_process";

const level = process.argv[2];
if (!["patch", "minor", "major"].includes(level)) {
  console.error("Usage: node scripts/release.mjs <patch|minor|major>");
  process.exit(1);
}

run("npm", ["run", "check"]);
run("npm", ["version", level]);
run("git", ["push", "origin", "HEAD", "--follow-tags"]);

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
