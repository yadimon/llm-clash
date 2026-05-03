import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const groups = {
  core: "examples/smoke/local-agents-core.yaml",
  "gemini-opencode": "examples/smoke/local-agents-gemini-opencode.yaml"
};

loadDotEnv();

const requestedGroup = process.argv[2] ?? "all";
const selectedGroups =
  requestedGroup === "all" ? Object.entries(groups) : [[requestedGroup, groups[requestedGroup]]];

for (const [name, configPath] of selectedGroups) {
  if (!configPath) {
    console.error(`Unknown smoke group: ${name}`);
    process.exitCode = 1;
    continue;
  }

  const config = YAML.parse(readFileSync(configPath, "utf8"));
  const runnableModels = config.models.filter((model) => isModelRunnable(model));
  const skippedModels = config.models.filter((model) => !isModelRunnable(model));

  for (const model of skippedModels) {
    console.error(`[smoke:${name}] skipping ${model}: required local command is not on PATH`);
  }

  if (runnableModels.length === 0) {
    console.error(`[smoke:${name}] no runnable models found`);
    process.exitCode = 1;
    continue;
  }

  const tempDir = mkdtempSync(join(tmpdir(), `llm-clash-${name}-`));
  const tempConfig = join(tempDir, "config.yaml");
  writeFileSync(tempConfig, YAML.stringify({ ...config, models: runnableModels }), "utf8");

  console.error(`[smoke:${name}] running ${runnableModels.join(", ")}`);
  const result = spawnSync("node", ["dist/cli/run.js", "run", tempConfig, "--quiet", "--save"], {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  rmSync(tempDir, { recursive: true, force: true });

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

function isModelRunnable(model) {
  if (model.startsWith("openrouter:")) {
    return Boolean(process.env.OPENROUTER_API_KEY);
  }
  const command = commandForModel(model);
  return command ? hasCommand(command) : true;
}

function commandForModel(model) {
  if (model.startsWith("claude-code:") || model.startsWith("claude:")) {
    return "claude";
  }
  if (model.startsWith("codex:")) {
    return "codex";
  }
  if (model.startsWith("gemini-cli:") || model.startsWith("gemini:")) {
    return "gemini";
  }
  if (model.startsWith("opencode:") || model.startsWith("open-code:")) {
    return "opencode";
  }
  return undefined;
}

function hasCommand(command) {
  const probe =
    process.platform === "win32"
      ? spawnSync("where.exe", [command], { stdio: "ignore" })
      : spawnSync("command", ["-v", command], { stdio: "ignore", shell: true });
  return probe.status === 0;
}

function loadDotEnv() {
  if (!existsSync(".env")) {
    return;
  }

  const raw = readFileSync(".env", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
