#!/usr/bin/env node
// ---------------------------------------------------------------------------
// llm-clash CLI entrypoint.
//
// Three usage modes (subcommands):
//
//   1. DEFAULT (positional):
//        llm-clash <model-spec> [<model-spec>...] "<task>"
//      Last positional is the task; everything before it is a list of
//      model specs (see `./modelSpec.ts` for the spec syntax).
//
//   2. `refine` subcommand — same thing but with explicit flags:
//        llm-clash refine --task "..." --models openai:gpt-4.1 anthropic:opus
//
//   3. `run` subcommand — load everything from a YAML file:
//        llm-clash run config.yaml
//      The YAML file mirrors `RunConfig` and lets you describe each model
//      either as a spec string OR as a fully detailed `CliModelConfig`
//      object (custom command, custom HTTP base URL, etc.).
//
// All three modes funnel into `runMultiDraftRefinement` from the core
// orchestrator, then print the aggregated scores and the final answer.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import YAML from "yaml";
import { anthropic } from "../adapters/anthropic.js";
import { commandAdapter } from "../adapters/commandAdapter.js";
import { openaiCompatible } from "../adapters/openaiCompatible.js";
import { runMultiDraftRefinement } from "../core/orchestrator.js";
import type { FinalMode, ModelAdapter, RunConfig, RunEvent } from "../core/types.js";
import { adapterFromSpec, type ModelSpecOptions } from "./modelSpec.js";

/**
 * Per-model object inside a YAML config file.
 *
 * If `command` is set (or `type === "command"`) we build a sub-process
 * adapter; otherwise we choose between `anthropic` and `openaiCompatible`
 * based on the spec prefix in `id`.
 *
 * `apiKey` and `apiKeyEnv` are mutually informative: the explicit value
 * wins, otherwise we look up the env var named by `apiKeyEnv` (or the
 * provider default for the prefix in `id`).
 */
type CliModelConfig = {
  id: string;
  label?: string | undefined;
  type?: "openai-compatible" | "anthropic" | "command" | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  apiKeyEnv?: string | undefined;
  model?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  inputMode?: "stdin" | "tempfile" | "file" | "arg" | undefined;
  inputFlag?: string | undefined;
  promptPlaceholder?: string | undefined;
  filePlaceholder?: string | undefined;
  timeoutMs?: number | undefined;
  shell?: boolean | undefined;
};

/**
 * Shape of a YAML config file — same as `RunConfig` except `models` accepts
 * either a spec string OR the more detailed `CliModelConfig` object.
 */
type FileConfig = Omit<RunConfig, "models"> & {
  models: Array<string | CliModelConfig>;
};

/**
 * Flags shared between the default subcommand and the `refine` subcommand.
 * Kept as a single type so `configFromSharedOptions` can convert in one go.
 */
type SharedCliOptions = {
  rounds?: number | undefined;
  final?: FinalMode | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  selfScoreWeight?: number | undefined;
  peerScoreWeight?: number | undefined;
  save?: boolean | undefined;
  output?: string | undefined;
  quiet?: boolean | undefined;
  openrouterApiKey?: string | undefined;
};

const program = new Command();

// Load `.env` ourselves so we don't take a hard dep on dotenv. Must run
// BEFORE we read any env-derived defaults below.
loadDotEnv();

