// ---------------------------------------------------------------------------
// Sub-process command adapter.
//
// Wraps any local CLI (claude, codex, gemini, opencode, llama.cpp, etc.) so
// it can act as a `ModelAdapter`. The adapter spawns the process, hands it
// the prompt via the configured `inputMode`, captures stdout, and returns
// it as the model output.
//
// Four input modes:
//
//   - `stdin`     – pipe the prompt to the child's stdin. The most common
//                   choice; used by `codex`, `gemini --prompt -`, etc.
//   - `arg`       – append the prompt as an argument, OR substitute it into
//                   args that contain `{prompt}`. Used by `opencode run … {prompt}`.
//   - `tempfile`  – write the prompt to a temp file and pass the file path
//                   in args (substituting `{file}` or `{input}` if present,
//                   else appending). Used by CLIs that only accept file inputs.
//   - `file`      – alias for `tempfile`.
//
// All sub-processes get a `timeoutMs` budget (default 10 minutes) and respect
// `ModelInput.signal` for cooperative cancellation.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

/**
 * Adapter configuration. Most fields are optional and have sensible defaults
 * — see the module header for the meaning of each `inputMode`.
 *
 * - `shell` – pass `true` to run the command through the shell (needed on
 *             Windows for some CLIs that ship as `.cmd`/`.bat` shims; the
 *             llm-clash CLI flips this on automatically for known local
 *             agents on win32).
 * - `env`   – merged on top of `process.env` for the child process.
 */
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

/**
 * Build a sub-process `ModelAdapter`.
 *
 * Two call shapes:
 *   - `commandAdapter("llama")`                      – id and command both
 *                                                       set to "llama".
 *   - `commandAdapter("llama", ["--model", "x"])`    – same, with extra args.
 *   - `commandAdapter({ id, command, args, … })`     – full configuration.
 *
 * On every `generate()` we re-prepare the args/stdin/tempfile (so each
 * call gets a fresh tempfile) and reliably clean up afterwards via the
 * `try/finally` that removes any tempdir we created.
 */
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
          timeoutMs: normalized.timeoutMs ?? 600_000,
          signal: input.signal
        });
        return { text };
      } finally {
        // Always remove the tempfile dir, even if the command crashed.
        if (prepared.cleanupDir) {
          await rm(prepared.cleanupDir, { recursive: true, force: true });
        }
      }
    }
  };
}

/**
 * Build the per-call args/stdin payload for the sub-process.
 *
 * The function returns:
 *   - `args`         – final argument array to spawn with.
 *   - `stdin`        – payload to pipe (only set for `inputMode: "stdin"`).
 *   - `cleanupDir`   – temp directory to delete after the call (only set
 *                      for `tempfile`/`file` modes).
 *
 * If the input has a `system` portion, it is prepended to the user prompt
 * separated by two newlines — most CLIs do not understand multi-message
 * formats, so we collapse them into a single text payload.
 */
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
    // Substitute `{prompt}` if it appears anywhere in the args; otherwise
    // either append after the configured `inputFlag` (e.g. `-p <prompt>`)
    // or append the prompt as the final positional argument.
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

  // tempfile / file mode: write the prompt to disk and substitute the path.
  const dir = await mkdtemp(join(tmpdir(), "multidraft-"));
  const promptFile = join(dir, "prompt.txt");
  await writeFile(promptFile, fullPrompt, "utf8");
  const placeholder = config.filePlaceholder ?? DEFAULT_FILE_PLACEHOLDER;
  // We accept `{input}` AND the configurable placeholder (default `{file}`)
  // — the former is a common older convention from CLI tools.
  const replacedArgs = args.map((arg) =>
    arg.replaceAll("{input}", promptFile).replaceAll(placeholder, promptFile)
  );
  const replaced = args.some((arg) => arg.includes("{input}") || arg.includes(placeholder));
  if (!replaced) {
    replacedArgs.push(promptFile);
  }

  return { args: replacedArgs, cleanupDir: dir };
}

/**
 * Spawn the child process and resolve with trimmed stdout when it exits 0.
 *
 * Reject conditions (mutually exclusive — `settled` guards against double
 * resolution if more than one fires):
 *   - `signal` aborted before spawn or while running
 *   - `timeoutMs` elapsed
 *   - spawn-time error (ENOENT, etc.)
 *   - child exited with a non-zero code (stderr is included in the message)
 *
 * stdout is trimmed because most CLIs append a trailing newline; we don't
 * want that bleeding into the orchestrator's draft text.
 */
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
      // Merge caller env on top of the parent process env so child inherits
      // PATH, HOME, etc. while still being able to override anything.
      env: { ...process.env, ...input.env },
      shell: input.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    // `settled` ensures only the first terminal event (timeout / abort /
    // error / close) reaches the caller — without it a process that times
    // out and then exits would resolve twice.
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
        // Surface stderr verbatim — local agents almost always emit useful
        // diagnostics (auth issues, model name mistakes, etc.) there.
        reject(new Error(`Command failed with exit code ${code}: ${input.command}\n${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });

    if (input.stdin !== undefined) {
      child.stdin.end(input.stdin);
    } else {
      // Always close stdin — some CLIs hang waiting for EOF if we don't.
      child.stdin.end();
    }
  });
}
