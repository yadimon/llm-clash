# llm-clash

`@yadimon/llm-clash` is a text-only library and CLI for multi-draft iterative
refinement. It runs several model adapters in parallel, asks each one to improve
its own draft with neutral access to additional candidate answers, evaluates the
final candidates, and can write every intermediate artifact to disk.

The MVP is intentionally generic:

```txt
task -> draft -> improved draft -> final selected draft
```

It is suitable for plans, research summaries, architecture decisions, code
reviews, technical specifications, option comparisons, and implementation
strategies.

## Install

```bash
npm install @yadimon/llm-clash
```

For one-off CLI runs after the package is published:

```bash
npx @yadimon/llm-clash \
  claude-code:sonnet-low \
  codex:gpt-5.4-mini-low \
  openrouter:openrouter/free \
  "Create a plan for implementing OAuth2 login in an existing Spring Boot + Angular app"
```

OpenRouter can read the key from `OPENROUTER_API_KEY`, a local `.env`, or a CLI
flag:

```bash
npx @yadimon/llm-clash \
  claude-code:sonnet-low \
  openrouter:openrouter/free \
  --openrouter-api-key=ABCD \
  "Make a concise migration plan."
```

If no OpenRouter key is available, `openrouter:*` specs fail with a clear error
instead of making an unauthenticated request.

## Model Specs

CLI specs map to adapters like this:

| Spec                                   | Adapter                           | Notes                                         |
| -------------------------------------- | --------------------------------- | --------------------------------------------- |
| `claude-code:sonnet-low`               | Claude Code CLI                   | Runs `claude --print`; aliases `claude:` too  |
| `codex:gpt-5.4-mini-low`               | Codex CLI                         | Runs `codex exec`; effort suffix is optional  |
| `codex:default-low`                    | Codex CLI                         | Uses the locally configured Codex default     |
| `gemini-cli:flash`                     | Gemini CLI                        | Runs `gemini --prompt`; aliases `gemini:` too |
| `open-code:openrouter/openrouter/free` | OpenCode CLI                      | Runs `opencode run --model provider/model`    |
| `openrouter:openrouter/free`           | OpenAI-compatible OpenRouter API  | Needs `OPENROUTER_API_KEY`                    |
| `openai:gpt-4.1`                       | OpenAI-compatible OpenAI API      | Needs `OPENAI_API_KEY`                        |
| `google:gemini-2.5-pro`                | Gemini OpenAI-compatible endpoint | Needs `GOOGLE_API_KEY`                        |
| `anthropic:claude-sonnet-4-5`          | Anthropic Messages API            | Needs `ANTHROPIC_API_KEY`                     |
| `command:<id>:<command>[:arg...]`      | Generic command adapter           | Prefer YAML for complex arguments             |

Local model suffixes can include effort where the CLI supports it:

```txt
claude-code:sonnet-low
claude-code:opus4.7-max
codex:gpt-5.4-mini-low
codex:gpt-5.4-mini-high
```

Built-in local CLI specs run non-interactively and bias toward read-only local
file access:

- Claude Code uses `--print`, skips session persistence, allows read/list/search
  tools, and avoids permission prompts.
- Codex uses `codex exec`, skips the Git repo trust check, runs ephemeral, and
  uses the read-only sandbox with approvals disabled.
- Gemini CLI uses headless `--prompt -` with `--approval-mode plan`.
- OpenCode uses `opencode run` and sets read/glob/grep permissions to allow
  while denying edit and bash permissions.

For cheap smoke tests, prefer moving aliases that stay current where the local
tool supports them: `claude-code:sonnet-low`, `gemini-cli:flash`,
`codex:gpt-5.4-mini-low`, and `openrouter:openrouter/free`.

## Config File

```yaml
task: |
  Create a technical plan for implementing OAuth2 login
  in an existing Spring Boot + Angular application.

rounds: 2
finalMode: choose_or_synthesize
selfScoreWeight: 0.5
peerScoreWeight: 1.0
saveArtifacts: true

models:
  - claude-code:sonnet-low
  - codex:gpt-5.4-mini-low
  - openrouter:openrouter/free

evaluationCriteria:
  - accuracy
  - completeness
  - usefulness
  - clarity
  - goal_fit
```

Run it:

```bash
npx @yadimon/llm-clash run ./task.yaml --save
```

For custom endpoints or commands:

```yaml
models:
  - id: openrouter:anthropic/claude-sonnet-4.5
    baseUrl: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    model: anthropic/claude-sonnet-4.5
  - id: codex-local
    type: command
    command: codex
    args: ["exec", "--model", "gpt-5.4-mini", "--skip-git-repo-check", "--color", "never"]
    inputMode: stdin
    timeoutMs: 180000
```

Use `--no-save` to print the final answer without writing `.runs/`.

## Library API

```ts
import { commandAdapter, openaiCompatible, runMultiDraftRefinement } from "@yadimon/llm-clash";

const result = await runMultiDraftRefinement({
  task: "Create a migration plan from LocalWP to Docker for a WordPress project.",
  models: [
    openaiCompatible({
      id: "openrouter:anthropic/claude-sonnet-4.5",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: "anthropic/claude-sonnet-4.5"
    }),
    commandAdapter({
      id: "codex-local",
      command: "codex",
      args: ["exec", "--model", "gpt-5.4-mini", "--skip-git-repo-check", "--color", "never"],
      inputMode: "stdin"
    })
  ],
  rounds: 2,
  finalMode: "choose_or_synthesize",
  saveArtifacts: true
});

console.log(result.finalAnswer);
```

## Local Agent Smoke Tests

Build first, then run either smoke group:

```bash
npm run build
npm run smoke:agents:core
npm run smoke:agents:gemini-opencode
```

The smoke script reads `.env`, skips missing local commands, and writes artifacts
under `.runs/`. The checked-in fixtures live in `examples/smoke/`.

## Output

Runs with `saveArtifacts: true` or CLI `--save` write a directory like:

```txt
.runs/
  2026-05-02T12-30-00/
    config.yaml
    task.md
    rounds/
      round-0/
      round-1/
      round-2/
    evaluation/
      aggregated.json
    final.md
    run.json
```

`final.md` contains the selected or synthesized answer. `run.json` contains the
full machine-readable result.

## Defaults

- `rounds`: `2`
- `maxRounds`: `4`
- `finalMode`: `choose_best`
- `selfScoreWeight`: `0.5`
- `peerScoreWeight`: `1.0`
- `saveArtifacts`: `true`
- `evaluationCriteria`: `accuracy`, `completeness`, `usefulness`, `clarity`, `goal_fit`

If the final score difference is below `0.3`, `choose_or_synthesize` creates a
final synthesis instead of taking a narrow winner directly.
