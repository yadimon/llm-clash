import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tarballs = readdirSync("packed").filter((file) => file.endsWith(".tgz"));
assert.equal(tarballs.length, 1, "packed/ must contain exactly one npm tarball");
const dir = mkdtempSync(join(tmpdir(), "llm-clash-consumer-"));
try {
  // Put the path in JSON instead of interpolating it into a shell command.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@yadimon/llm-clash": pathToFileURL(resolve("packed", tarballs[0])).href
      }
    })
  );
  const npmArgs = ["install", "--ignore-scripts", "--engine-strict", "--no-audit", "--no-fund"];
  execFileSync(
    process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm",
    process.platform === "win32" ? ["/d", "/s", "/c", `npm ${npmArgs.join(" ")}`] : npmArgs,
    {
      cwd: dir,
      stdio: "inherit",
      timeout: 180_000
    }
  );
  const root = join(dir, "node_modules/@yadimon/llm-clash");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const cli = join(root, pkg.bin["llm-clash"]);
  const invoke = (args) =>
    execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  assert.match(invoke(["--help"]), /Usage: llm-clash/);
  assert.equal(invoke(["--version"]).trim(), pkg.version);
  const api = await import(pathToFileURL(join(root, pkg.main)).href);
  assert.ok(Object.keys(api).length > 0, "library exports missing");
  console.log(`Packed consumer passed: ${pkg.version}, ${process.version}`);
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
