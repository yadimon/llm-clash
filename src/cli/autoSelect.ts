// ---------------------------------------------------------------------------
// Auto-selection of local-CLI models when the user runs llm-clash without
// specifying any model specs (e.g. `npx @yadimon/llm-clash "Plan ..."`).
//
// Flow:
//   1. Detect installed local CLIs in priority order.
//   2. If a saved preference still matches what's installed → use it silently.
//   3. Otherwise pick the top two by priority and ask for confirmation.
//   4. The user can accept once (Y), reject (n), or save the choice for
//      next time (s).
//   5. When stdin is not a TTY (CI, pipes), skip the prompt and proceed.
//
// API-only providers (openai/anthropic/openrouter/google) are NEVER chosen
// automatically — even if their API keys are in the environment. Auto-mode
// is opt-in for local agents only; explicit specs remain the way to use
// hosted APIs.
// ---------------------------------------------------------------------------

import { createInterface } from "node:readline/promises";
import { detectInstalledAgents, PRIORITY, type LocalAgentName } from "./detection.js";
import { loadPreferences, savePreferences } from "./preferences.js";

/** Spec strings for the auto-selected top model of each local agent. */
const TOP_SPEC_FOR_AGENT: Record<LocalAgentName, string> = {
  codex: "codex:gpt-5.5-high",
  "claude-code": "claude-code:claude-opus-4-7-high",
  "gemini-cli": "gemini-cli:flash",
  // No curated default for opencode — caller must error or prompt.
  opencode: ""
};

export type AutoSelectResult = {
  /** Spec strings ready to feed into `adapterFromSpec`. */
  specs: string[];
  /** True when the selection was loaded from saved preferences. */
  fromPreferences: boolean;
};

/**
 * Resolve a list of model specs without any explicit user input.
 *
 * Throws when fewer than two compatible CLIs are installed — the engine
 * needs at least two distinct adapters to do meaningful refinement.
 */
export async function autoSelectModels(): Promise<AutoSelectResult> {
  const installed = detectInstalledAgents();
  const saved = loadPreferences();

  // Reuse a saved selection only if every agent it references is still
  // installed; otherwise fall through to fresh detection.
  if (saved.defaultModels && saved.defaultModels.length >= 2) {
    const stillValid = saved.defaultModels.every((spec) =>
      installed.some((agent) => spec.startsWith(`${agent}:`) || matchesShortPrefix(spec, agent))
    );
    if (stillValid) {
      console.error(`[auto] using saved selection: ${saved.defaultModels.join(", ")}`);
      return { specs: saved.defaultModels, fromPreferences: true };
    }
  }

  if (installed.length < 2) {
    const found = installed.length === 0 ? "none" : `only ${installed[0]}`;
    throw new Error(
      `Auto-selection needs at least two local LLM CLIs installed; found ${found}. ` +
        "Install two of: claude, codex, gemini, opencode — or pass explicit specs " +
        "(e.g. cc codex)."
    );
  }

  // Top-2 by priority. `installed` is already sorted, but we filter out
  // opencode at the picking stage because it has no curated default and we
  // don't want to prompt for a model in the auto path. If picking opencode
  // is unavoidable (only opencode + one other installed), surface a clear
  // hint instead of guessing.
  const candidates = installed.filter((agent) => TOP_SPEC_FOR_AGENT[agent] !== "");
  if (candidates.length < 2) {
    throw new Error(
      "Auto-selection requires two CLIs with curated default models " +
        "(codex, claude-code, gemini-cli). opencode has too many models for a default — " +
        "pass an explicit spec like `opencode:<model>`."
    );
  }
  const picked = candidates.slice(0, 2);
  const specs = picked.map((agent) => TOP_SPEC_FOR_AGENT[agent]);

  if (!process.stdin.isTTY) {
    console.error(`[auto] using ${specs.join(", ")} (non-TTY input — no prompt)`);
    return { specs, fromPreferences: false };
  }

  const action = await promptForConfirmation(specs);
  if (action === "reject") {
    throw new Error(
      'Selection rejected. Pass explicit specs, e.g. `npx @yadimon/llm-clash cc codex "task..."`.'
    );
  }
  if (action === "save") {
    savePreferences({ defaultModels: specs });
    console.error(`[auto] saved selection to ~/.config/llm-clash/preferences.json`);
  }
  return { specs, fromPreferences: false };
}

type PromptAction = "accept" | "reject" | "save";

/**
 * Show the chosen specs and wait for one keypress worth of input.
 *   <Enter>/y → accept
 *   n        → reject
 *   s        → accept and persist for next time
 */
async function promptForConfirmation(specs: string[]): Promise<PromptAction> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error(`\nDetected local CLIs (priority: ${PRIORITY.join(" > ")}).`);
    console.error(`Auto-selected: ${specs.join(", ")}`);
    const answer = (await rl.question("Use this? [Y/n/s=save] ")).trim().toLowerCase();
    if (answer === "n" || answer === "no") {
      return "reject";
    }
    if (answer === "s" || answer === "save") {
      return "save";
    }
    return "accept";
  } finally {
    rl.close();
  }
}

/**
 * Tolerate stored specs that use the short prefix (`claude:` instead of
 * `claude-code:`). Without this a saved `claude-code:...` would fail to
 * match an installed `claude-code` agent if the spec was abbreviated.
 */
function matchesShortPrefix(spec: string, agent: LocalAgentName): boolean {
  if (agent === "claude-code") {
    return spec.startsWith("claude:");
  }
  if (agent === "gemini-cli") {
    return spec.startsWith("gemini:");
  }
  if (agent === "opencode") {
    return spec.startsWith("open-code:");
  }
  return false;
}
