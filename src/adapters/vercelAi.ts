// ---------------------------------------------------------------------------
// Vercel AI SDK adapter.
//
// Lets you plug any model exposed through the `ai` npm package (the Vercel
// AI SDK) into the multi-draft pipeline without taking a hard dependency
// on it.
//
// Two modes of use:
//
//   1. Pass `generateText` explicitly — typical for users who already
//      `import { generateText } from "ai"` in their app. We just call that
//      function for every prompt.
//
//   2. Don't pass `generateText` — we then dynamically import "ai" the
//      first time `generate()` is called. That keeps `ai` an OPTIONAL
//      peer dep: users who never hit this code path don't need it
//      installed at all.
//
// The shape mapping between the Vercel SDK and our `ModelOutput` is
// straightforward — `promptTokens`/`completionTokens` map to our
// `inputTokens`/`outputTokens`.
// ---------------------------------------------------------------------------

import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

/** Token usage shape returned by the Vercel AI SDK's `generateText`. */
export type VercelAiUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

/**
 * Subset of the `ai` package's `generateText` signature that we depend on.
 *
 * Re-declared here (rather than importing from "ai") so this package compiles
 * cleanly even when "ai" is not installed.
 */
export type VercelAiGenerateText = (input: {
  model: unknown;
  prompt: string;
  system?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  abortSignal?: AbortSignal | undefined;
}) => Promise<{
  text: string;
  usage?: VercelAiUsage | undefined;
}>;

/**
 * Adapter configuration.
 *
 * - `model`               – an opaque value forwarded straight to the SDK
 *                           (e.g. the result of `openai("gpt-4o-mini")`).
 * - `generateText`        – optional override; falls back to dynamically
 *                           importing the real one from "ai".
 * - `defaultTemperature`/`defaultMaxTokens` – baseline values used when
 *                           the caller did not override them on `ModelInput`.
 */
export type VercelAiAdapterConfig = {
  id: string;
  label?: string | undefined;
  model: unknown;
  generateText?: VercelAiGenerateText | undefined;
  defaultTemperature?: number | undefined;
  defaultMaxTokens?: number | undefined;
};

/**
 * Build a `ModelAdapter` that delegates to the Vercel AI SDK.
 *
 * The returned adapter resolves `generateText` lazily — the dynamic import
 * only fires on the first `generate()` call, so constructing the adapter
 * is cheap and never throws even if "ai" is missing.
 */
export function vercelAi(config: VercelAiAdapterConfig): ModelAdapter {
  return {
    id: config.id,
    label: config.label,
    async generate(input: ModelInput): Promise<ModelOutput> {
      const generateText = config.generateText ?? (await loadGenerateText());
      const result = await generateText({
        model: config.model,
        prompt: input.prompt,
        system: input.system,
        temperature: input.temperature ?? config.defaultTemperature,
        maxTokens: input.maxTokens ?? config.defaultMaxTokens,
        abortSignal: input.signal
      });

      return {
        text: result.text,
        usage: {
          inputTokens: result.usage?.promptTokens,
          outputTokens: result.usage?.completionTokens,
          totalTokens: result.usage?.totalTokens
        },
        raw: result
      };
    }
  };
}

/**
 * Lazily import `generateText` from the optional "ai" package.
 *
 * We use `new Function("specifier", "return import(specifier)")` instead of
 * a top-level static import so that:
 *   1. TypeScript's bundler does NOT try to resolve "ai" at build time,
 *   2. tools that statically scan `import` statements (e.g. dependency
 *      auditors) don't flag "ai" as missing,
 *   3. the import only happens at runtime, on first use, after the user
 *      has had a chance to install the optional dep.
 */
async function loadGenerateText(): Promise<VercelAiGenerateText> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<{ generateText?: unknown }>;
  const module = await dynamicImport("ai").catch((error: unknown) => {
    throw new Error(
      `The optional "ai" package is required for vercelAi() unless generateText is provided. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });

  if (typeof module.generateText !== "function") {
    throw new Error('The optional "ai" package does not export generateText.');
  }

  return module.generateText as VercelAiGenerateText;
}