// --- Default subcommand: positional model specs + final task --------------
program
  .name("llm-clash")
  .description("Run text-only multi-draft iterative refinement.")
  .version("0.1.0")
  .argument("[items...]", "Model specs followed by the task text")
  .option("--rounds <rounds>", "Number of refinement rounds", parseInteger)
  .option(
    "--final <mode>",
    "Final mode: choose_best, synthesize, choose_or_synthesize",
    parseFinalMode
  )
  .option("--temperature <temperature>", "Temperature", Number.parseFloat)
  .option("--max-tokens <tokens>", "Maximum output tokens", parseInteger)
  .option("--self-score-weight <weight>", "Weight for self-evaluation scores", Number.parseFloat)
  .option("--peer-score-weight <weight>", "Weight for cross-evaluation scores", Number.parseFloat)
  .option("--save", "Save run artifacts", true)
  .option("--no-save", "Do not save run artifacts")
  .option("--output <dir>", "Output directory")
  .option("--openrouter-api-key <key>", "OpenRouter API key for openrouter:* model specs")
  .option("--quiet", "Suppress progress logging")
  .action(async (items: string[], options: SharedCliOptions) => {
    if (items.length === 0) {
      program.help();
    }
    if (items.length < 2) {
      throw new Error(
        'Expected at least one model spec and a task, for example: llm-clash codex:gpt-5.4-mini-low "Make a plan."'
      );
    }

    // Last positional is the task; everything before it is a model spec.
    const task = items[items.length - 1];
    const modelSpecs = items.slice(0, -1);
    if (!task) {
      throw new Error("Task text is required.");
    }

    await runAndPrint({
      ...configFromSharedOptions(options),
      task,
      models: modelSpecs.map((spec) => adapterFromSpec(spec, specOptions(options))),
      onEvent: options.quiet ? undefined : logEvent
    });
  });

// --- `refine` subcommand: same thing, but with explicit flags -------------
program
  .command("refine")
  .description("Run refinement from CLI flags.")
  .requiredOption("--task <task>", "Task to answer")
  .requiredOption(
    "--models <models...>",
    "Model specs such as openai:gpt-4.1 or openrouter:anthropic/claude"
  )
  .option("--rounds <rounds>", "Number of refinement rounds", parseInteger)
  .option(
    "--final <mode>",
    "Final mode: choose_best, synthesize, choose_or_synthesize",
    parseFinalMode
  )
  .option("--temperature <temperature>", "Temperature", Number.parseFloat)
  .option("--max-tokens <tokens>", "Maximum output tokens", parseInteger)
  .option("--self-score-weight <weight>", "Weight for self-evaluation scores", Number.parseFloat)
  .option("--peer-score-weight <weight>", "Weight for cross-evaluation scores", Number.parseFloat)
  .option("--save", "Save run artifacts", true)
  .option("--no-save", "Do not save run artifacts")
  .option("--output <dir>", "Output directory")
  .option("--openrouter-api-key <key>", "OpenRouter API key for openrouter:* model specs")
  .option("--quiet", "Suppress progress logging")
  .action(async (options: SharedCliOptions & { task: string; models: string[] }) => {
    await runAndPrint({
      ...configFromSharedOptions(options),
      task: options.task,
      models: options.models.map((spec) => adapterFromSpec(spec, specOptions(options))),
      onEvent: options.quiet ? undefined : logEvent
    });
  });

// --- `run` subcommand: load entire RunConfig from a YAML file -------------
program
  .command("run")
  .description("Run refinement from a YAML config file.")
  .argument("<config>", "Path to YAML config")
  .option("--save", "Save run artifacts")
  .option("--no-save", "Do not save run artifacts")
  .option("--openrouter-api-key <key>", "OpenRouter API key for openrouter:* model specs")
  .option("--quiet", "Suppress progress logging")
  .action(
    async (
      configPath,
      options: { save?: boolean; quiet?: boolean; openrouterApiKey?: string | undefined }
    ) => {
      const raw = await readFile(configPath, "utf8");
      const parsed = YAML.parse(raw) as FileConfig;
      await runAndPrint({
        ...parsed,
        models: parsed.models.map((model) =>
          // Strings → spec parser; objects → richer per-field builder.
          typeof model === "string"
            ? adapterFromSpec(model, specOptions(options))
            : adapterFromConfig(model, specOptions(options))
        ),
        // Only override `saveArtifacts` when the flag was set on the CLI;
        // otherwise let the YAML decide.
        ...(options.save !== undefined ? { saveArtifacts: options.save } : {}),
        onEvent: options.quiet ? undefined : logEvent
      });
    }
  );

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  // Exit code 1 so shell scripts can detect failures.
  process.exitCode = 1;
});

