// ---------------------------------------------------------------------------
// Anthropic native Messages API adapter.
//
// Talks to `https://api.anthropic.com/v1/messages` using the documented
// JSON schema. Anthropic does NOT use the OpenAI chat-completions shape
// (different field names, different auth header, separate `system` field
// outside `messages`), so it gets its own adapter.
//
// `fetchImpl` is injectable for testability.
// ---------------------------------------------------------------------------

import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

/**
 * Adapter configuration.
 *
 * - `apiKey`   – falls back to `ANTHROPIC_API_KEY` env var if omitted.
 * - `version`  – Anthropic's `anthropic-version` header; defaults to the
 *                stable `2023-06-01`. Override only if you need a beta API.
 * - `defaultMaxTokens` – Anthropic REQUIRES `max_tokens` on every request,
 *                       so we default to 4096 inside `generate()` if neither
 *                       per-call nor default value is provided.
 */
export type AnthropicAdapterConfig = {
  id: string;
  label?: string | undefined;
  apiKey?: string | undefined;
  model: string;
  baseUrl?: string | undefined;
  version?: string | undefined;
  defaultSystem?: string | undefined;
  defaultTemperature?: number | undefined;
  defaultMaxTokens?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
};

/**
 * Anthropic returns content as an array of typed parts (text, tool_use,
 * etc.). We pull out only the `text` parts and join them — anything else is
 * irrelevant to the text-only pipeline.
 */
type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

/**
 * Build an Anthropic `ModelAdapter`.
 *
 * Resolves `apiKey` and `baseUrl` once at construction time so per-request
 * code stays tight. The actual API key check happens INSIDE `generate()`
 * so that constructing an adapter without a key never throws — only using
 * it does.
 */
export function anthropic(config: AnthropicAdapterConfig): ModelAdapter {
  const baseUrl = (config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    id: config.id,
    label: config.label,
    async generate(input: ModelInput): Promise<ModelOutput> {
      if (!apiKey) {
        throw new Error(`ANTHROPIC_API_KEY is required for ${config.id}.`);
      }

      const response = await fetchImpl(`${baseUrl}/messages`, {
        method: "POST",
        // Only include `signal` when set; some `fetch` polyfills choke on
        // an explicit `undefined`.
        ...(input.signal ? { signal: input.signal } : {}),
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": config.version ?? "2023-06-01"
        },
        body: JSON.stringify({
          model: config.model,
          // Anthropic's `system` is a top-level field, not a chat message.
          system: input.system ?? config.defaultSystem,
          // `max_tokens` is REQUIRED — see header note.
          max_tokens: input.maxTokens ?? config.defaultMaxTokens ?? 4096,
          temperature: input.temperature ?? config.defaultTemperature,
          messages: [{ role: "user", content: input.prompt }]
        })
      });

      if (!response.ok) {
        throw new Error(
          `Anthropic request failed for ${config.id}: ${response.status} ${await response.text()}`
        );
      }

      const raw = (await response.json()) as AnthropicResponse;
      // Concatenate every text part; ignore tool-use and other non-text parts.
      const text =
        raw.content
          ?.map((part) => part.text)
          .filter((part): part is string => typeof part === "string")
          .join("\n") ?? "";

      if (!text) {
        // Empty text response usually means a safety stop or all parts were
        // non-text — the orchestrator can't continue without a draft.
        throw new Error(`Anthropic response for ${config.id} did not include text.`);
      }

      return {
        text,
        usage: {
          inputTokens: raw.usage?.input_tokens,
          outputTokens: raw.usage?.output_tokens,
          // Anthropic doesn't report a `total_tokens` field; compute it
          // ourselves when both halves are present so callers get a uniform
          // shape across providers.
          totalTokens:
            raw.usage?.input_tokens !== undefined && raw.usage.output_tokens !== undefined
              ? raw.usage.input_tokens + raw.usage.output_tokens
              : undefined
        },
        raw
      };
    }
  };
}
