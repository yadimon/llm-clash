import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

export type VercelAiUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

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

export type VercelAiAdapterConfig = {
  id: string;
  label?: string | undefined;
  model: unknown;
  generateText?: VercelAiGenerateText | undefined;
  defaultTemperature?: number | undefined;
  defaultMaxTokens?: number | undefined;
};

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
