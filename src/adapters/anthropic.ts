import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

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

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

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
        ...(input.signal ? { signal: input.signal } : {}),
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": config.version ?? "2023-06-01"
        },
        body: JSON.stringify({
          model: config.model,
          system: input.system ?? config.defaultSystem,
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
      const text =
        raw.content
          ?.map((part) => part.text)
          .filter((part): part is string => typeof part === "string")
          .join("\n") ?? "";

      if (!text) {
        throw new Error(`Anthropic response for ${config.id} did not include text.`);
      }

      return {
        text,
        usage: {
          inputTokens: raw.usage?.input_tokens,
          outputTokens: raw.usage?.output_tokens,
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
