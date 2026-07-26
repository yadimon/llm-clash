// Point CODEX_HOME at an empty directory for the whole suite.
//
// The codex model catalog is read from `$CODEX_HOME/models_cache.json`, so
// without this a test asserting the default codex spec would resolve against
// whatever account the developer happens to be signed into — passing on one
// machine and failing on another. Tests that exercise the catalog create their
// own fixture directory and override this.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "llm-clash-test-codex-home-"));
