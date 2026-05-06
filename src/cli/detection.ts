// ---------------------------------------------------------------------------
// Local-CLI agent detection.
//
// Probes the system PATH for the four supported local LLM CLIs and returns
// the ones that are actually installed. Used by the auto-selection flow so
// `npx @yadimon/llm-clash "task..."` works without explicit model specs.
//
// The probing logic was originally written for `scripts/smoke-local-agents.mjs`
// (where it skips agents that aren't installed); this is a TypeScript port
// that lives in the runtime so the CLI can use it too.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";

/** The four local-CLI agents `llm-clash` knows how to drive. */
export type LocalAgentName = "codex" | "claude-code" | "gemini-cli" | "opencode";

/**
 * Priority order for auto-selection: when more than two CLIs are installed
 * we pick the top two by this order. `codex` is preferred for its strong
 * reasoning models, then `claude-code`, then `gemini-cli`, then `opencode`.
 */
export const PRIORITY: readonly LocalAgentName[] = [
  "codex",
  "claude-code",
  "gemini-cli",
  "opencode"
];

/** Map agent name → the executable to look up on PATH. */
const COMMAND_FOR_AGENT: Record<LocalAgentName, string> = {
  codex: "codex",
  "claude-code": "claude",
  "gemini-cli": "gemini",
  opencode: "opencode"
};

/**
 * Probe PATH for one executable. Uses `where.exe` on Windows and
 * `command -v` on POSIX shells — same approach as
 * `scripts/smoke-local-agents.mjs:80-86`.
 */
function hasCommand(command: string): boolean {
  const probe =
    process.platform === "win32"
      ? spawnSync("where.exe", [command], { stdio: "ignore" })
      : spawnSync("command", ["-v", command], { stdio: "ignore", shell: true });
  return probe.status === 0;
}

/**
 * Return the installed agents in priority order. Stable across calls — does
 * not cache, since installs can change between invocations of a long-running
 * process (rare, but cheap to recheck).
 */
export function detectInstalledAgents(): LocalAgentName[] {
  return PRIORITY.filter((agent) => hasCommand(COMMAND_FOR_AGENT[agent]));
}
