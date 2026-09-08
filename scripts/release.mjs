import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function execute(command, args, capture = false) {
  const windowsNpm = process.platform === "win32" && command === "npm";
  const result = spawnSync(
    windowsNpm ? (process.env.ComSpec ?? "cmd.exe") : command,
    windowsNpm ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args,
    {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} exited ${result.status}`);
  return result.stdout?.trim() ?? "";
}

export function release(
  level,
  {
    run = (command, args) => execute(command, args),
    capture = (args) => execute("git", args, true),
    readVersion = () => JSON.parse(readFileSync("package.json", "utf8")).version
  } = {}
) {
  if (!["patch", "minor", "major"].includes(level))
    throw new Error("Expected patch, minor or major");
  if (capture(["branch", "--show-current"]) !== "main")
    throw new Error("Release must start on main");
  if (capture(["status", "--porcelain"])) throw new Error("Release requires a clean working tree");
  run("git", ["fetch", "origin", "main", "--quiet"]);
  if (capture(["rev-parse", "HEAD"]) !== capture(["rev-parse", "origin/main"]))
    throw new Error("Main differs from origin/main");
  run("npm", ["run", "check"]);
  run("npm", ["version", level, "--no-git-tag-version"]);
  const version = readVersion();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Unexpected release version");
  const tag = `v${version}`;
  run("git", ["add", "--", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `chore(release): ${tag}`]);
  run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
  run("git", ["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    release(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
