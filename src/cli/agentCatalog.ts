// ---------------------------------------------------------------------------
// Top-model resolution for local CLI agents.
//
// Every local agent answers the same question — "which model should `codex` /
// `cc` / `gemini` expand to?" — but each answers it differently:
//
//   * claude-code exposes rolling aliases (`opus`), so the alias IS the answer
//     and never needs updating.
//   * codex pins every id to a version and instead ships an account-scoped
//     catalog on disk, so the answer must be read at runtime.
//   * gemini-cli uses stable short names (`flash`).
//
// This module hides that difference behind one function. An agent that can
// report its own models registers a reader in CATALOG_READER; everything else
// falls back to the curated spec. To support a future agent, add its reader —
// no caller changes.
// ---------------------------------------------------------------------------

import type { LocalAgentName } from "./detection.js";
import { readCodexCatalog } from "./codexCatalog.js";

/** One model an agent reports as available, with the efforts it accepts. */
export type AgentCatalogEntry = {
  /** Model id without the provider prefix or effort suffix. */
  model: string;
  /** Reasoning efforts this model accepts. Empty means "unknown". */
  efforts: string[];
};

/**
 * Reasoning effort the curated defaults aim for. Auto-selection is meant to
 * put the *strongest* configuration in front of the user, not the cheapest —
 * explicit specs remain the way to ask for something faster.
 */
const PREFERRED_EFFORT = "high";

/**
 * Fallback specs used when an agent reports no catalog. These stay
 * deliberately conservative: they are what runs when we cannot confirm what
 * an account is entitled to, so they favour a widely available model over the
 * newest one. Discovery is what upgrades a capable account beyond these.
 *
 * `opencode` is empty on purpose — it front-ends dozens of providers, so there
 * is no defensible default and callers must ask for an explicit model.
 */
const CURATED_SPEC: Record<LocalAgentName, string> = {
  codex: "codex:gpt-5.5-high",
  "claude-code": "claude-code:opus-high",
  "gemini-cli": "gemini-cli:flash",
  opencode: ""
};

/** Agents that can report their own available models. */
const CATALOG_READER: Partial<Record<LocalAgentName, () => AgentCatalogEntry | null>> = {
  codex: readCodexCatalog
};

/**
 * Resolved specs are memoised for the life of the process: `looksLikeModelSpec`
 * and the auto-selection flow both ask, and re-reading a catalog file per
 * argv token would be wasteful.
 */
const resolved = new Map<LocalAgentName, string>();

/**
 * Return the spec a bare agent name expands to — the best model that agent
 * reports, at high effort, falling back to the curated spec.
 */
export function topSpecForAgent(agent: LocalAgentName): string {
  const cached = resolved.get(agent);
  if (cached !== undefined) {
    return cached;
  }
  const spec = resolveTopSpec(agent);
  resolved.set(agent, spec);
  return spec;
}

/**
 * Whether this agent has a default model at all. `opencode` does not, so the
 * auto-selection flow skips it rather than guessing.
 */
export function hasCuratedDefault(agent: LocalAgentName): boolean {
  return CURATED_SPEC[agent] !== "";
}

function resolveTopSpec(agent: LocalAgentName): string {
  const curated = CURATED_SPEC[agent];
  const reader = CATALOG_READER[agent];
  if (!reader || curated === "") {
    return curated;
  }
  const top = reader();
  if (!top) {
    return curated;
  }
  return `${agent}:${withEffort(top)}`;
}

/**
 * Append the preferred effort when the model accepts it. When the catalog
 * lists efforts and `high` is not among them, we append nothing and let the
 * agent apply its own default rather than passing a level it will reject.
 */
function withEffort(entry: AgentCatalogEntry): string {
  if (entry.efforts.length > 0 && !entry.efforts.includes(PREFERRED_EFFORT)) {
    return entry.model;
  }
  return `${entry.model}-${PREFERRED_EFFORT}`;
}
