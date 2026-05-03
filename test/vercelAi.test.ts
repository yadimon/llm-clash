import { describe, expect, it } from "vitest";
import { vercelAi } from "../src/adapters/vercelAi.js";

describe("vercelAi", () => {
  it("wraps a Vercel AI SDK compatible generateText function", async () => {
    const adapter = vercelAi({
      id: "ai:test",
      model: { id: "model" },
      generateText: async (input) => ({
        text: `answer:${input.prompt}`,
        usage: {
          promptTokens: 3,
          completionTokens: 4,
          totalTokens: 7
        }
      })
    });

    const result = await adapter.generate({ prompt: "task" });

    expect(result.text).toBe("answer:task");
    expect(result.usage?.totalTokens).toBe(7);
  });
});
