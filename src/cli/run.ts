#!/usr/bin/env node
// ---------------------------------------------------------------------------
// llm-clash CLI bin entry.
//
// All command/option wiring lives in `./program.ts` (exported as
// `createProgram()` so tests can drive the CLI in-process); this file only
// exists as the executable referenced by the package.json `bin` field.
// ---------------------------------------------------------------------------

import { createProgram } from "./program.js";

createProgram()
  .parseAsync()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    // Exit code 1 so shell scripts can detect failures.
    process.exitCode = 1;
  });
