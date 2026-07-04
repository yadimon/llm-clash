# Configuration

The CLI accepts a task with optional model specs, the `refine` subcommand, or a
YAML file. YAML is recommended when models need custom endpoints, command
arguments, or timeouts.

```bash
# Zero-config: detect installed local CLIs and pick the top two by priority.
npx @yadimon/llm-clash "Make a plan."

# Bare-name shortcuts (cc, codex, gemini) expand to top-model specs with high
# reasoning effort.
npx @yadimon/llm-clash cc codex "Make a plan."

# Explicit model specs.
npx @yadimon/llm-clash claude-code:sonnet-low codex:gpt-5.4-mini-low "Make a plan."

# YAML file with full configuration.
npx @yadimon/llm-clash run ./task.yaml --save
```

The zero-config flow asks once for confirmation and can persist the chosen
selection to `~/.config/llm-clash/preferences.json` (answer `s` at the
prompt). Hosted-API providers (`openai:`, `anthropic:`, `openrouter:`,
`google:`) are never auto-selected — pass them explicitly when needed.

## Model Entries

```yaml
models:
  - claude-code:sonnet-low
  - codex:gpt-5.4-mini-low
  - gemini-cli:flash
  - open-code:openrouter/openrouter/free
  - openrouter:openrouter/free
```

OpenRouter specs read `OPENROUTER_API_KEY`, a local `.env`, or
`--openrouter-api-key`.

Built-in local CLI specs are configured for non-interactive runs with read-only
file access where the underlying tool exposes the needed flags.

Use object entries for custom endpoints or local commands:

```yaml
models:
  - id: openrouter:anthropic/claude-3.7-sonnet
    baseUrl: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    model: anthropic/claude-3.7-sonnet
```

Supported model entry fields:

| Field               | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `id`                | Stable identifier used in artifacts            |
| `label`             | Optional human-readable label                  |
| `type`              | `openai-compatible`, `anthropic`, or `command` |
| `baseUrl`           | OpenAI-compatible endpoint base URL            |
| `apiKeyEnv`         | Environment variable containing the API key    |
| `model`             | Provider model name                            |
| `command`           | Command to execute for command models          |
| `args`              | Command arguments                              |
| `inputMode`         | `stdin`, `file`, `tempfile`, or `arg`          |
| `inputFlag`         | Flag to prepend before the prompt in arg mode  |
| `promptPlaceholder` | Placeholder replaced by the prompt             |
| `filePlaceholder`   | Placeholder replaced by a prompt file path     |
| `timeoutMs`         | Command timeout, default `600000`              |
| `shell`             | Run command through the platform shell         |

## Evaluation Criteria

`evaluationCriteria` defaults to `accuracy`, `completeness`, `usefulness`,
`clarity`, `goal_fit`. The built-in extras are `specificity` and
`risk_control`.

Custom criteria are supported: any identifier that starts with a letter and
continues with letters, digits, `_`, or `-` (for example
`guardrail_quality`). Custom criteria get a generated label
(`guardrail_quality` → `Guardrail Quality`) that is used in the judge prompt
and matched when parsing judge responses, with the neutral guidance "Judge
this criterion by its name." Malformed criteria are rejected at config-load
time, before any model call.

```yaml
evaluationCriteria:
  - goal_fit
  - completeness
  - guardrail_quality
```

## Artifacts And Progress

`saveArtifacts` defaults to `true`. Set it to `false`, or pass CLI
`--no-save`, to skip `.runs/` output. `--output <dir>` (also available on the
`run` subcommand, after the subcommand name) overrides the artifact
directory; it wins over `outputDir` from the YAML.

Artifacts are saved incrementally: `config.yaml` and `task.md` at run start,
every round's drafts when the round completes, and every judgment when the
judge finishes. A crash during evaluation or synthesis leaves all completed
drafts and judgments on disk; `aggregated.json`, `final.md`, and `run.json`
are written at the end of a successful run.

Use `onEvent` in the programmatic API to receive progress events for rounds,
per-model draft start/done/error, evaluation, synthesis, artifact saving, and
completion.

## Final Modes

`choose_best` selects the highest weighted evaluated candidate.

`synthesize` asks the first configured model to create one final answer from the
final candidates and evaluation summary.

`choose_or_synthesize` selects directly when the top score difference is
significant, and synthesizes when candidates are close. This is the default.
