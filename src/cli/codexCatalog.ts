// ---------------------------------------------------------------------------
// Codex model catalog.
//
// The `codex` CLI keeps a server-fetched, account-scoped list of the models
// the signed-in account may actually use at `$CODEX_HOME/models_cache.json`
// (default `~/.codex`). Each entry carries a `priority` (1 = best available)
// and the reasoning levels that model accepts — exactly what we need to pick
// the top model for an account instead of hard-pinning one id that a given
// plan may not be entitled to.
//
// Note this is a CLI *cache*, not a documented API. It can be absent on a
// fresh install, stale, or change shape between codex releases. Every read
// therefore degrades to `null`, and the caller falls back to a curated spec.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentCatalogEntry } from "./agentCatalog.js";

/**
 * Model ids are spliced into the `codex --model <id>` argv, so restrict them
 * to the shape real slugs use (`gpt-5.6-sol`, `gpt-5.4-mini`). A cache file
 * we don't own should never be able to inject flags or shell metacharacters.
 */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Shape of the entries we read. Extra fields in the file are ignored. */
type CachedModel = {
  slug?: unknown;
  priority?: unknown;
  visibility?: unknown;
  supported_reasoning_levels?: unknown;
};

/** Resolve the cache path. Lazy so tests can override `CODEX_HOME`/`HOME`. */
function catalogPath(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(home, "models_cache.json");
}

/**
 * Return the highest-priority model the local codex account may use, or
 * `null` when the cache is missing, unreadable, or holds nothing usable.
 */
export function readCodexCatalog(): AgentCatalogEntry | null {
  const path = catalogPath();
  if (!existsSync(path)) {
    // Normal on a fresh install — codex writes the cache on first use.
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) {
      return null;
    }
    const usable = (parsed.models as CachedModel[])
      .map(toEntry)
      .filter((entry): entry is RankedEntry => entry !== null)
      .sort((a, b) => a.priority - b.priority);
    return usable[0] ?? null;
  } catch {
    // Corrupt or half-written cache. Surface one hint and let the caller use
    // its curated fallback rather than failing the run over a cache file.
    console.error(`[llm-clash] Could not read ${path}; using the built-in codex default.`);
    return null;
  }
}

type RankedEntry = AgentCatalogEntry & { priority: number };

/**
 * Validate one cache entry. Returns `null` for anything we cannot safely use.
 *
 * Only `visibility` filters the list: entries marked `hide` are codex-internal
 * (e.g. `codex-auto-review`). `supported_in_api` is deliberately NOT a filter —
 * it describes the hosted OpenAI API, and models flagged `false` there (e.g.
 * `gpt-5.3-codex-spark`) still run fine through `codex exec`.
 */
function toEntry(model: CachedModel): RankedEntry | null {
  const { slug, priority, visibility } = model;
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    return null;
  }
  if (typeof priority !== "number" || !Number.isFinite(priority)) {
    return null;
  }
  if (visibility !== "list") {
    return null;
  }
  return { model: slug, efforts: toEfforts(model.supported_reasoning_levels), priority };
}

/**
 * Pull the effort names out of `supported_reasoning_levels`, which is an
 * array of `{ effort, description }` objects. An unrecognised shape yields an
 * empty list, which the caller reads as "efforts unknown".
 */
function toEfforts(levels: unknown): string[] {
  if (!Array.isArray(levels)) {
    return [];
  }
  return levels
    .map((level) => (level as { effort?: unknown })?.effort)
    .filter((effort): effort is string => typeof effort === "string" && effort.length > 0);
}
