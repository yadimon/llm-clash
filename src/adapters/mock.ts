// ---------------------------------------------------------------------------
// In-memory mock adapter.
//
// Used by the test suite (and useful for local development) to simulate a
// model without any network/process I/O. The caller supplies a synchronous
// or async `generate` function that receives the full `ModelInput` plus a
// monotonically increasing `callIndex` — perfect for scripted scenarios
// where each call should return a different canned answer.
// ---------------------------------------------------------------------------

import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

/**
 * Mock adapter configuration.
 *
 * `generate(input, callIndex)` returns just the response text — usage
 * accounting is intentionally omitted because the mock has nothing to
 * report.
 */
export type MockAdapterConfig = {
  id: string;
  label?: string | undefined;
  generate: (input: ModelInput, callIndex: number) => string | Promise<string>;
};

/**
 * Build a `ModelAdapter` whose responses come from an in-process callback.
 *
 * The internal `calls` counter increments AFTER every call, so the first
 * invocation receives `callIndex = 0`. That matches typical fixture arrays
 * indexed by 0, 1, 2 …
 */
export function mockAdapter(config: MockAdapterConfig): ModelAdapter {
  let calls = 0;
  return {
    id: config.id,
    label: config.label,
    async generate(input: ModelInput): Promise<ModelOutput> {
      const text = await config.generate(input, calls);
      calls += 1;
      return { text };
    }
  };
}
