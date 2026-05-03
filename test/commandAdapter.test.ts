import { describe, expect, it } from "vitest";
import { commandAdapter } from "../src/adapters/commandAdapter.js";

describe("commandAdapter", () => {
  it("passes prompts through stdin", async () => {
    const adapter = commandAdapter({
      id: "node-stdin",
      command: "node",
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      inputMode: "stdin"
    });

    const output = await adapter.generate({ prompt: "hello" });

    expect(output.text).toBe("hello");
  });

  it("supports argument placeholders", async () => {
    const adapter = commandAdapter({
      id: "node-arg",
      command: "node",
      args: ["-e", "console.log(process.argv[1])", "{prompt}"],
      inputMode: "arg"
    });

    const output = await adapter.generate({ prompt: "from-arg" });

    expect(output.text).toBe("from-arg");
  });

  it("supports prompt files", async () => {
    const adapter = commandAdapter({
      id: "node-file",
      command: "node",
      args: [
        "-e",
        "console.log(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
        "{file}"
      ],
      inputMode: "file"
    });

    const output = await adapter.generate({ prompt: "from-file" });

    expect(output.text).toBe("from-file");
  });
});
