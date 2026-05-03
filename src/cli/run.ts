#!/usr/bin/env node
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

type FileConfig = Omit<RunConfig, "models"> & {
  models: Array<string | CliModelConfig>;
};

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

loadDotEnv();

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
          typeof model === "string"
            ? adapterFromSpec(model, specOptions(options))
            : adapterFromConfig(model, specOptions(options))
        ),
        ...(options.save !== undefined ? { saveArtifacts: options.save } : {}),
        onEvent: options.quiet ? undefined : logEvent
      });
    }
  );

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

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
      model: config.model ?? config.id.replace(/^anthropic:/, ""),
      apiKey: resolveApiKey(config, "ANTHROPIC_API_KEY", options.anthropicApiKey)
    });
  }

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

function providerModel(id: string): string {
  return id.replace(/^(openai|openrouter|google):/, "");
}

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

function defaultApiKeyEnv(id: string): string {
  if (id.startsWith("openrouter:")) {
    return "OPENROUTER_API_KEY";
  }
  if (id.startsWith("google:")) {
    return "GOOGLE_API_KEY";
  }
  return "OPENAI_API_KEY";
}

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

function specOptions(options: { openrouterApiKey?: string | undefined }): ModelSpecOptions {
  return { openrouterApiKey: options.openrouterApiKey };
}

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

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected integer, got ${value}.`);
  }
  return parsed;
}

function parseFinalMode(value: string): FinalMode {
  if (value === "choose_best" || value === "synthesize" || value === "choose_or_synthesize") {
    return value;
  }
  throw new Error(`Invalid final mode: ${value}.`);
}
