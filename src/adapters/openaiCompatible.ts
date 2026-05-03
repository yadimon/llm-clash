import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

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

export function openaiCompatible(config: OpenAICompatibleAdapterConfig | string): ModelAdapter {
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
      const messages = [
        ...(input.system || normalized.defaultSystem
          ? [{ role: "system", content: input.system ?? normalized.defaultSystem }]
          : []),
        { role: "user", content: input.prompt }
      ];

      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
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
        throw new Error(
          `OpenAI-compatible request failed for ${normalized.id}: ${response.status} ${await response.text()}`
        );
      }

      const raw = (await response.json()) as ChatCompletionResponse;
      const choice = raw.choices?.[0];
      const text = normalizeContent(choice?.message?.content ?? choice?.text);
      if (!text) {
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
