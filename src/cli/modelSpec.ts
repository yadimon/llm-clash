// ---------------------------------------------------------------------------
// Model spec parser for the CLI.
//
// On the command line, each model is specified as a SHORT STRING with a
// provider prefix, for example:
//
//   openai:gpt-4.1
//   openrouter:anthropic/claude-3.5-sonnet
//   anthropic:claude-haiku-4-5
//   google:gemini-2.5-pro
//   command:my-id:python:run.py
//
// Local agent CLIs have dedicated prefixes that build the right
// `commandAdapter` config under the hood:
//
//   claude-code:opus              → spawns `claude --print --model opus …`
//   claude:opus-high              → same, with reasoning effort flag
//   codex:gpt-5.3-medium          → spawns `codex exec …` with reasoning effort
//   gemini-cli:flash              → spawns `gemini --model gemini-2.5-flash …`
//   opencode:anthropic/sonnet     → spawns `opencode run --model …`
//
// Each prefix maps to one of the underlying adapters (`anthropic`,
// `openaiCompatible`, or `commandAdapter`) and applies sensible defaults
// for that provider.
// ---------------------------------------------------------------------------

import { anthropic } from "../adapters/anthropic.js";
import { commandAdapter } from "../adapters/commandAdapter.js";
import { openaiCompatible } from "../adapters/openaiCompatible.js";
import type { ModelAdapter } from "../core/types.js";

/**
 * API keys passed in via CLI flags.
 *
 * If a field is set here it overrides the corresponding environment
 * variable. The CLI exposes `--openrouter-api-key`; the others are kept on
 * the type so library users of `adapterFromSpec` can plug in keys
 * programmatically.
 */
export type ModelSpecOptions = {
  openrouterApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  anthropicApiKey?: string | undefined;
  googleApiKey?: string | undefined;
};

/**
 * Result of splitting a local-agent spec like `opus-high` into the model
 * portion and the optional reasoning-effort suffix.
 */
type ParsedLocalSpec = {
  model: string;
  effort?: string | undefined;
};

/**
 * Convert a CLI model spec string into a fully configured `ModelAdapter`.
 *
 * Dispatches by prefix; an unknown prefix throws because silently falling
 * back to (say) `openai:` would be confusing when the user typed `gpt:`.
 */
export function adapterFromSpec(spec: string, options: ModelSpecOptions = {}): ModelAdapter {
  if (spec.startsWith("claude-code:") || spec.startsWith("claude:")) {
    return claudeCodeAdapter(spec);
  }

  if (spec.startsWith("codex:")) {
    return codexAdapter(spec);
  }

  if (spec.startsWith("gemini-cli:") || spec.startsWith("gemini:")) {
    return geminiCliAdapter(spec);
  }

  if (spec.startsWith("opencode:") || spec.startsWith("open-code:")) {
    return openCodeAdapter(spec);
  }

  if (spec.startsWith("anthropic:")) {
    return anthropic({
      id: spec,
      model: spec.slice("anthropic:".length),
      apiKey: options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY
    });
  }

  if (spec.startsWith("openrouter:")) {
    // OpenRouter requires an API key — error early with a clear message
    // instead of failing later inside the HTTP call with a 401.
    const apiKey = options.openrouterApiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is required for openrouter:* models. Set it in the environment or pass --openrouter-api-key <key>."
      );
    }
    return openaiCompatible({
      id: spec,
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey,
      model: spec.slice("openrouter:".length)
    });
  }

  if (spec.startsWith("google:")) {
    // Google's Gemini API exposes an OpenAI-compatible endpoint at this URL.
    return openaiCompatible({
      id: spec,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: options.googleApiKey ?? process.env.GOOGLE_API_KEY,
      model: spec.slice("google:".length)
    });
  }

  if (spec.startsWith("command:")) {
    // Format: command:<id>:<command>[:arg…]   (colon-separated)
    const [, id, command, ...args] = spec.split(":");
    if (!id || !command) {
      throw new Error("Command specs must look like command:<id>:<command>[:arg...]");
    }
    return commandAdapter({ id, command, args });
  }

  if (spec.startsWith("openai:")) {
    return openaiCompatible({
      id: spec,
      apiKey: options.openaiApiKey ?? process.env.OPENAI_API_KEY,
      model: spec.slice("openai:".length)
    });
  }

  throw new Error(`Unknown model spec "${spec}".`);
}

/**
 * Build a `commandAdapter` that drives the official `claude` CLI in a
 * locked-down "headless inspector" mode.
 *
 * Flags chosen here:
 *   --print                          – batch mode (no interactive REPL)
 *   --output-format text             – stable plain-text stdout
 *   --no-session-persistence         – every call is independent
 *   --permission-mode dontAsk        – don't block on permission prompts
 *   --allowedTools Read,LS,Grep,Glob – read-only inspection of the cwd
 *
 * Reasoning effort is appended as `--effort` when the spec includes a
 * `-low / -medium / -high / -xhigh / -max` suffix (e.g. `opus-high`).
 */
function claudeCodeAdapter(spec: string): ModelAdapter {
  // Accept both "claude-code:" and short-form "claude:" prefixes.
  const parsed = parseLocalSpec(spec.replace(/^claude-code:/, "").replace(/^claude:/, ""));
  const args = [
    "--print",
    "--model",
    normalizeClaudeModel(parsed.model),
    "--output-format",
    "text",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Read,LS,Grep,Glob"
  ];
  if (parsed.effort) {
    args.push("--effort", normalizeEffort(parsed.effort));
  }

  return commandAdapter({
    id: spec,
    command: "claude",
    args,
    inputMode: "arg",
    timeoutMs: 180_000,
    shell: useShellForLocalCli()
  });
}

