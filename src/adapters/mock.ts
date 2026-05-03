import type { ModelAdapter, ModelInput, ModelOutput } from "../core/types.js";

export type MockAdapterConfig = {
  id: string;
  label?: string | undefined;
  generate: (input: ModelInput, callIndex: number) => string | Promise<string>;
};

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
