import { anthropic } from "../adapters/anthropic.js";
import { commandAdapter } from "../adapters/commandAdapter.js";
import { openaiCompatible } from "../adapters/openaiCompatible.js";
import type { ModelAdapter } from "../core/types.js";

export type ModelSpecOptions = {
  openrouterApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  anthropicApiKey?: string | undefined;
  googleApiKey?: string | undefined;
};

type ParsedLocalSpec = {
  model: string;
  effort?: string | undefined;
};

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
    return openaiCompatible({
      id: spec,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: options.googleApiKey ?? process.env.GOOGLE_API_KEY,
      model: spec.slice("google:".length)
    });
  }

  if (spec.startsWith("command:")) {
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

function claudeCodeAdapter(spec: string): ModelAdapter {
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

function useShellForLocalCli(): boolean {
  return process.platform === "win32";
}

function parseLocalSpec(value: string): ParsedLocalSpec {
  const effortMatch = value.match(/^(.*?)-(low|medium|high|xhigh|max)$/i);
  if (effortMatch?.[1] && effortMatch[2]) {
    return { model: effortMatch[1], effort: effortMatch[2] };
  }
  return { model: value };
}

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
