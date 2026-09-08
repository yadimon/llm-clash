import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "@yadimon/llm-clash";
const requested = process.env.SMOKE_PUBLISHED_VERSION ?? "latest";
if (!/^(latest|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(requested)) {
  throw new Error("SMOKE_PUBLISHED_VERSION must be latest or an exact version");
}

function run(command, args, cwd) {
  if (command === "npm" && args.some((arg) => !/^[\w@./+-]+$/.test(arg))) {
    throw new Error("Unexpected npm argument");
  }
  const windowsNpm = process.platform === "win32" && command === "npm";
  const result = spawnSync(
    windowsNpm ? (process.env.ComSpec ?? "cmd.exe") : command,
    windowsNpm ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args,
    {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
}

// Resolve once, then install an exact version in a fresh consumer project.
const version = JSON.parse(
  run("npm", ["view", `${packageName}@${requested}`, "version", "--json"])
);
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Invalid registry version");
const tempDir = mkdtempSync(join(tmpdir(), "llm-clash-published-"));
try {
  writeFileSync(join(tempDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--engine-strict",
      "--no-audit",
      "--no-fund",
      `${packageName}@${version}`
    ],
    tempDir
  );
  const installed = JSON.parse(
    readFileSync(join(tempDir, "node_modules/@yadimon/llm-clash/package.json"), "utf8")
  );
  if (installed.version !== version)
    throw new Error(`Expected ${version}; installed ${installed.version}`);
  const cli = join(tempDir, "node_modules/@yadimon/llm-clash", installed.bin["llm-clash"]);
  if (!run(process.execPath, [cli, "--help"], tempDir).includes("Usage: llm-clash"))
    throw new Error("CLI help missing");
  const reported = run(process.execPath, [cli, "--version"], tempDir).trim();
  if (reported !== version) throw new Error(`CLI reported ${reported}; expected ${version}`);
  console.log(`Published smoke passed: ${packageName}@${version}, ${process.version}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