/**
 * Build a `commandAdapter` that drives the OpenAI Codex CLI in a sandboxed,
 * non-interactive mode suitable for batch invocation.
 *
 * The reasoning effort is set via `-c model_reasoning_effort="..."` (a
 * Codex-specific config override) instead of a dedicated flag.
 */
function codexAdapter(spec: string): ModelAdapter {
  const parsed = parseLocalSpec(spec.slice("codex:".length));
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--color",
    "never",
    "-c",
    'approval_policy="never"'
  ];
  // "default" means "let Codex pick the model" — don't override.
  if (parsed.model !== "default") {
    args.push("--model", normalizeCodexModel(parsed.model));
  }
  if (parsed.effort) {
    args.push("-c", `model_reasoning_effort="${normalizeEffort(parsed.effort)}"`);
  }

  return commandAdapter({
    id: spec,
    command: "codex",
    args,
    inputMode: "stdin",
    timeoutMs: 180_000,
    shell: useShellForLocalCli()
  });
}

/**
 * Build a `commandAdapter` that drives the Google `gemini` CLI.
 *
 * `--prompt -` tells the CLI to read the prompt from stdin; we use
 * `inputMode: "stdin"` to feed it. `--approval-mode plan` keeps the agent
 * from executing tools — we only want the text completion.
 */
function geminiCliAdapter(spec: string): ModelAdapter {
  const model = spec.replace(/^gemini-cli:/, "").replace(/^gemini:/, "");
  return commandAdapter({
    id: spec,
    command: "gemini",
    args: [
      "--model",
      normalizeGeminiModel(model),
      "--prompt",
      "-",
      "--output-format",
      "text",
      "--approval-mode",
      "plan"
    ],
    inputMode: "stdin",
    timeoutMs: 180_000,
    shell: useShellForLocalCli()
  });
}

/**
 * Build a `commandAdapter` that drives the `opencode` CLI.
 *
 * Permissions are locked down via the `OPENCODE_PERMISSION` env var so the
 * agent can read the workspace but cannot edit files or run shells. The
 * prompt is substituted into `{prompt}` in the args (inputMode "arg").
 */
function openCodeAdapter(spec: string): ModelAdapter {
  const model = spec.replace(/^opencode:/, "").replace(/^open-code:/, "");
  return commandAdapter({
    id: spec,
    command: "opencode",
    args: ["run", "--model", model, "{prompt}"],
    inputMode: "arg",
    timeoutMs: 180_000,
    env: {
      OPENCODE_PERMISSION: JSON.stringify({
        read: "allow",
        glob: "allow",
        grep: "allow",
        edit: "deny",
        bash: "deny"
      })
    },
    shell: useShellForLocalCli()
  });
}

/**
 * Local agent CLIs on Windows ship as `.cmd`/`.ps1` shims that only resolve
 * through `cmd.exe`. On POSIX the binaries are direct executables, so we
 * skip shell mode there to avoid the extra spawn layer (and quoting risks).
 */
function useShellForLocalCli(): boolean {
  return process.platform === "win32";
}

/**
 * Strip an optional reasoning-effort suffix (`-low`, `-medium`, `-high`,
 * `-xhigh`, `-max`) from a spec, returning the model name and the effort
 * separately. Examples:
 *   "opus"           → { model: "opus" }
 *   "opus-high"      → { model: "opus", effort: "high" }
 *   "gpt-5.3-codex"  → { model: "gpt-5.3-codex" }       (no match)
 */
function parseLocalSpec(value: string): ParsedLocalSpec {
  const effortMatch = value.match(/^(.*?)-(low|medium|high|xhigh|max)$/i);
  if (effortMatch?.[1] && effortMatch[2]) {
    return { model: effortMatch[1], effort: effortMatch[2] };
  }
  return { model: value };
}

/**
 * Map friendly Claude family names to the `--model` aliases the `claude`
 * CLI accepts. Unknown names pass through untouched so callers can pin to
 * a specific dated model.
 */
function normalizeClaudeModel(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("opus")) {
    return "opus";
  }
  if (normalized.startsWith("sonnet")) {
    return "sonnet";
  }
  if (normalized.startsWith("haiku")) {
    return "haiku";
  }
  return model;
}

/**
 * Normalize Codex model aliases — currently only fixes the `gpt5.3` /
 * `gpt-5.3` spelling variants. Anything else is forwarded as-is.
 */
function normalizeCodexModel(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized === "gpt5.3" || normalized === "gpt-5.3") {
    return "gpt-5.3";
  }
  if (normalized === "gpt5.3-codex" || normalized === "gpt-5.3-codex") {
    return "gpt-5.3-codex";
  }
  return model;
}

/**
 * Map short Gemini aliases (`flash`, `pro`) to their fully qualified
 * model ids. Anything else is forwarded as-is.
 */
function normalizeGeminiModel(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized === "flash") {
    return "gemini-2.5-flash";
  }
  if (normalized === "pro") {
    return "gemini-2.5-pro";
  }
  return model;
}

/**
 * Validate a reasoning-effort suffix and return it lowercased. Throws on
 * unknown values so a typo in `--effort xtreme` doesn't silently propagate
 * to the underlying CLI as a no-op.
 */
function normalizeEffort(effort: string): string {
  const normalized = effort.toLowerCase();
  if (normalized === "xhigh" || normalized === "max") {
    return normalized;
  }
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  throw new Error(`Unsupported effort "${effort}". Use low, medium, high, xhigh, or max.`);
}