/**
 * Run the full pipeline and print a human-friendly summary to stdout.
 *
 * Output structure:
 *   - `Output directory: …`            (if artifacts were saved)
 *   - `Winner: <draft id>`             (if one exists)
 *   - Aggregated score table
 *   - The final answer text
 */
async function runAndPrint(config: RunConfig): Promise<void> {
  const result = await runMultiDraftRefinement(config);
  if (result.outputDir) {
    console.log(`Output directory: ${result.outputDir}`);
  }
  if (result.winner) {
    console.log(`Winner: ${result.winner.id}`);
  }
  console.log("\nAggregated scores:");
  for (const candidate of result.aggregatedEvaluation.candidates) {
    console.log(`- ${candidate.candidateId} (${candidate.modelId}): ${candidate.weightedTotal}`);
  }
  console.log("\nFinal answer:\n");
  console.log(result.finalAnswer);
}

/**
 * Default `onEvent` listener — pretty-prints pipeline progress to STDERR
 * (so it can be separated from the final answer on stdout when piping).
 *
 * Disabled by `--quiet`.
 */
function logEvent(event: RunEvent): void {
  switch (event.type) {
    case "round_start":
      console.error(`[round ${event.round}] starting`);
      break;
    case "draft_created":
      console.error(`  [draft] ${event.draft.modelId} round=${event.draft.round}`);
      break;
    case "round_complete":
      console.error(`[round ${event.round}] complete (${event.drafts.length} drafts)`);
      break;
    case "evaluation_start":
      console.error(`[eval] judge=${event.judgeModelId}`);
      break;
    case "evaluation_complete":
      console.error(`[eval] judge=${event.result.judgeModelId} done`);
      break;
    case "synthesis_start":
      console.error("[synthesis] generating final answer");
      break;
    case "artifacts_saved":
      console.error(`[artifacts] ${event.outputDir}`);
      break;
    case "run_complete":
      console.error(`[done] winner=${event.winner ?? "n/a"}`);
      break;
  }
}

/**
 * Convert one YAML `CliModelConfig` entry into a real `ModelAdapter`.
 *
 * Resolution rules:
 *   1. `type === "command"` (or any `command` value present) → `commandAdapter`.
 *   2. `type === "anthropic"` or `id` starts with `anthropic:` → `anthropic`.
 *   3. `id` starts with `openrouter:` and no key is configured → require an
 *      OpenRouter key from CLI flag or env, fail fast if missing.
 *   4. Everything else → `openaiCompatible`, with the right default base URL
 *      and env var per provider prefix (`openai:`, `openrouter:`, `google:`).
 */
function adapterFromConfig(config: CliModelConfig, options: ModelSpecOptions = {}): ModelAdapter {
  if (config.type === "command" || config.command) {
    if (!config.command) {
      throw new Error(`Command model ${config.id} requires command.`);
    }
    return commandAdapter({
      id: config.id,
      label: config.label,
      command: config.command,
      args: config.args,
      inputMode: config.inputMode,
      inputFlag: config.inputFlag,
      promptPlaceholder: config.promptPlaceholder,
      filePlaceholder: config.filePlaceholder,
      timeoutMs: config.timeoutMs,
      shell: config.shell
    });
  }

  if (config.type === "anthropic" || config.id.startsWith("anthropic:")) {
    return anthropic({
      id: config.id,
      label: config.label,
      // If the YAML didn't provide an explicit model, derive it from the id
      // by stripping the `anthropic:` prefix.
      model: config.model ?? config.id.replace(/^anthropic:/, ""),
      apiKey: resolveApiKey(config, "ANTHROPIC_API_KEY", options.anthropicApiKey)
    });
  }

  // Fail-fast for OpenRouter when no key is reachable — would otherwise
  // produce a confusing 401 from the upstream API at request time.
  if (config.id.startsWith("openrouter:") && !config.apiKey && !config.apiKeyEnv) {
    const apiKey = options.openrouterApiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is required for openrouter:* models. Set it in the environment or pass --openrouter-api-key <key>."
      );
    }
  }

  return openaiCompatible({
    id: config.id,
    label: config.label,
    baseUrl: config.baseUrl,
    apiKey: resolveApiKey(
      config,
      defaultApiKeyEnv(config.id),
      defaultApiKeyValue(config.id, options)
    ),
    model: config.model ?? providerModel(config.id)
  });
}

