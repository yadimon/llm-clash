import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

export type CommandAdapterConfig = {
  id: string;
  label?: string | undefined;
  command: string;
  args?: string[] | undefined;
  inputMode?: "stdin" | "tempfile" | "file" | "arg" | undefined;
  inputFlag?: string | undefined;
  promptPlaceholder?: string | undefined;
  filePlaceholder?: string | undefined;
  timeoutMs?: number | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  shell?: boolean | undefined;
};

const DEFAULT_PROMPT_PLACEHOLDER = "{prompt}";
const DEFAULT_FILE_PLACEHOLDER = "{file}";

export function commandAdapter(
  config: CommandAdapterConfig | string,
  args: string[] = []
): ModelAdapter {
  const normalized =
    typeof config === "string"
      ? {
          id: config,
          command: config,
          args
        }
      : config;

  return {
    id: normalized.id,
    label: normalized.label,
    async generate(input: ModelInput): Promise<ModelOutput> {
      const prepared = await prepareCommand(normalized, input);
      try {
        const text = await runCommand({
          command: normalized.command,
          args: prepared.args,
          stdin: prepared.stdin,
          cwd: normalized.cwd,
          env: normalized.env,
          shell: normalized.shell,
          timeoutMs: normalized.timeoutMs ?? 120_000,
          signal: input.signal
        });
        return { text };
      } finally {
        if (prepared.cleanupDir) {
          await rm(prepared.cleanupDir, { recursive: true, force: true });
        }
      }
    }
  };
}

async function prepareCommand(
  config: CommandAdapterConfig,
  input: ModelInput
): Promise<{ args: string[]; stdin?: string; cleanupDir?: string }> {
  const fullPrompt = input.system ? `${input.system}\n\n${input.prompt}` : input.prompt;
  const inputMode = config.inputMode ?? "stdin";
  const args = [...(config.args ?? [])];

  if (inputMode === "stdin") {
    return { args, stdin: fullPrompt };
  }

  if (inputMode === "arg") {
    const placeholder = config.promptPlaceholder ?? DEFAULT_PROMPT_PLACEHOLDER;
    const replacedArgs = args.map((arg) => arg.replaceAll(placeholder, fullPrompt));
    const replaced = args.some((arg) => arg.includes(placeholder));
    if (config.inputFlag) {
      replacedArgs.push(config.inputFlag, fullPrompt);
    } else if (!replaced) {
      replacedArgs.push(fullPrompt);
    }
    return { args: replacedArgs };
  }

  const dir = await mkdtemp(join(tmpdir(), "multidraft-"));
  const promptFile = join(dir, "prompt.txt");
  await writeFile(promptFile, fullPrompt, "utf8");
  const placeholder = config.filePlaceholder ?? DEFAULT_FILE_PLACEHOLDER;
  const replacedArgs = args.map((arg) =>
    arg.replaceAll("{input}", promptFile).replaceAll(placeholder, promptFile)
  );
  const replaced = args.some((arg) => arg.includes("{input}") || arg.includes(placeholder));
  if (!replaced) {
    replacedArgs.push(promptFile);
  }

  return { args: replacedArgs, cleanupDir: dir };
}

function runCommand(input: {
  command: string;
  args: string[];
  stdin?: string | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  shell?: boolean | undefined;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error(`Command aborted before start: ${input.command}`));
      return;
    }

    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      shell: input.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`Command timed out after ${input.timeoutMs}ms: ${input.command}`));
    }, input.timeoutMs);
    const abortListener = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(new Error(`Command aborted: ${input.command}`));
    };
    input.signal?.addEventListener("abort", abortListener, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortListener);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortListener);
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}: ${input.command}\n${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });

    if (input.stdin !== undefined) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }
  });
}
