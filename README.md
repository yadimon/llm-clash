# llm-clash

> Get a single polished text answer by making several LLMs draft, refine each
> other's drafts, judge the results, and either pick the winner or fuse the best
> parts together.

`llm-clash` is a console tool (and a small Node.js library) for **multi-draft
iterative refinement**. You give it one task — a plan, a research note, an
architecture decision, a code review, anything text — and a list of model
adapters. It then runs:

```
task
  → every model writes its own draft         (round 0)
  → every model rewrites its draft after seeing the others (round 1..N)
  → every model judges the final drafts on the configured criteria
  → one final answer (winner or synthesis)
```

The result is a noticeably stronger answer than any single model produces on
its own, with full traceability to every intermediate draft.

---

## Install

`llm-clash` is a CLI you call from your terminal, so install it **globally**:

```bash
npm install -g @yadimon/llm-clash
```

Then anywhere in your shell:

```bash
llm-clash --help
```

If you only want to try it once without installing:

```bash
npx @yadimon/llm-clash --help
```

> Local install (`npm install @yadimon/llm-clash`, no `-g`) is intended for
> projects that **embed** the engine — for example a custom agent system that
> needs better decisions. See [Library API](#library-api) below.

---

## Quick start

### Zero config

If you have at least two of `claude`, `codex`, `gemini`, `opencode`
installed locally, just give it a task — `llm-clash` picks the top two by
priority (`codex` > `claude-code` > `gemini-cli` > `opencode`), shows the
selection once, and asks for confirmation:

```bash
npx @yadimon/llm-clash "Plane die Migration einer Express-App auf Fastify."
```

Press `Y` to use it for this run, `s` to save the choice to
`~/.config/llm-clash/preferences.json` (skips the prompt next time), or `n`
to abort. Hosted-API providers are never auto-selected — use explicit specs
(`anthropic:…`, `openai:…`, `openrouter:…`, `google:…`) for those.

### Bare-name shortcuts

`cc`, `codex`, `gemini` expand to the top-model spec for each provider with
high reasoning effort:

```bash
npx @yadimon/llm-clash cc codex "Make a step-by-step plan to add OAuth2 login."
# → claude-code:claude-opus-4-7-high  +  codex:gpt-5.5-high
```

`opencode` has no curated default (too many models) — pass an explicit
`opencode:<model>` spec.

### Explicit specs

Pick two or three models, end with the task in quotes:

```bash
llm-clash \
  claude-code:sonnet \
  codex:gpt-5.4-mini-low \
  openrouter:openrouter/free \
  "Make a step-by-step plan to add OAuth2 login to a Spring Boot + Angular app."
```

What happens:

1. All three models produce a first draft in parallel.
2. They each rewrite their draft after seeing the others (default: 2 rounds).
3. They judge the final drafts.
4. The winner — or a synthesized fusion — is printed to stdout.
5. Every draft, every judgment, and the final answer are written to
   `.runs/<timestamp>/` so you can review them later.

Pipe the answer somewhere useful:

```bash
llm-clash openai:gpt-4.1 anthropic:claude-sonnet-4-5 "Draft a release note." \
  --quiet > release-note.md
```

---

## API keys

Set whichever providers you actually use. Each one is read from an environment
variable, a `.env` file in the current directory, or a CLI flag:

| Provider        | Environment variable | CLI flag               |
| --------------- | -------------------- | ---------------------- |
| OpenAI          | `OPENAI_API_KEY`     | —                      |
| Anthropic       | `ANTHROPIC_API_KEY`  | —                      |
| OpenRouter      | `OPENROUTER_API_KEY` | `--openrouter-api-key` |
| Google (Gemini) | `GOOGLE_API_KEY`     | —                      |

Local CLI agents (`claude-code:`, `codex:`, `gemini-cli:`, `opencode:`) use
whatever credentials those tools already have configured locally — no extra
keys needed.

A minimal `.env` next to where you run the command:

```env
OPENROUTER_API_KEY=sk-or-...
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Choosing models (model specs)

Each model on the command line is a short string with a provider prefix:

| Spec                                     | What it is                                      | Notes                                         |
| ---------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| `cc`                                     | Shortcut for `claude-code:claude-opus-4-7-high` | bare-name shortcut                            |
| `codex`                                  | Shortcut for `codex:gpt-5.5-high`               | bare-name shortcut                            |
| `gemini`                                 | Shortcut for `gemini-cli:flash`                 | bare-name shortcut                            |
| `openai:gpt-4.1`                         | OpenAI Chat Completions                         | needs `OPENAI_API_KEY`                        |
| `anthropic:claude-sonnet-4-5`            | Anthropic Messages API                          | needs `ANTHROPIC_API_KEY`                     |
| `openrouter:anthropic/claude-3.5-sonnet` | OpenRouter (any of its models)                  | needs `OPENROUTER_API_KEY`                    |
| `google:gemini-2.5-pro`                  | Google Gemini OpenAI-compat endpoint            | needs `GOOGLE_API_KEY`                        |
| `claude-code:opus`                       | Local `claude` CLI                              | uses your existing Claude Code login          |
| `codex:gpt-5.3-medium`                   | Local `codex` CLI                               | uses your existing Codex login                |
| `gemini-cli:flash`                       | Local `gemini` CLI                              | uses your existing Gemini CLI login           |
| `opencode:anthropic/claude-3.5-sonnet`   | Local `opencode` CLI                            | uses opencode's configured backends           |
| `command:<id>:<command>[:arg…]`          | Any local command-line LLM                      | for richer args, prefer a YAML config (below) |

**Reasoning effort suffix.** Local agent specs accept a trailing
`-low / -medium / -high / -xhigh / -max`:

```
claude-code:opus-high
codex:gpt-5.3-codex-medium
```

**Tip.** Mixing one or two strong API models with a fast/cheap local agent is
usually the best price/quality trade-off.

---

## Options

All options work on the default `llm-clash` command and on the `refine`
subcommand. The `run` subcommand accepts `--save` / `--no-save`,
`--output <dir>`, `--openrouter-api-key <key>`, and `--quiet`; CLI flags
override the corresponding YAML fields. Flags for a subcommand go **after**
the subcommand name (`llm-clash run task.yaml --output ./out`).

| Flag                         | Purpose                                                                    | Default                |
| ---------------------------- | -------------------------------------------------------------------------- | ---------------------- |
| `--rounds <n>`               | Refinement rounds AFTER the initial draft (max 4).                         | `2`                    |
| `--final <mode>`             | `choose_best`, `synthesize`, or `choose_or_synthesize`.                    | `choose_or_synthesize` |
| `--temperature <n>`          | Sampling temperature for drafting/refinement (judges always use 0).        | provider               |
| `--max-tokens <n>`           | Max output tokens per call.                                                | provider               |
| `--self-score-weight <n>`    | Weight when a model judges its OWN draft (lower than peer to dampen bias). | `0.5`                  |
| `--peer-score-weight <n>`    | Weight when a model judges another model's draft.                          | `1.0`                  |
| `--save` / `--no-save`       | Write per-round drafts and judgments to disk.                              | `--save`               |
| `--output <dir>`             | Where to write artifacts. Falls back to `.runs/<timestamp>/`.              | `.runs/…`              |
| `--openrouter-api-key <key>` | One-off OpenRouter key (alternative to env var).                           | —                      |
| `--quiet`                    | Suppress progress logging on stderr (model start/done/error, etc.).        | off                    |

### Final modes

- **`choose_best`** — return the winning draft as-is. Fastest.
- **`synthesize`** — always run a final synthesis pass that fuses the strongest
  parts of every draft into one answer.
- **`choose_or_synthesize`** — return the winner if scores diverge clearly;
  synthesize when it's a tie or the gap is below `0.3` (recommended for high
  quality).

---

## Customization

### YAML config

For repeatable runs and complex per-model setup, put everything in a YAML file:

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
  - claude-code:sonnet
  - codex:gpt-5.4-mini-low
  - openrouter:anthropic/claude-3.5-sonnet

evaluationCriteria:
  - accuracy
  - completeness
  - usefulness
  - clarity
  - goal_fit
```

Run it:

```bash
llm-clash run ./task.yaml
```

### Custom endpoints and local commands

Inside `models:` you can mix string specs with full objects when you need
custom HTTP base URLs, custom command-line agents, or custom timeouts:

```yaml
models:
  # Custom HTTP endpoint (any OpenAI-compatible server: vLLM, LM Studio,
  # Together, Groq, …).
  - id: local-llama
    baseUrl: http://localhost:8080/v1
    model: meta-llama/Meta-Llama-3.1-8B-Instruct

  # OpenRouter with an explicit key env var.
  - id: openrouter:anthropic/claude-3.5-sonnet
    baseUrl: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    model: anthropic/claude-3.5-sonnet

  # Arbitrary CLI as a model.
  - id: my-codex
    type: command
    command: codex
    args: ["exec", "--model", "gpt-5.4-mini", "--skip-git-repo-check", "--color", "never"]
    inputMode: stdin
    timeoutMs: 600000
```

Full per-model field reference: [`docs/config.md`](docs/config.md).

### Evaluation criteria

The defaults (`accuracy`, `completeness`, `usefulness`, `clarity`, `goal_fit`)
work for most tasks. Add `specificity` for technical/operational plans, and
`risk_control` when uncertainty matters (security, compliance, migrations):

```yaml
evaluationCriteria:
  - accuracy
  - completeness
  - usefulness
  - clarity
  - goal_fit
  - specificity
  - risk_control
```

**Custom criteria.** Any identifier matching `letter` followed by
letters/digits/`_`/`-` is accepted. Custom criteria get a generated
human-readable label — `guardrail_quality` becomes `Guardrail Quality` — used
consistently in the judge prompts and when parsing judge responses, plus the
neutral judge guidance "Judge this criterion by its name.":

```yaml
evaluationCriteria:
  - goal_fit
  - completeness
  - guardrail_quality
  - actionability
```

Malformed criteria (empty strings, spaces, punctuation) are rejected at
config-load time, before any model call is made.

---

## Output

When `--save` (default) is on, every run writes a self-contained directory:

```
.runs/2026-05-03T18-22-00/
  config.yaml                         # snapshot of the run config
  task.md                             # the original task
  rounds/
    round-0/<model>.md                # initial drafts
    round-1/<model>.md                # first refinement
    round-2/<model>.md                # second refinement, etc.
  evaluation/
    <judge>.md                        # raw judgment from each judge
    aggregated.json                   # cross-judge weighted scores + winner
  final.md                            # the final answer
  run.json                            # machine-readable record of the whole run
```

`final.md` is what you usually want. `run.json` is great for piping into other
tools.

Artifacts are written **incrementally**: `config.yaml` + `task.md` at run
start, each round's drafts as soon as the round completes, and each judge's
judgment as soon as that judge finishes. If a run crashes late (a judge or the
synthesis pass fails), everything that completed is already on disk — only
`aggregated.json`, `final.md`, and `run.json` are written at the very end.

---

## Library API

Install **without** `-g` when you want to embed the engine in another project
(for example a custom agent system that needs better decisions):

```bash
npm install @yadimon/llm-clash
```

```ts
import { runMultiDraftRefinement, openaiCompatible, commandAdapter } from "@yadimon/llm-clash";

const result = await runMultiDraftRefinement({
  task: "Create a migration plan from LocalWP to Docker for a WordPress project.",
  models: [
    openaiCompatible({
      id: "openrouter:anthropic/claude-3.5-sonnet",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: "anthropic/claude-3.5-sonnet"
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
  saveArtifacts: true,
  onEvent: (event) => {
    // round_start, draft_created, round_complete, evaluation_start,
    // evaluation_complete, synthesis_start, artifacts_saved, run_complete
  }
});

console.log(result.finalAnswer);
```

Adapters available as both top-level imports and as tree-shakeable sub-paths:

```ts
import { vercelAi } from "@yadimon/llm-clash/adapters/vercel-ai";
import { anthropic } from "@yadimon/llm-clash/adapters/anthropic";
import { openaiCompatible } from "@yadimon/llm-clash/adapters/openai-compatible";
import { commandAdapter } from "@yadimon/llm-clash/adapters/command";
import { mockAdapter } from "@yadimon/llm-clash/adapters/mock";
```

The full type surface (`RunConfig`, `RunResult`, `Draft`, `EvaluationResult`,
`AggregatedEvaluation`, `RunEvent`, …) is documented inline in the source —
each exported type has a JSDoc block that shows up in your editor's tooltips.

---

## Troubleshooting

- **`OPENROUTER_API_KEY is required …`** — set the env var, add it to a local
  `.env`, or pass `--openrouter-api-key <key>`.
- **`Command failed with exit code …`** — local CLI agents usually print the
  real cause to stderr; the message is included in the error. Most often this
  is an outdated/missing CLI, not configured login, or a wrong model name.
- **Identical answers from every model** — your task is probably too narrow or
  too short. Multi-draft refinement shines on open-ended planning, design, and
  comparison tasks; for `2 + 2` it's overkill.
- **Run too slow / too expensive** — drop `--rounds` to `1` or `0`, or replace
  one big API model with a fast local agent (`claude-code:sonnet`,
  `gemini-cli:flash`, `codex:gpt-5.4-mini-low`).

---

## For developers / contributors

Everything below is for **working on llm-clash itself**, not for using it.

### Setup

```bash
git clone https://github.com/yadimon/llm-clash.git
cd llm-clash
npm install
```

### Common scripts

| Script                  | What it does                                                          |
| ----------------------- | --------------------------------------------------------------------- |
| `npm run check`         | Format check + lint + typecheck + tests + build + `npm pack` dry run. |
| `npm run test`          | Vitest unit tests only.                                               |
| `npm run test:coverage` | Vitest with coverage.                                                 |
| `npm run lint`          | ESLint.                                                               |
| `npm run format`        | Prettier (write).                                                     |
| `npm run format:check`  | Prettier (check only).                                                |
| `npm run typecheck`     | `tsc --noEmit`.                                                       |
| `npm run build`         | Compile to `dist/`.                                                   |

### Smoke tests against real local agents

These exist for contributors to verify the local-CLI adapters end-to-end. They
are not needed to use `llm-clash`.

```bash
npm run build
npm run smoke:agents:core             # claude-code + codex + openrouter
npm run smoke:agents:gemini-opencode  # gemini-cli + opencode
npm run smoke:agents                  # everything
```

The smoke runner reads `.env`, skips any local CLI that isn't installed, and
writes artifacts under `.runs/`. The fixtures live in `examples/smoke/`.

### Releasing

See [`RELEASING.md`](RELEASING.md). The release scripts (`release:patch`,
`release:minor`, `release:major`) bump the version, build, and prepare the
publish.

### Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) — keep changes scoped,
update docs/examples when public behavior changes, and run `npm run check`
before requesting review.

### Security

Vulnerability reporting policy: [`SECURITY.md`](SECURITY.md).

---

## License

MIT — see [`LICENSE`](LICENSE).