/** Strip the `<provider>:` prefix from an id so we get the bare model name. */
function providerModel(id: string): string {
  return id.replace(/^(openai|openrouter|google):/, "");
}

/**
 * API key resolution order:
 *   1. Explicit `config.apiKey` from the YAML wins.
 *   2. CLI flag value (`fallbackValue`) wins next.
 *   3. Otherwise pull from `process.env[config.apiKeyEnv ?? fallbackEnv]`.
 *
 * Returning undefined is fine — the underlying adapter decides whether the
 * key is required (Anthropic does, OpenAI-compatible doesn't always).
 */
function resolveApiKey(
  config: CliModelConfig,
  fallbackEnv: string,
  fallbackValue?: string | undefined
): string | undefined {
  if (config.apiKey) {
    return config.apiKey;
  }
  return fallbackValue ?? process.env[config.apiKeyEnv ?? fallbackEnv];
}

/** Pick the conventional env var name to look up for a given id prefix. */
function defaultApiKeyEnv(id: string): string {
  if (id.startsWith("openrouter:")) {
    return "OPENROUTER_API_KEY";
  }
  if (id.startsWith("google:")) {
    return "GOOGLE_API_KEY";
  }
  return "OPENAI_API_KEY";
}

/** Pick the corresponding CLI-provided key (if any) for a given id prefix. */
function defaultApiKeyValue(id: string, options: ModelSpecOptions): string | undefined {
  if (id.startsWith("openrouter:")) {
    return options.openrouterApiKey;
  }
  if (id.startsWith("google:")) {
    return options.googleApiKey;
  }
  if (id.startsWith("anthropic:")) {
    return options.anthropicApiKey;
  }
  return options.openaiApiKey;
}

/** Subset of CLI options forwarded into `adapterFromSpec`. */
function specOptions(options: { openrouterApiKey?: string | undefined }): ModelSpecOptions {
  return { openrouterApiKey: options.openrouterApiKey };
}

/** Map shared CLI flags onto the matching `RunConfig` fields. */
function configFromSharedOptions(options: SharedCliOptions): Partial<RunConfig> {
  return {
    rounds: options.rounds,
    finalMode: options.final,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    selfScoreWeight: options.selfScoreWeight,
    peerScoreWeight: options.peerScoreWeight,
    saveArtifacts: options.save,
    outputDir: options.output
  };
}

/**
 * Minimal `.env` loader (no dotenv dependency).
 *
 * Reads `<cwd>/.env`, parses one `KEY=value` per line, and writes any keys
 * NOT already present on `process.env`. Existing env vars win — that means
 * a shell-exported value overrides whatever sits in the file.
 *
 * Quirks worth knowing:
 *   - Lines starting with `#` and blank lines are skipped.
 *   - Surrounding single OR double quotes are stripped.
 *   - Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`; junk keys are skipped.
 *   - The file is read SYNCHRONOUSLY at startup so the rest of the
 *     program can rely on env vars being populated.
 */
function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, "utf8");
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
    let value = trimmed.slice(separator + 1).trim();
    // Reject malformed keys and respect already-set env vars.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) {
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** Commander option parser that rejects non-integer input. */
function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected integer, got ${value}.`);
  }
  return parsed;
}

/** Commander option parser that validates `--final` against the FinalMode union. */
function parseFinalMode(value: string): FinalMode {
  if (value === "choose_best" || value === "synthesize" || value === "choose_or_synthesize") {
    return value;
  }
  throw new Error(`Invalid final mode: ${value}.`);
}
