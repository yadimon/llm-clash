import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createProgram } from "../src/cli/program.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("run subcommand", () => {
  it("honors --output and writes artifacts into the requested directory", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "llm-clash-cli-test-"));
    tempDirs.push(workDir);

    // A stand-in model: any prompt in, a fixed answer out. Spawned through
    // the command adapter exactly like a real local CLI model would be.
    const scriptPath = join(workDir, "fake-model.cjs");
    await writeFile(
      scriptPath,
      [
        'let data = "";',
        'process.stdin.on("data", (chunk) => { data += chunk; });',
        'process.stdin.on("end", () => { process.stdout.write("ok answer"); });',
        ""
      ].join("\n"),
      "utf8"
    );

    const configPath = join(workDir, "task.yaml");
    await writeFile(
      configPath,
      YAML.stringify({
        task: "Say OK.",
        rounds: 0,
        finalMode: "choose_best",
        models: [
          {
            id: "fake-model",
            type: "command",
            command: process.execPath,
            args: [scriptPath],
            inputMode: "stdin"
          }
        ]
      }),
      "utf8"
    );

    const outDir = join(workDir, "artifacts");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "node",
      "llm-clash",
      "run",
      configPath,
      "--output",
      outDir,
      "--quiet"
    ]);

    expect(log).toHaveBeenCalledWith(`Output directory: ${outDir}`);
    const run = JSON.parse(await readFile(join(outDir, "run.json"), "utf8")) as {
      finalAnswer: string;
    };
    expect(run.finalAnswer).toBe("ok answer");
    const final = await readFile(join(outDir, "final.md"), "utf8");
    expect(final).toBe("ok answer");
  });
});
