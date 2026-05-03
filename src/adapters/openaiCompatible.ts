// ---------------------------------------------------------------------------
// OpenAI-compatible HTTP adapter.
//
// Targets the `/chat/completions` endpoint shape that OpenAI defined and
// that almost every other provider now implements (OpenRouter, Together,
// Groq, vLLM, LM Studio, Google's Gemini OpenAI-compat layer, etc.).
//
// Construct an instance by passing either:
//   - a string         – treated as both the adapter id and the model name,
//                        with the OpenAI base URL and `OPENAI_API_KEY`
//                        environment variable as defaults; or
//   - a config object  – full control: `baseUrl`, `apiKey`, custom headers,
//                        defaultSystem/temperature/maxTokens, custom fetch.
//
// `fetchImpl` is injectable so tests can stub network calls without going
// through nock or msw.
// ---------------------------------------------------------------------------

import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

/**
 * Adapter configuration. Every HTTP detail (base URL, headers, key) can be
 * overridden; defaults target the public OpenAI API.
 */
export type OpenAICompatibleAdapterConfig = {
  id: string;
  label?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  headers?: Record<string, string> | undefined;
  defaultSystem?: string | undefined;
  defaultTemperature?: number | undefined;
  defaultMaxTokens?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
};

/**
 * Subset of the OpenAI chat-completions response we care about.
 *
 * `choices[0].message.content` is usually a string but newer
 * OpenAI-compatible providers also return content as an array of
 * `{ type, text }` parts; `normalizeContent` collapses both shapes into a
 * single string. Some providers (legacy completion APIs proxied behind the
 * chat endpoint) put text under `choices[0].text` instead — also handled.
 */
type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
    text?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

/**
 * Build an OpenAI-compatible `ModelAdapter`.
 *
 * Resolution order for connection details:
 *   - `baseUrl`  → arg → `OPENAI_BASE_URL` env → `https://api.openai.com/v1`.
 *   - `apiKey`   → arg → caller is responsible if neither set (the request
 *                  will simply omit the auth header — useful for local
 *                  servers like LM Studio or vLLM that don't require auth).
 *   - `model`    → arg → falls back to the adapter `id`.
 *   - `fetchImpl`→ arg → global `fetch` (Node 20+ provides this natively).
 */
export function openaiCompatible(config: OpenAICompatibleAdapterConfig | string): ModelAdapter {
  // Allow the shorthand `openaiCompatible("gpt-4o-mini")`.
  const normalized = typeof config === "string" ? { id: config, model: config } : config;
  const baseUrl = trimTrailingSlash(
    normalized.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
  );
  const model = normalized.model ?? normalized.id;
  const fetchImpl = normalized.fetchImpl ?? fetch;

  return {
    id: normalized.id,
    label: normalized.label,
    async generate(input: ModelInput): Promise<ModelOutput> {
      // Construct the chat messages array. We only emit a `system` message
      // when one was provided either per-call or as a default — including
      // an empty system message confuses some providers.
      const messages = [
        ...(input.system || normalized.defaultSystem
          ? [{ role: "system", content: input.system ?? normalized.defaultSystem }]
          : []),
        { role: "user", content: input.prompt }
      ];

      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        // Only include `signal` when set; some `fetch` polyfills choke on
        // an explicit `undefined`.
        ...(input.signal ? { signal: input.signal } : {}),
        headers: {
          "content-type": "application/json",
          ...(normalized.apiKey ? { authorization: `Bearer ${normalized.apiKey}` } : {}),
          ...normalized.headers
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: input.temperature ?? normalized.defaultTemperature,
          max_tokens: input.maxTokens ?? normalized.defaultMaxTokens
        })
      });

      if (!response.ok) {
        // Surface the raw error body — provider error messages are usually
        // the most useful debugging information available here.
        throw new Error(
          `OpenAI-compatible request failed for ${normalized.id}: ${response.status} ${await response.text()}`
        );
      }

      const raw = (await response.json()) as ChatCompletionResponse;
      const choice = raw.choices?.[0];
      const text = normalizeContent(choice?.message?.content ?? choice?.text);
      if (!text) {
        // Empty completion is almost always a real provider problem (e.g.
        // safety filter triggered), not something the orchestrator can
        // recover from — fail loudly.
        throw new Error(`OpenAI-compatible response for ${normalized.id} did not include text.`);
      }

      return {
        text,
        usage: {
          inputTokens: raw.usage?.prompt_tokens,
          outputTokens: raw.usage?.completion_tokens,
          totalTokens: raw.usage?.total_tokens
        },
        raw
      };
    }
  };
}

/**
 * Collapse the message-content union (string OR array of parts OR undefined)
 * into a single string. Non-text parts (images, audio, tool calls) are
 * dropped because the pipeline is text-only by design.
 */
function normalizeContent(
  content: string | Array<{ type?: string; text?: string }> | undefined
): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => part.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n");
  }
  return "";
}

/** Drop trailing slashes so `${baseUrl}/chat/completions` never doubles up. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
