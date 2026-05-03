// ---------------------------------------------------------------------------
// Heuristic markdown parsers for LLM responses.
//
// Models are asked (in `prompts.ts`) to emit responses with a specific
// structure — for evaluations:
//
//     # Evaluation
//     ## Candidate 1
//     Accuracy: 8/10
//     Completeness: 7/10
//     ...
//     Total: 7.5/10
//     Strengths:
//       - ...
//     Weaknesses:
//       - ...
//     ## Candidate 2
//     ...
//     # Best Candidate
//     Candidate N
//     # Reason
//     ...
//
// and for refinement responses:
//
//     # Improved Answer
//     {{the answer}}
//     # Changes Made
//     ...
//
// Real models drift from the format constantly: missing sections, extra
// punctuation, "Total" omitted, scores written as "7", "7/10", or "7.5".
// The functions below are deliberately tolerant — they extract what they
// can and let the orchestrator fall back to averages for missing totals.
// ---------------------------------------------------------------------------

import type { CandidateScore, Draft, EvaluationCriterion, EvaluationResult } from "./types.js";
import { criterionLabel } from "./prompts.js";

/** A single `## Candidate N` section pulled out of an evaluation response. */
export type CandidateBlock = {
  index: number;
  body: string;
};

// Matches scores in either form: bare number "8" or "8/10", with optional decimals.
const SCORE_PATTERN = "(-?\\d+(?:\\.\\d+)?)\\s*(?:\\/\\s*10)?";

/**
 * Slice the raw evaluation markdown into per-candidate blocks.
 *
 * Splits on `# Candidate N`, `## Candidate N`, or `### Candidate N` headers
 * (case-insensitive). Stops the current block when it encounters
 * `# Best Candidate` or `# Reason` since those are footer sections that
 * follow the per-candidate scores.
 */
export function splitCandidateBlocks(markdown: string): CandidateBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: CandidateBlock[] = [];
  let current: { index: number; lines: string[] } | undefined;

  for (const line of lines) {
    const header = line.match(/^#{1,3}\s*Candidate\s+(\d+)\b/i);
    if (header?.[1]) {
      // Hit a new candidate header — flush the previous one if any.
      if (current) {
        blocks.push({ index: current.index, body: current.lines.join("\n").trim() });
      }
      current = { index: Number.parseInt(header[1], 10), lines: [] };
      continue;
    }

    // Footer markers terminate the candidate-block scan.
    if (/^#\s*(Best Candidate|Reason)\b/i.test(line)) {
      if (current) {
        blocks.push({ index: current.index, body: current.lines.join("\n").trim() });
        current = undefined;
      }
      continue;
    }

    current?.lines.push(line);
  }

  // Don't lose the last candidate when there is no trailing footer.
  if (current) {
    blocks.push({ index: current.index, body: current.lines.join("\n").trim() });
  }

  return blocks;
}

/**
 * Parse one candidate block into structured scores + strengths/weaknesses.
 *
 * Each criterion (configured for the run) is matched against the block by
 * looking for `<Criterion Label>: <number>[/10]`. Whitespace, dashes, and
 * underscores in the label are matched loosely so "Goal Fit", "goal-fit",
 * and "goal_fit" all work.
 *
 * `total` is parsed if the model emitted a `Total: X/10` line; otherwise the
 * caller (`parseEvaluationText`) will fall back to averaging the scores.
 */
export function parseCandidateBlock(
  body: string,
  criteria: EvaluationCriterion[]
): {
  scores: Partial<Record<EvaluationCriterion, number>>;
  total?: number | undefined;
  strengths: string[];
  weaknesses: string[];
} {
  const scores: Partial<Record<EvaluationCriterion, number>> = {};
  let total: number | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    // Strip leading bullet markers / whitespace so "- Accuracy: 8/10" works.
    const line = rawLine.replace(/^[-*\s]+/, "").trim();
    if (!line) {
      continue;
    }

    for (const criterion of criteria) {
      // Escape regex metacharacters in the label, then allow any combination
      // of whitespace/underscore/dash where the label has spaces.
      const label = criterionLabel(criterion).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const looseLabel = label.replace(/\s+/g, "[\\s_-]+");
      const match = line.match(new RegExp(`^${looseLabel}\\s*[:\\-]\\s*${SCORE_PATTERN}`, "i"));
      if (match?.[1]) {
        scores[criterion] = clampScore(Number.parseFloat(match[1]));
        break;
      }
    }

    const totalMatch = line.match(new RegExp(`^Total\\s*[:\\-]\\s*${SCORE_PATTERN}`, "i"));
    if (totalMatch?.[1]) {
      total = clampScore(Number.parseFloat(totalMatch[1]));
    }
  }

  const { strengths, weaknesses } = parseStrengthsWeaknesses(body);
  return { scores, total, strengths, weaknesses };
}

