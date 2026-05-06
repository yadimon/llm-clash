// ---------------------------------------------------------------------------
// User preferences persistence.
//
// Stores the user's confirmed default model selection so subsequent runs of
// `npx @yadimon/llm-clash "task..."` don't re-ask. Lives at
// `~/.config/llm-clash/preferences.json` so it survives npx-cache wipes and
// global reinstalls.
//
// Schema is intentionally narrow — just the model specs the user approved
// and a timestamp. Anything more complex should go through CLI flags or the
// YAML config file instead of becoming hidden state.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Persisted user preferences. All fields optional so partial files load. */
export type Preferences = {
  /** Spec strings the user accepted from the auto-selection prompt. */
  defaultModels?: string[];
  /** ISO date when these preferences were last written. */
  savedAt?: string;
};

/** Resolve the preferences file path. Lazy so tests can override `HOME`. */
function preferencesPath(): string {
  return join(homedir(), ".config", "llm-clash", "preferences.json");
}

/**
 * Load preferences from disk. Returns an empty object if the file is
 * missing or unreadable — never throws, since stale preferences should
 * never block the CLI from running.
 */
export function loadPreferences(): Preferences {
  const path = preferencesPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Preferences;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return {};
  } catch {
    // Corrupt JSON or unreadable file. Surface a single hint so the user
    // can investigate, but don't crash — the CLI will just re-prompt.
    console.error(`[llm-clash] Could not read ${path}; ignoring preferences.`);
    return {};
  }
}

/**
 * Persist preferences to disk. Creates the parent directory if missing.
 * Sync I/O is deliberate — this is called at most once per CLI run.
 */
export function savePreferences(prefs: Preferences): void {
  const path = preferencesPath();
  const dir = join(homedir(), ".config", "llm-clash");
  mkdirSync(dir, { recursive: true });
  const enriched: Preferences = {
    ...prefs,
    savedAt: new Date().toISOString()
  };
  writeFileSync(path, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
}