/**
 * Pull bullet-list items under the `Strengths:` and `Weaknesses:` sub-headers
 * inside a candidate block.
 *
 * The parser is line-stateful: once it sees `Strengths:` it routes following
 * `- item` / `* item` lines into the strengths array until it hits a blank
 * line, which resets the mode. Same logic for `Weaknesses:`.
 */
export function parseStrengthsWeaknesses(body: string): {
  strengths: string[];
  weaknesses: string[];
} {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  let mode: "strengths" | "weaknesses" | undefined;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^Strengths\s*:?$/i.test(trimmed)) {
      mode = "strengths";
      continue;
    }
    if (/^Weaknesses\s*:?$/i.test(trimmed)) {
      mode = "weaknesses";
      continue;
    }
    // Blank line ends the current section so unrelated bullets later in the
    // block don't get mis-attributed.
    if (!trimmed) {
      mode = undefined;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (!bullet?.[1] || !mode) {
      continue;
    }
    if (mode === "strengths") {
      strengths.push(bullet[1]);
    } else {
      weaknesses.push(bullet[1]);
    }
  }

  return { strengths, weaknesses };
}

/**
 * Extract the `# Best Candidate` index and `# Reason` text from the footer
 * of an evaluation response. Both fields are optional — judges sometimes
 * skip them, in which case the orchestrator falls back to weighted-total
 * ranking.
 */
export function parseBestCandidate(markdown: string): {
  index?: number | undefined;
  reason?: string | undefined;
} {
  const bestMatch = markdown.match(/#\s*Best Candidate\s*\n+([\s\S]*?)(?=\n#\s|$)/i);
  const candidateMatch = bestMatch?.[1]?.match(/Candidate\s+(\d+)/i);
  const reasonMatch = markdown.match(/#\s*Reason\s*\n+([\s\S]*?)$/i);
  return {
    index: candidateMatch?.[1] ? Number.parseInt(candidateMatch[1], 10) : undefined,
    reason: reasonMatch?.[1]?.trim()
  };
}

/**
 * Top-level entry point: turn a judge's raw markdown response into a fully
 * structured `EvaluationResult` aligned with the actual `Draft` ids.
 *
 * Steps:
 *   1. Split the response into per-candidate blocks.
 *   2. For every input draft (in order), find the matching block — drafts
 *      are mapped 1:1 onto "Candidate 1", "Candidate 2", … because that is
 *      the order they appear in the prompt produced by `evaluationPrompt`.
 *   3. Parse scores out of each block; fall back to averaging per-criterion
 *      scores when the model omitted the explicit `Total` line.
 *   4. Resolve the `# Best Candidate N` footer into a `Draft.id`.
 */
export function parseEvaluationText(
  text: string,
  candidates: Draft[],
  criteria: EvaluationCriterion[],
  judgeModelId = "unknown"
): EvaluationResult {
  const blocks = splitCandidateBlocks(text);
  const candidateScores: CandidateScore[] = candidates.map((candidate, index) => {
    // `index + 1` because the prompt numbers candidates starting at 1.
    const block = blocks.find((candidateBlock) => candidateBlock.index === index + 1);
    const parsed = block
      ? parseCandidateBlock(block.body, criteria)
      : { scores: {}, total: undefined, strengths: [], weaknesses: [] };
    const total =
      parsed.total ??
      average(
        Object.values(parsed.scores).filter((score): score is number => typeof score === "number")
      );

    return {
      candidateId: candidate.id,
      modelId: candidate.modelId,
      scores: parsed.scores,
      total,
      strengths: parsed.strengths,
      weaknesses: parsed.weaknesses
    };
  });

  const best = parseBestCandidate(text);
  // Bounds-check — discard nonsense like "Best Candidate: Candidate 12" when
  // there are only three actual candidates.
  const bestCandidateId =
    best.index !== undefined && best.index >= 1 && best.index <= candidates.length
      ? candidates[best.index - 1]?.id
      : undefined;

  return {
    judgeModelId,
    text,
    candidateScores,
    bestCandidateId,
    reason: best.reason
  };
}

/**
 * Pull the `# Improved Answer` body and optional `# Changes Made` notes out
 * of a refinement response.
 *
 * If the model failed to use the expected sections we fall back to treating
 * the WHOLE response as the answer — better to keep a usable draft than to
 * lose the round on a formatting miss.
 */
export function extractImprovedAnswer(markdown: string): {
  answer: string;
  notes?: string | undefined;
} {
  const answerMatch = markdown.match(
    /#\s*Improved Answer\s*\n*([\s\S]*?)(?=\n#\s*Changes Made\b|$)/i
  );
  const notesMatch = markdown.match(/#\s*Changes Made\s*\n*([\s\S]*)$/i);
  return {
    answer: (answerMatch?.[1] ?? markdown).trim(),
    notes: notesMatch?.[1]?.trim()
  };
}

/** Plain arithmetic mean rounded to 3 decimals. Returns 0 for an empty input. */
function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

/**
 * Coerce a parsed score into the legal 0..10 range. NaN (parse failure)
 * collapses to 0 so a single garbled line can't poison aggregation.
 */
function clampScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(10, value));
}
